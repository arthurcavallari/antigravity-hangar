/**
 * @fileoverview Package installer, local folder linker, capability tier inspector,
 * and uninstaller for Antigravity Hangar.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { readJsonSafe, updateAgySidecarConfig } from 'antigravity-sidecar-kit/config';
import { callLsRpc } from 'antigravity-sidecar-kit/rpc';
import { createSidecarLink, KIT_ROOT, removeLinkOrDir } from 'antigravity-sidecar-kit/setup';
import {
  CONFIG_JSON_PATH, GLOBAL_SIDECARS_DIR, HANGAR_CONFIG_PATH,
  HANGAR_PACKAGES_DIR, RESERVED_SIDECAR_IDS,
} from './constants.mjs';
import {
  loadHangarConfig, saveHangarConfig, updateSidecarRule,
} from './config-store.mjs';

export { createSidecarLink, removeLinkOrDir };

export const TRUSTED_FIRST_PARTY_SDKS = new Set(['antigravity-sidecar-kit', 'sidecar_sdk']);

export function sanitizeSidecarId(raw = '') {
  return String(raw || '').trim().toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '');
}

function scanRuntimeSourceCapabilities(dirPath) {
  let hasChildProcess = false;
  let hasAgentControl = false;
  const skipDirs = new Set(['node_modules', '.git', 'test', 'tests', '.idea', 'dist']);

  function walk(currentDir, depth = 0) {
    if (depth > 5 || !existsSync(currentDir)) return;
    let entries = [];
    try { entries = readdirSync(currentDir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) walk(join(currentDir, entry.name), depth + 1);
        continue;
      }
      if (!entry.isFile() || entry.name === 'setup.mjs' || !/\.(m?js|cjs)$/.test(entry.name)) continue;
      try {
        const src = readFileSync(join(currentDir, entry.name), 'utf8');
        if (/node:child_process|['"]child_process['"]/.test(src)) hasChildProcess = true;
        if (/StartCascade|SendUserCascadeMessage|sidecar\.agent\.(sendMessage|startConversation)/.test(src)) {
          hasAgentControl = true;
        }
      } catch { /* ignore unreadable file */ }
    }
  }

  walk(dirPath, 0);
  return { hasChildProcess, hasAgentControl };
}

export function inspectSidecarDirectory(dirPath) {
  if (!dirPath) throw new Error('Folder path is required');
  const resolved = resolve(String(dirPath).trim());
  if (!existsSync(resolved)) throw new Error(`Directory does not exist: ${resolved}`);
  const sidecarJsonPath = join(resolved, 'sidecar.json');
  if (!existsSync(sidecarJsonPath)) throw new Error(`Missing sidecar.json in ${resolved}`);
  const sidecarJson = readJsonSafe(sidecarJsonPath, null);
  if (!sidecarJson || typeof sidecarJson !== 'object' || !sidecarJson.command) {
    throw new Error(`Invalid sidecar.json in ${resolved}: "command" is required`);
  }

  const hubManifest = readJsonSafe(join(resolved, 'hub-manifest.json'), {});
  const pkgJson = readJsonSafe(join(resolved, 'package.json'), {});
  const scripts = pkgJson?.scripts || {};
  const hasLifecycleScripts = Boolean(scripts.preinstall || scripts.install || scripts.postinstall);
  const depKeys = Object.keys(pkgJson?.dependencies || {});
  const dependenciesCount = depKeys.length;
  const externalDependencies = depKeys.filter((d) => !TRUSTED_FIRST_PARTY_SDKS.has(d)).length;
  const { hasChildProcess, hasAgentControl } = scanRuntimeSourceCapabilities(resolved);

  let capabilityTier = 'TIER_1_TELEMETRY';
  if (hasAgentControl || hubManifest.capabilityTier === 'TIER_3_AGENT_CONTROL') {
    capabilityTier = 'TIER_3_AGENT_CONTROL';
  } else if (hasChildProcess || hubManifest.capabilityTier === 'TIER_2_LOCAL_TOOLING') {
    capabilityTier = 'TIER_2_LOCAL_TOOLING';
  }

  const rawInferred = hubManifest.id || pkgJson.name || basename(resolved).replace(/@.*$/, '');
  const inferredId = sanitizeSidecarId(String(rawInferred).replace(/^antigravity-sidecar-|^antigravity-|^agy-/i, ''));

  return {
    id: inferredId,
    displayName: hubManifest.name || sidecarJson.ui_config?.display_name || sidecarJson.display_name || inferredId,
    description: hubManifest.tagline || sidecarJson.description || '',
    version: hubManifest.version || pkgJson.version || sidecarJson.version || '1.0.0',
    capabilityTier,
    hasLifecycleScripts,
    dependenciesCount,
    externalDependencies,
    resolvedPath: resolved,
    workspaceTriggers: hubManifest.workspaceTriggers || { files: [] },
  };
}

