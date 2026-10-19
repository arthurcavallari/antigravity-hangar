/**
 * @fileoverview Marketplace registry catalog fetcher, semver comparator,
 * and workspace trigger recommendation engine for Antigravity Hangar.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  BUILTIN_WORKSPACE_TRIGGERS,
  HANGAR_CONFIG_PATH,
  SEED_REGISTRY,
} from './constants.mjs';
import { loadHangarConfig } from './config-store.mjs';

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

let lastCachedRegistryPackages = SEED_REGISTRY.packages;

export async function fetchRegistry({
  configPath = HANGAR_CONFIG_PATH,
  fetchFn = globalThis.fetch,
} = {}) {
  const hangarCfg = loadHangarConfig(configPath);
  const baseUrl = String(hangarCfg.registryUrl || SEED_REGISTRY.registryUrl || '').replace(/\/+$/, '');
  let remotePackages = [];
  if (baseUrl && typeof fetchFn === 'function') {
    try {
      const res = await fetchFn(`${baseUrl}/registry.json`, { signal: AbortSignal.timeout(2000) });
      if (res?.ok) {
        const json = await res.json();
        if (Array.isArray(json?.packages)) remotePackages = json.packages;
      }
    } catch {
      // Fallback to SEED_REGISTRY when offline or unreachable
    }
  }

  const mergedMap = new Map();
  for (const pkg of SEED_REGISTRY.packages) mergedMap.set(pkg.id, structuredClone(pkg));
  for (const pkg of remotePackages) {
    if (pkg?.id) mergedMap.set(pkg.id, pkg);
  }

  const packages = [...mergedMap.values()].map((pkg) => {
    const localRule = hangarCfg.sidecars?.[pkg.id];
    const isInstalled = Boolean(localRule);
    const installedVersion = localRule?.installedVersion || '';
    const updateAvailable = isInstalled && isNewerSemver(installedVersion, pkg.latestVersion);
    return {
      ...pkg,
      isInstalled,
      installedVersion,
      updateAvailable,
    };
  });

  lastCachedRegistryPackages = packages;

  return {
    generatedAt: new Date().toISOString(),
    featuredIds: SEED_REGISTRY.featuredIds,
    packages,
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
