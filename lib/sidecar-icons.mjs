/**
 * @fileoverview Discovers and safely serves custom icons/logos for standalone and plugin-bundled sidecars.
 */

import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJsonSafe } from 'antigravity-sidecar-kit/config';
import { normalizeWorkspacePath } from 'antigravity-sidecar-kit/workspace';
import {
  GLOBAL_BUILTIN_PLUGINS_DIR,
  GLOBAL_PLUGINS_DIR,
  GLOBAL_SIDECARS_DIR,
  RESERVED_SIDECAR_IDS,
} from './constants.mjs';
import { assertValidSidecarId, discoverPluginSidecarEntries } from './config-store.mjs';
import { hangarRpc } from './ls-rpc.mjs';
import { resolveEffectivePluginRoot } from './plugin-diagnostics.mjs';

const MAX_ICON_BYTES = 2 * 1024 * 1024;
const ICON_CACHE_TTL_MS = 5_000;
const iconInfoCache = new Map();

const IMAGE_MIME_BY_EXT = Object.freeze({
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
});

const CONVENTIONAL_ICON_RELS = Object.freeze([
  'assets/logo.svg',
  'assets/logo.png',
  'assets/icon.svg',
  'assets/icon.png',
  'logo.svg',
  'logo.png',
  'icon.svg',
  'icon.png',
]);

const PLUGIN_MANIFEST_RELS = Object.freeze([
  'plugin.json',
  join('.antigravity-plugin', 'plugin.json'),
  join('.gemini-plugin', 'plugin.json'),
]);

class DefaultIconResponse {
  constructor(body, { contentType = 'text/plain; charset=utf-8', status = 200, headers = {} } = {}) {
    this.body = body;
    this.contentType = contentType;
    this.status = status;
    this.headers = headers;
  }
}

function toFsDir(rawPath = '') {
  const str = String(rawPath || '').trim();
  if (!str) return '';
  if (/^file:\/\//i.test(str)) {
    try {
      return fileURLToPath(str);
    } catch {
      return normalizeWorkspacePath(str) || '';
    }
  }
  return str;
}