async function activateSidecarViaLs(sidecarId, rpcFn = callLsRpc, delayMs = 250) {
  try {
    await rpcFn('ManageSidecar', { action: 'SIDECAR_ACTION_RESTART', sidecarId });
    return { activated: true, method: 'restart' };
  } catch {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    try {
      await rpcFn('ManageSidecar', { action: 'SIDECAR_ACTION_ENABLE', sidecarId });
      return { activated: true, method: 'enable' };
    } catch (err) {
      return { activated: false, reason: err.message };
    }
  }
}

export async function linkLocalSidecar({
  folderPath, sidecarId = '', scope = 'project', workspaces = [], source = 'local',
  sidecarsDir = GLOBAL_SIDECARS_DIR, configPath = HANGAR_CONFIG_PATH,
  agyConfigPath = CONFIG_JSON_PATH, rpcFn = callLsRpc, delayMs = 250,
} = {}) {
  const inspection = inspectSidecarDirectory(folderPath);
  const id = sanitizeSidecarId(sidecarId || inspection.id);
  if (!id || RESERVED_SIDECAR_IDS.has(id)) throw new Error(`Invalid or reserved sidecarId: "${id}"`);

  createSidecarLink(inspection.resolvedPath, join(sidecarsDir, id));
  updateAgySidecarConfig(id, true, agyConfigPath, { createIfMissing: false });

  const effectiveWorkspaces =
    scope === 'global' ? ['*'] : Array.isArray(workspaces) && workspaces.length > 0 ? workspaces : ['*'];
  const effectiveScope = effectiveWorkspaces.includes('*') ? 'global' : scope;

  const rule = updateSidecarRule(
    id,
    { scope: effectiveScope, workspaces: effectiveWorkspaces, installedVersion: inspection.version, source },
    { configPath, sidecarsDir }
  );
  const activation = await activateSidecarViaLs(id, rpcFn, delayMs);
  return { ok: true, sidecarId: id, inspection, rule, activation };
}

export function parseGitRepoSpec(rawRepo = '') {
  let raw = String(rawRepo || '').trim();
  let gitRef = '';
  if (!raw.startsWith('git@')) {
    const atIdx = raw.lastIndexOf('@');
    if (atIdx > 0 && !raw.slice(atIdx).includes('/')) {
      gitRef = raw.slice(atIdx + 1).trim();
      raw = raw.slice(0, atIdx).trim();
    }
  }
  if (raw && !/^https?:\/\/|^git@/i.test(raw) && /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(raw)) {
    raw = `https://github.com/${raw}.git`;
  }
  return { repoUrl: raw, gitRef };
}

