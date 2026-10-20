/**
 * @fileoverview Marketplace registry catalog fetcher, semver comparator,
 * and workspace trigger recommendation engine for Antigravity Hangar.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  BUILTIN_WORKSPACE_TRIGGERS,
  GLOBAL_SIDECARS_DIR,
  HANGAR_CONFIG_PATH,
  HANGAR_VERSION,
  RESERVED_SIDECAR_IDS,
  SEED_REGISTRY,
  SIDECAR_ID,
} from './constants.mjs';
import { isTelemetryEnabled, loadHangarConfig, readJsonSafe } from './config-store.mjs';

export function isNewerSemver(installed = '', latest = '') {
  if (!latest) return false;
  if (!installed) return true;
  const parse = (v) =>
    String(v)
      .replace(/^v/i, '')
      .split('-')[0]
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0);
  const a = parse(installed);
  const b = parse(latest);
  const len = Math.max(a.length, b.length, 3);
  for (let i = 0; i < len; i++) {
    const av = a[i] || 0;
    const bv = b[i] || 0;
    if (bv > av) return true;
    if (bv < av) return false;
  }
  return false;
}

export function extractGitHubRepoSpec(rawInput = '') {
  const raw =
    typeof rawInput === 'object' && rawInput !== null
      ? String(rawInput.url || '')
      : String(rawInput || '');
  const clean = raw
    .trim()
    .replace(/^git\+/i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  if (!clean) return { owner: '', repo: '', gitRepo: '' };

  const ghPrefix = clean.match(/^github:([a-z0-9_.-]+)\/([a-z0-9_.-]+)$/i);
  if (ghPrefix) {
    return {
      owner: ghPrefix[1],
      repo: ghPrefix[2],
      gitRepo: `https://github.com/${ghPrefix[1]}/${ghPrefix[2]}`,
    };
  }
  const urlMatch = clean.match(/github\.com[:/]([a-z0-9_.-]+)\/([a-z0-9_.-]+?)(?:@[a-z0-9_.-]+)?$/i);
  if (urlMatch) {
    return {
      owner: urlMatch[1],
      repo: urlMatch[2],
      gitRepo: `https://github.com/${urlMatch[1]}/${urlMatch[2]}`,
    };
  }
  const shortMatch = clean.match(/^([a-z0-9_.-]+)\/([a-z0-9_.-]+?)(?:@[a-z0-9_.-]+)?$/i);
  if (shortMatch) {
    return {
      owner: shortMatch[1],
      repo: shortMatch[2],
      gitRepo: `https://github.com/${shortMatch[1]}/${shortMatch[2]}`,
    };
  }
  return { owner: '', repo: '', gitRepo: '' };
}

export function readInstalledSidecarVersion(sidecarId, sidecarsDir = GLOBAL_SIDECARS_DIR) {
  if (!sidecarId || sidecarId.includes('/') || !sidecarsDir) return '';
  const dir = join(sidecarsDir, sidecarId);
  if (!existsSync(dir)) return '';
  return (
    readJsonSafe(join(dir, 'package.json'), {})?.version ||
    readJsonSafe(join(dir, 'hub-manifest.json'), {})?.version ||
    readJsonSafe(join(dir, 'sidecar.json'), {})?.version ||
    ''
  );
}

export function readInstalledSidecarMetadata(
  sidecarId,
  sidecarsDir = GLOBAL_SIDECARS_DIR,
  localRule = {}
) {
  if (!sidecarId || sidecarId.includes('/') || !sidecarsDir) {
    return {
      version: localRule?.installedVersion || '',
      npmPackage: '',
      gitRepo: localRule?.gitRepo || '',
      tarballUrl: localRule?.tarballUrl || '',
    };
  }
  const dir = join(sidecarsDir, sidecarId);
  if (!existsSync(dir)) {
    return {
      version: localRule?.installedVersion || '',
      npmPackage: '',
      gitRepo: localRule?.gitRepo || '',
      tarballUrl: localRule?.tarballUrl || '',
    };
  }
  const pkgJson = readJsonSafe(join(dir, 'package.json'), {});
  const hubManifest = readJsonSafe(join(dir, 'hub-manifest.json'), {});
  const sidecarJson = readJsonSafe(join(dir, 'sidecar.json'), {});

  const version =
    pkgJson?.version ||
    hubManifest?.version ||
    sidecarJson?.version ||
    localRule?.installedVersion ||
    '';
  const npmPackage = !pkgJson?.private && pkgJson?.name ? String(pkgJson.name).trim() : '';
  const repoSpec = extractGitHubRepoSpec(
    localRule?.gitRepo || hubManifest?.release?.gitRepo || pkgJson?.repository || ''
  );

  return {
    version,
    npmPackage,
    gitRepo: repoSpec.gitRepo || localRule?.gitRepo || hubManifest?.release?.gitRepo || '',
    tarballUrl: localRule?.tarballUrl || hubManifest?.release?.tarballUrl || '',
  };
}

export function readInstalledHangarVersion(sidecarsDir = GLOBAL_SIDECARS_DIR) {
  const diskVer = sidecarsDir ? readInstalledSidecarVersion(SIDECAR_ID, sidecarsDir) : '';
  if (sidecarsDir && sidecarsDir !== GLOBAL_SIDECARS_DIR && diskVer) {
    return diskVer;
  }
  if (diskVer && isNewerSemver(HANGAR_VERSION, diskVer)) {
    return diskVer;
  }
  return HANGAR_VERSION;
}

export async function probeUpstreamVersion({
  npmPackage = '',
  gitRepo = '',
  currentVersion = '',
  fetchFn = globalThis.fetch,
  timeoutMs = 2000,
} = {}) {
  let latestVersion = String(currentVersion || '');
  let tarballUrl = '';
  const { owner, repo, gitRepo: cleanGitRepo } = extractGitHubRepoSpec(gitRepo);
  if (typeof fetchFn !== 'function') {
    return { latestVersion, gitRepo: cleanGitRepo || gitRepo, tarballUrl };
  }

  const tasks = [];
  if (npmPackage) {
    tasks.push(
      (async () => {
        try {
          const res = await fetchFn(
            `https://registry.npmjs.org/${encodeURIComponent(npmPackage)}/latest`,
            { signal: AbortSignal.timeout(timeoutMs) }
          );
          if (res?.ok) {
            const json = await res.json();
            return {
              source: 'npm',
              version: String(json?.version || ''),
              tarball: String(json?.dist?.tarball || ''),
            };
          }
        } catch {
          // Ignore upstream npm error
        }
        return null;
      })()
    );
  }

  if (owner && repo) {
    tasks.push(
      (async () => {
        for (const manifestFile of ['package.json', 'sidecar.json']) {
          try {
            const res = await fetchFn(
              `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${manifestFile}`,
              { signal: AbortSignal.timeout(timeoutMs) }
            );
            if (res?.ok) {
              const json = await res.json();
              if (json?.version) {
                return { source: 'github', version: String(json.version), tarball: '' };
              }
            }
          } catch {
            // Ignore upstream GitHub error
          }
        }
        return null;
      })()
    );
  }

  const results = await Promise.all(tasks);
  for (const r of results) {
    if (!r?.version) continue;
    if (isNewerSemver(latestVersion, r.version)) {
      latestVersion = r.version;
      if (r.tarball) tarballUrl = r.tarball;
    } else if (r.version === latestVersion && r.tarball && !tarballUrl) {
      tarballUrl = r.tarball;
    }
  }

  return {
    latestVersion,
    gitRepo: cleanGitRepo || gitRepo,
    tarballUrl,
  };
}

export function buildRegistryHeaders(hangarCfg = {}, { env = process.env, platform = process.platform } = {}) {
  if (!isTelemetryEnabled(hangarCfg, env)) return {};
  const headers = {
    'X-Hangar-Version': HANGAR_VERSION,
    'X-Hangar-OS': String(platform || 'unknown'),
    'X-Hangar-Sidecars': String(Object.keys(hangarCfg?.sidecars || {}).length),
  };
  if (hangarCfg?.installId) {
    headers['X-Hangar-Install-Id'] = String(hangarCfg.installId);
  }
  return headers;
}

const DEFAULT_HANGAR_META = SEED_REGISTRY.hangar || {
  id: SIDECAR_ID,
  name: 'Antigravity Hangar',
  npmPackage: 'antigravity-hangar',
  latestVersion: HANGAR_VERSION,
  release: { gitRepo: 'https://github.com/arthurcavallari/antigravity-hangar' },
};

let lastCachedRegistryPackages = SEED_REGISTRY.packages;
let lastCachedSidecarUpdates = new Map();
let lastCachedHangarMeta = {
  id: SIDECAR_ID,
  name: DEFAULT_HANGAR_META.name,
  npmPackage: DEFAULT_HANGAR_META.npmPackage,
  latestVersion: DEFAULT_HANGAR_META.latestVersion || HANGAR_VERSION,
  gitRepo: DEFAULT_HANGAR_META.release?.gitRepo || 'https://github.com/arthurcavallari/antigravity-hangar',
  tarballUrl: DEFAULT_HANGAR_META.release?.tarballUrl || '',
};

export function getCachedHangarUpdate(sidecarsDir = GLOBAL_SIDECARS_DIR) {
  const installedVersion = readInstalledHangarVersion(sidecarsDir);
  const latestVersion = isNewerSemver(installedVersion, lastCachedHangarMeta.latestVersion)
    ? lastCachedHangarMeta.latestVersion
    : installedVersion;
  return {
    id: SIDECAR_ID,
    name: lastCachedHangarMeta.name || 'Antigravity Hangar',
    installedVersion,
    latestVersion,
    updateAvailable: isNewerSemver(installedVersion, latestVersion),
    gitRepo: lastCachedHangarMeta.gitRepo,
    tarballUrl: lastCachedHangarMeta.tarballUrl || '',
  };
}

export function getCachedSidecarUpdate(sidecarId, installedVersion = '') {
  const entry = lastCachedSidecarUpdates.get(sidecarId);
  if (!entry) {
    const pkg = lastCachedRegistryPackages.find((p) => p.id === sidecarId);
    if (!pkg) return null;
    const effInstalled = installedVersion || pkg.installedVersion || '1.0.0';
    return {
      latestVersion: pkg.latestVersion || effInstalled,
      updateAvailable: isNewerSemver(effInstalled, pkg.latestVersion),
      gitRepo: pkg.release?.gitRepo || '',
      tarballUrl: pkg.release?.tarballUrl || '',
    };
  }
  const effInstalled = installedVersion || entry.installedVersion || '1.0.0';
  return {
    latestVersion: entry.latestVersion || effInstalled,
    updateAvailable: isNewerSemver(effInstalled, entry.latestVersion),
    gitRepo: entry.gitRepo || '',
    tarballUrl: entry.tarballUrl || '',
  };
}

export async function fetchRegistry({
  configPath = HANGAR_CONFIG_PATH,
  sidecarsDir = GLOBAL_SIDECARS_DIR,
  fetchFn = globalThis.fetch,
  env = process.env,
  platform = process.platform,
  probeUpstream,
} = {}) {
  const hangarCfg = loadHangarConfig(configPath);
  const baseUrl = String(hangarCfg.registryUrl || SEED_REGISTRY.registryUrl || '')
    .trim()
    .replace(/\/registry\.json\/?$/i, '')
    .replace(/\/+$/, '');
  const headers = buildRegistryHeaders(hangarCfg, { env, platform });
  let remotePackages = [];
  let remoteHangar = null;
  if (baseUrl && typeof fetchFn === 'function') {
    try {
      const fetchOpts = { signal: AbortSignal.timeout(2000) };
      if (Object.keys(headers).length > 0) {
        fetchOpts.headers = headers;
      }
      const res = await fetchFn(`${baseUrl}/registry.json`, fetchOpts);
      if (res?.ok) {
        const json = await res.json();
        if (Array.isArray(json?.packages)) remotePackages = json.packages;
        if (json?.hangar && typeof json.hangar === 'object') remoteHangar = json.hangar;
      }
    } catch {
      // Fallback to SEED_REGISTRY when offline or unreachable
    }
  }

  const shouldProbe = probeUpstream ?? (fetchFn === globalThis.fetch);

  // 1. Resolve Hangar self-update metadata
  const installedHangarVer = readInstalledHangarVersion(sidecarsDir);
  let latestHangarVer = DEFAULT_HANGAR_META.latestVersion || HANGAR_VERSION;
  if (remoteHangar?.latestVersion && isNewerSemver(latestHangarVer, remoteHangar.latestVersion)) {
    latestHangarVer = remoteHangar.latestVersion;
  }
  let hangarGitRepo =
    remoteHangar?.release?.gitRepo ||
    DEFAULT_HANGAR_META.release?.gitRepo ||
    'https://github.com/arthurcavallari/antigravity-hangar';
  let hangarTarballUrl =
    remoteHangar?.release?.tarballUrl || DEFAULT_HANGAR_META.release?.tarballUrl || '';
  const hangarNpmPkg = remoteHangar?.npmPackage || DEFAULT_HANGAR_META.npmPackage || 'antigravity-hangar';

  if (shouldProbe) {
    const probedHangar = await probeUpstreamVersion({
      npmPackage: hangarNpmPkg,
      gitRepo: hangarGitRepo,
      currentVersion: latestHangarVer,
      fetchFn,
    });
    if (isNewerSemver(latestHangarVer, probedHangar.latestVersion)) {
      latestHangarVer = probedHangar.latestVersion;
    }
    if (probedHangar.tarballUrl) hangarTarballUrl = probedHangar.tarballUrl;
  }

  lastCachedHangarMeta = {
    id: SIDECAR_ID,
    name: remoteHangar?.name || DEFAULT_HANGAR_META.name || 'Antigravity Hangar',
    npmPackage: hangarNpmPkg,
    latestVersion: latestHangarVer,
    gitRepo: hangarGitRepo,
    tarballUrl: hangarTarballUrl,
  };
  const hangarUpdate = getCachedHangarUpdate(sidecarsDir);

  // 2. Merge catalog packages & probe upstream versions
  const mergedMap = new Map();
  for (const pkg of SEED_REGISTRY.packages) mergedMap.set(pkg.id, structuredClone(pkg));
  for (const pkg of remotePackages) {
    if (pkg?.id) {
      const seedPkg = mergedMap.get(pkg.id) || {};
      mergedMap.set(pkg.id, {
        ...seedPkg,
        ...pkg,
        release: { ...(seedPkg.release || {}), ...(pkg.release || {}) },
      });
    }
  }

  const nextSidecarUpdates = new Map();

  const packages = await Promise.all(
    [...mergedMap.values()].map(async (pkg) => {
      const localRule = hangarCfg.sidecars?.[pkg.id];
      const manifestOnDisk = sidecarsDir
        ? existsSync(join(sidecarsDir, pkg.id, 'sidecar.json'))
        : Boolean(localRule);
      const isInstalled = Boolean(manifestOnDisk);
      const diskMeta = isInstalled
        ? readInstalledSidecarMetadata(pkg.id, sidecarsDir, localRule)
        : { version: '', npmPackage: '', gitRepo: '', tarballUrl: '' };
      const installedVersion = isInstalled
        ? diskMeta.version || localRule?.installedVersion || '1.0.0'
        : '';

      let latestVersion = pkg.latestVersion || installedVersion || '1.0.0';
      let gitRepo = pkg.release?.gitRepo || diskMeta.gitRepo || localRule?.gitRepo || '';
      let tarballUrl = pkg.release?.tarballUrl || diskMeta.tarballUrl || localRule?.tarballUrl || '';
      const npmPackage = pkg.npmPackage || diskMeta.npmPackage || '';

      if (shouldProbe && (npmPackage || gitRepo)) {
        const probed = await probeUpstreamVersion({
          npmPackage,
          gitRepo,
          currentVersion: latestVersion,
          fetchFn,
        });
        if (isNewerSemver(latestVersion, probed.latestVersion)) {
          latestVersion = probed.latestVersion;
        }
        if (!tarballUrl && probed.tarballUrl) tarballUrl = probed.tarballUrl;
      }

      const updateAvailable = isInstalled && isNewerSemver(installedVersion, latestVersion);
      const enrichedPkg = {
        ...pkg,
        latestVersion,
        release: {
          ...(pkg.release || {}),
          ...(gitRepo ? { gitRepo } : {}),
          ...(tarballUrl ? { tarballUrl } : {}),
        },
        isInstalled,
        installedVersion,
        updateAvailable,
      };
      nextSidecarUpdates.set(pkg.id, {
        installedVersion,
        latestVersion,
        updateAvailable,
        gitRepo,
        tarballUrl,
      });
      return enrichedPkg;
    })
  );

  // 3. Also check non-catalog installed sidecars (e.g., GitHub-sideloaded or npm-installed)
  if (shouldProbe) {
    const extraIds = new Set(Object.keys(hangarCfg.sidecars || {}));
    if (sidecarsDir && existsSync(sidecarsDir)) {
      try {
        for (const entry of readdirSync(sidecarsDir)) {
          if (existsSync(join(sidecarsDir, entry, 'sidecar.json'))) extraIds.add(entry);
        }
      } catch {
        // Ignore unreadable directory
      }
    }
    const nonCatalogIds = [...extraIds].filter(
      (id) => id && !RESERVED_SIDECAR_IDS.has(id) && !id.includes('/') && !mergedMap.has(id)
    );
    await Promise.all(
      nonCatalogIds.map(async (id) => {
        const localRule = hangarCfg.sidecars?.[id] || {};
        const diskMeta = readInstalledSidecarMetadata(id, sidecarsDir, localRule);
        const installedVersion = diskMeta.version || localRule.installedVersion || '1.0.0';
        const npmPackage = diskMeta.npmPackage || '';
        const gitRepo = diskMeta.gitRepo || localRule.gitRepo || '';
        if (!npmPackage && !gitRepo) return;

        const probed = await probeUpstreamVersion({
          npmPackage,
          gitRepo,
          currentVersion: installedVersion,
          fetchFn,
        });
        nextSidecarUpdates.set(id, {
          installedVersion,
          latestVersion: probed.latestVersion || installedVersion,
          updateAvailable: isNewerSemver(installedVersion, probed.latestVersion),
          gitRepo: probed.gitRepo || gitRepo,
          tarballUrl: probed.tarballUrl || diskMeta.tarballUrl || '',
        });
      })
    );
  }

  lastCachedRegistryPackages = packages;
  lastCachedSidecarUpdates = nextSidecarUpdates;

  return {
    generatedAt: new Date().toISOString(),
    featuredIds: SEED_REGISTRY.featuredIds,
    hangar: hangarUpdate,
    packages,
    sidecarUpdates: Object.fromEntries(nextSidecarUpdates),
  };
}

export function detectWorkspaceSuggestions({
  activeWorkspacePath = '',
  sidecars = [],
  registryPackages = lastCachedRegistryPackages,
  builtinTriggers = BUILTIN_WORKSPACE_TRIGGERS,
} = {}) {
  if (!activeWorkspacePath || !existsSync(activeWorkspacePath)) return [];
  const sidecarMap = new Map((sidecars || []).map((s) => [s.sidecarId, s]));
  const suggestions = [];
  const seenIds = new Set();

  const findTriggerFile = (files = []) =>
    files.find((relFile) => {
      try {
        return relFile !== '*' && existsSync(join(activeWorkspacePath, relFile));
      } catch {
        return false;
      }
    });

  for (const pkg of registryPackages || []) {
    const triggers = pkg?.workspaceTriggers?.files || [];
    if (triggers.length === 0 || triggers.includes('*')) continue;
    const matchedFile = findTriggerFile(triggers);
    if (!matchedFile) continue;

    seenIds.add(pkg.id);
    const installed = sidecarMap.get(pkg.id);
    if (installed) {
      if (!installed.matchesWorkspace || !installed.isRunning) {
        suggestions.push({
          sidecarId: pkg.id,
          name: installed.displayName || pkg.name,
          reason: `Detected ${matchedFile}`,
          actionType: 'enable',
        });
      }
    } else {
      suggestions.push({
        sidecarId: pkg.id,
        name: pkg.name,
        reason: `Detected ${matchedFile}`,
        actionType: 'install',
        gitRepo: pkg.release?.gitRepo || '',
        tarballUrl: pkg.release?.tarballUrl || '',
        version: pkg.latestVersion || '1.0.0',
      });
    }
  }

  for (const [id, spec] of Object.entries(builtinTriggers || {})) {
    if (seenIds.has(id)) continue;
    const installed = sidecarMap.get(id);
    if (!installed || (installed.matchesWorkspace && installed.isRunning)) continue;
    const matchedFile = findTriggerFile(spec.files || []);
    if (matchedFile) {
      suggestions.push({
        sidecarId: id,
        name: installed.displayName || spec.name || id,
        reason: `Detected ${matchedFile}`,
        actionType: 'enable',
      });
    }
  }

  return suggestions;
}