function sanitizeHttpsIconUrl(raw = '') {
  const s = String(raw || '').trim();
  return /^https:\/\/[^\s"'<>]+$/i.test(s) ? s : '';
}

function isFileLikeSpec(raw = '') {
  const s = String(raw || '').trim();
  if (!s) return false;
  if (/^https?:\/\//i.test(s)) return true;
  if (s.includes('/') || s.includes('\\') || s.startsWith('.')) return true;
  const ext = extname(s).toLowerCase();
  return Boolean(IMAGE_MIME_BY_EXT[ext]);
}

function resolveContainedIconFile(rootDir, relSpec) {
  if (!rootDir || !relSpec) return null;
  const raw = String(relSpec || '').trim();
  if (!raw || raw.includes('\0') || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return null;
  let canonicalRoot = '';
  try {
    canonicalRoot = realpathSync(resolve(rootDir));
  } catch {
    return null;
  }
  const cleaned = raw.replace(/^[/\\]+/, '');
  if (!cleaned) return null;
  const candidate = resolve(canonicalRoot, cleaned);
  if (!candidate.startsWith(canonicalRoot + sep)) return null;
  let st;
  try {
    st = lstatSync(candidate);
  } catch {
    return null;
  }
  if (st.isSymbolicLink() || !st.isFile() || st.size <= 0 || st.size > MAX_ICON_BYTES) {
    return null;
  }
  let realTarget = '';
  try {
    realTarget = realpathSync(candidate);
  } catch {
    return null;
  }
  if (!realTarget.startsWith(canonicalRoot + sep)) return null;
  const contentType = IMAGE_MIME_BY_EXT[extname(realTarget).toLowerCase()];
  if (!contentType) return null;
  return { kind: 'file', filePath: realTarget, contentType };
}

function extractManifestIconSpecs(manifest) {
  if (!manifest || typeof manifest !== 'object') return [];
  const uiCfg = manifest.uiConfig || manifest.ui_config;
  return [uiCfg?.logo, uiCfg?.icon, manifest.logo, manifest.icon]
    .filter((v) => typeof v === 'string' && v.trim())
    .map((v) => v.trim());
}

function resolveFromManifestSpecs(specs, roots) {
  for (const spec of specs) {
    const httpsUrl = sanitizeHttpsIconUrl(spec);
    if (httpsUrl) return { kind: 'https', url: httpsUrl };
    if (!isFileLikeSpec(spec)) continue;
    for (const root of roots) {
      const hit = resolveContainedIconFile(root, spec);
      if (hit) return hit;
    }
    return { kind: 'invalid' };
  }
  return null;
}

export function resolveSidecarIconInfo(
  entry,
  {
    sidecarsDir = GLOBAL_SIDECARS_DIR,
    pluginsDir = GLOBAL_PLUGINS_DIR,
    builtinPluginsDir = GLOBAL_BUILTIN_PLUGINS_DIR,
  } = {}
) {
  const id = String(entry?.sidecarId || entry?.id || '').trim();
  if (!id || RESERVED_SIDECAR_IDS.has(id)) return null;
  const parentPluginId = String(
    entry?.parentPluginId || (id.includes('/') ? id.split('/')[0] : '')
  ).trim();
  const rawSidecarDir = toFsDir(entry?.sidecarDir) || (!id.includes('/') && sidecarsDir ? join(sidecarsDir, id) : '');
  const sidecarDir = rawSidecarDir && existsSync(rawSidecarDir) ? rawSidecarDir : '';

  const candidatePluginDirs = [
    toFsDir(entry?.pluginPath),
    parentPluginId && pluginsDir ? join(pluginsDir, parentPluginId) : '',
    parentPluginId && builtinPluginsDir ? join(builtinPluginsDir, parentPluginId) : '',
  ].filter(Boolean);
  const foundPluginDir = candidatePluginDirs.find((d) => existsSync(d)) || '';
  const pluginRoot = foundPluginDir ? resolveEffectivePluginRoot(foundPluginDir) : '';

  const cacheKey = `${id}\0${sidecarDir}\0${pluginRoot}\0${entry?.config?.logo || ''}\0${entry?.config?.icon || ''}`;
  const now = Date.now();
  const cached = iconInfoCache.get(cacheKey);
  if (cached && now - cached.ts < ICON_CACHE_TTL_MS) {
    return cached.info;
  }

  const compute = () => {
    const sidecarManifest = sidecarDir ? readJsonSafe(join(sidecarDir, 'sidecar.json'), null) : null;
    const hubManifest = sidecarDir ? readJsonSafe(join(sidecarDir, 'hub-manifest.json'), null) : null;
    const sidecarSpecs = [
      ...extractManifestIconSpecs(entry?.config),
      ...extractManifestIconSpecs(hubManifest),
      ...extractManifestIconSpecs(sidecarManifest),
    ];
    const sidecarRoots = [sidecarDir, pluginRoot].filter(Boolean);
    const explicitSidecarHit = resolveFromManifestSpecs(sidecarSpecs, sidecarRoots);
    if (explicitSidecarHit) {
      return explicitSidecarHit.kind === 'invalid' ? null : explicitSidecarHit;
    }

    if (sidecarDir) {
      for (const rel of CONVENTIONAL_ICON_RELS) {
        const hit = resolveContainedIconFile(sidecarDir, rel);
        if (hit) return hit;
      }
    }

    if (pluginRoot) {
      for (const manifestRel of PLUGIN_MANIFEST_RELS) {
        const pJson = readJsonSafe(join(pluginRoot, manifestRel), null);
        if (!pJson || typeof pJson !== 'object') continue;
        const pluginHit = resolveFromManifestSpecs(extractManifestIconSpecs(pJson), [pluginRoot]);
        if (pluginHit) {
          return pluginHit.kind === 'invalid' ? null : pluginHit;
        }
      }
      for (const rel of CONVENTIONAL_ICON_RELS) {
        const hit = resolveContainedIconFile(pluginRoot, rel);
        if (hit) return hit;
      }
    }

    return null;
  };

  const info = compute();
  if (iconInfoCache.size >= 256) iconInfoCache.clear();
  iconInfoCache.set(cacheKey, { ts: now, info });
  return info;
}

export function resolveSidecarIconUrl(entry, opts = {}) {
  const info = resolveSidecarIconInfo(entry, opts);
  if (!info) return '';
  if (info.kind === 'https') return info.url;
  const id = String(entry?.sidecarId || entry?.id || '').trim();
  return info.kind === 'file' && id ? `/api/sidecar/icon?id=${encodeURIComponent(id)}` : '';
}

export async function serveSidecarIcon(
  rawSidecarId,
  {
    sidecarsDir = GLOBAL_SIDECARS_DIR,
    pluginsDir = GLOBAL_PLUGINS_DIR,
    builtinPluginsDir = GLOBAL_BUILTIN_PLUGINS_DIR,
    rpcFn = hangarRpc,
    ResponseClass = DefaultIconResponse,
  } = {}
) {
  const id = String(rawSidecarId || '').trim();
  try {
    assertValidSidecarId(id);
  } catch {
    return new ResponseClass('Invalid sidecarId', { status: 400, contentType: 'text/plain; charset=utf-8' });
  }
  if (RESERVED_SIDECAR_IDS.has(id)) {
    return new ResponseClass('Not Found', { status: 404, contentType: 'text/plain; charset=utf-8' });
  }

  const iconOpts = { sidecarsDir, pluginsDir, builtinPluginsDir };
  let entry = { sidecarId: id };
  if (id.includes('/')) {
    const parentPluginId = id.split('/')[0];
    for (const baseDir of [pluginsDir, builtinPluginsDir].filter(Boolean)) {
      const pDir = join(baseDir, parentPluginId);
      if (!existsSync(pDir)) continue;
      const found = discoverPluginSidecarEntries(resolveEffectivePluginRoot(pDir), parentPluginId)
        .find((c) => c.id === id);
      if (found) {
        entry = { ...found, sidecarId: found.id, pluginPath: pDir };
        break;
      }
    }
  }

  let info = resolveSidecarIconInfo(entry, iconOpts);
  if (!info && typeof rpcFn === 'function') {
    const [sidecarsRes, pluginsRes] = await Promise.all([
      rpcFn('GetSidecars', {}).catch(() => null),
      rpcFn('GetAllPlugins', {}).catch(() => null),
    ]);
    const liveSidecar = (sidecarsRes?.sidecars || []).find((s) => (s.sidecarId || s.id) === id);
    const parentId = liveSidecar?.parentPluginId || (id.includes('/') ? id.split('/')[0] : id);
    const livePlugin = (pluginsRes?.plugins || []).find((p) => String(p?.name || '') === parentId);
    if (liveSidecar || livePlugin) {
      info = resolveSidecarIconInfo(
        {
          ...liveSidecar,
          sidecarId: id,
          parentPluginId: parentId,
          pluginPath: liveSidecar?.pluginPath || livePlugin?.path || '',
        },
        iconOpts
      );
    }
  }

  if (!info || info.kind !== 'file') {
    return new ResponseClass('Not Found', { status: 404, contentType: 'text/plain; charset=utf-8' });
  }
  try {
    const body = readFileSync(info.filePath);
    return new ResponseClass(body, {
      status: 200,
      contentType: info.contentType,
      headers: {
        'Cache-Control': 'private, max-age=300',
        'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    return new ResponseClass('Not Found', { status: 404, contentType: 'text/plain; charset=utf-8' });
  }
}