export async function installRemoteSidecar({
  sidecarId = '', gitRepo = '', tarballUrl = '', version = 'latest', sha256 = '',
  scope = 'project', workspaces = [], packagesDir = HANGAR_PACKAGES_DIR,
  sidecarsDir = GLOBAL_SIDECARS_DIR, configPath = HANGAR_CONFIG_PATH,
  agyConfigPath = CONFIG_JSON_PATH, rpcFn = callLsRpc, fetchFn = globalThis.fetch,
  execFn = execFileSync, delayMs = 250,
} = {}) {
  const { repoUrl: cleanRepo, gitRef } = parseGitRepoSpec(gitRepo);
  if (!cleanRepo && !tarballUrl) {
    throw new Error('Either gitRepo or tarballUrl is required to install a sidecar');
  }

  const inferredFromRepo = cleanRepo
    ? basename(cleanRepo.replace(/\.git$/i, '')).replace(/^antigravity-sidecar-|^antigravity-|^agy-/, '')
    : '';
  const id = sanitizeSidecarId(sidecarId || inferredFromRepo || 'sidecar-pkg');
  const effectiveVersion = version && version !== 'latest' ? version : gitRef || 'latest';
  const cleanVer = String(effectiveVersion).replace(/[^a-z0-9._-]+/gi, '');
  const targetDir = join(packagesDir, `${id}@${cleanVer}`);

  mkdirSync(packagesDir, { recursive: true });
  removeLinkOrDir(targetDir);

  if (tarballUrl) {
    const res = await fetchFn(tarballUrl, { signal: AbortSignal.timeout(15000) });
    if (!res?.ok) throw new Error(`Failed to download tarball (${res?.status || 'network error'})`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (sha256) {
      const digest = createHash('sha256').update(buf).digest('hex');
      if (digest.toLowerCase() !== String(sha256).toLowerCase()) {
        throw new Error(`SHA-256 mismatch: expected ${sha256}, got ${digest}`);
      }
    }
    mkdirSync(targetDir, { recursive: true });
    const tgzPath = join(packagesDir, `${id}-${Date.now()}.tgz`);
    writeFileSync(tgzPath, buf);
    try {
      execFn('tar', ['-xzf', tgzPath, '-C', targetDir, '--strip-components=1'], { stdio: 'pipe' });
    } finally {
      removeLinkOrDir(tgzPath);
    }
  } else {
    const cloneArgs = ['clone', '--depth', '1'];
    if (gitRef) cloneArgs.push('--branch', gitRef);
    cloneArgs.push(cleanRepo, targetDir);
    execFn('git', cloneArgs, { stdio: 'pipe' });
  }

  const inspection = inspectSidecarDirectory(targetDir);
  if (inspection.dependenciesCount > 0) {
    try {
      const npmArgs = ['install', '--omit=dev', '--ignore-scripts'];
      const npmCli = process.platform === 'win32'
        ? join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
        : '';
      if (npmCli && existsSync(npmCli)) {
        execFn(process.execPath, [npmCli, ...npmArgs], { cwd: targetDir, stdio: 'pipe' });
      } else {
        execFn(process.platform === 'win32' ? 'npm.cmd' : 'npm', npmArgs, { cwd: targetDir, stdio: 'pipe' });
      }
    } catch (err) {
      if (inspection.externalDependencies > 0 || !existsSync(join(KIT_ROOT, 'package.json'))) throw err;
      const targetKitDir = join(targetDir, 'node_modules', 'antigravity-sidecar-kit');
      mkdirSync(join(targetDir, 'node_modules'), { recursive: true });
      cpSync(KIT_ROOT, targetKitDir, {
        recursive: true,
        filter: (src) => !/^\/(\.git|node_modules)(\/|$)/.test(src.slice(KIT_ROOT.length).replace(/\\/g, '/')),
      });
    }
  }

  const finalId = sanitizeSidecarId(sidecarId || inspection.id || id);
  return linkLocalSidecar({
    folderPath: targetDir, sidecarId: finalId, scope, workspaces,
    source: tarballUrl ? 'registry' : 'github', sidecarsDir, configPath, agyConfigPath, rpcFn, delayMs,
  });
}

export async function uninstallSidecar({
  sidecarId, packagesDir = HANGAR_PACKAGES_DIR, sidecarsDir = GLOBAL_SIDECARS_DIR,
  configPath = HANGAR_CONFIG_PATH, agyConfigPath = CONFIG_JSON_PATH, rpcFn = callLsRpc,
} = {}) {
  const id = sanitizeSidecarId(sidecarId);
  if (!id || RESERVED_SIDECAR_IDS.has(id) || String(sidecarId).includes('/')) {
    throw new Error(`Cannot uninstall protected or plugin sidecar: ${sidecarId}`);
  }

  await rpcFn('ManageSidecar', { action: 'SIDECAR_ACTION_DISABLE', sidecarId: id }).catch(() => {});
  removeLinkOrDir(join(sidecarsDir, id));

  if (existsSync(packagesDir)) {
    for (const entry of readdirSync(packagesDir)) {
      if (entry === id || entry.startsWith(`${id}@`)) removeLinkOrDir(join(packagesDir, entry));
    }
  }

  const hangarCfg = loadHangarConfig(configPath);
  delete hangarCfg.sidecars[id];
  if (Array.isArray(hangarCfg.layout?.tabOrder)) {
    hangarCfg.layout.tabOrder = hangarCfg.layout.tabOrder.filter((t) => t !== id);
  }
  if (Array.isArray(hangarCfg.layout?.topSplitTabIds)) {
    hangarCfg.layout.topSplitTabIds = hangarCfg.layout.topSplitTabIds.filter((t) => t !== id);
  }
  if (hangarCfg.layout?.pinnedTopSidecarId === id) {
    hangarCfg.layout.pinnedTopSidecarId = hangarCfg.layout.topSplitTabIds?.[0] || '';
  }
  saveHangarConfig(hangarCfg, configPath);
  updateAgySidecarConfig(id, false, agyConfigPath, { createIfMissing: false });

  return { ok: true, sidecarId: id };
}
