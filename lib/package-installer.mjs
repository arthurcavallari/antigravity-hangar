/**
 * @fileoverview Package installer, local folder linker, capability tier inspector,
 * and uninstaller for Antigravity Hangar.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync,
  renameSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { readJsonSafe, updateAgySidecarConfig } from 'antigravity-sidecar-kit/config';
import { bundleSidecarKit, createSidecarLink, KIT_ROOT, removeLinkOrDir } from 'antigravity-sidecar-kit/setup';
import {
  CONFIG_JSON_PATH, GLOBAL_SIDECARS_DIR, HANGAR_CONFIG_PATH,
  HANGAR_PACKAGES_DIR, HANGAR_VERSION, RESERVED_SIDECAR_IDS,
  SEED_REGISTRY, SIDECAR_ID,
} from './constants.mjs';
import {
  assertHangarConfigSavable, loadHangarConfig, saveHangarConfig, updateSidecarRule,
} from './config-store.mjs';
import { hangarRpc } from './ls-rpc.mjs';

export const TRUSTED_FIRST_PARTY_SDKS = new Set(['antigravity-sidecar-kit', 'sidecar_sdk']);

const TIER_RANK = { TIER_1_TELEMETRY: 1, TIER_2_LOCAL_TOOLING: 2, TIER_3_AGENT_CONTROL: 3 };
const tierRank = (tier) => TIER_RANK[tier] || 1;

// Thrown before anything is linked or run when the downloaded code needs more access than the user agreed to
class TierConsentRequiredError extends Error {
  constructor(inspection, acceptedTier) {
    super(`${inspection.displayName} needs ${inspection.capabilityTier}, but only ${acceptedTier || 'TIER_1_TELEMETRY'} was accepted`);
    this.inspection = inspection;
  }
}

export function sanitizeSidecarId(raw = '') {
  return String(raw || '').trim().toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '');
}

function pathExists(p) {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

// sidecars/<id> may only be replaced or removed when it is a link Hangar created (Windows junctions
// report isSymbolicLink() too); a real folder there is user data and must never be rm'd recursively.
function assertReplaceableSidecarLink(linkPath, sourceDir = '') {
  let stat;
  try { stat = lstatSync(linkPath); } catch { return; }
  if (stat.isSymbolicLink()) return;
  if (sourceDir && realpathSync(linkPath) === realpathSync(resolve(sourceDir))) return;
  throw new Error(
    `${linkPath} is a real folder, not a link created by Hangar; refusing to delete it. ` +
      'Move or remove it manually, then retry.'
  );
}

function linkSidecarDir(sourceDir, linkPath) {
  assertReplaceableSidecarLink(linkPath, sourceDir);
  return createSidecarLink(sourceDir, linkPath);
}

function removeSidecarLink(linkPath) {
  assertReplaceableSidecarLink(linkPath);
  if (pathExists(linkPath)) unlinkSync(linkPath);
}

// Moves a fully prepared staging folder onto targetDir, restoring the previous copy if the swap fails.
function swapIntoPlace(stagingDir, targetDir) {
  if (!pathExists(targetDir)) {
    renameSync(stagingDir, targetDir);
    return;
  }
  const previousDir = `${stagingDir}.previous`;
  renameSync(targetDir, previousDir);
  try {
    renameSync(stagingDir, targetDir);
  } catch (err) {
    renameSync(previousDir, targetDir);
    throw err;
  }
  try {
    rmSync(previousDir, { recursive: true, force: true });
  } catch {
    // Leftover <id>@... folders are swept by uninstallSidecar
  }
}

function scanRuntimeSourceCapabilities(dirPath) {
  let hasChildProcess = false;
  let hasAgentControl = false;
  // dist/ is scanned: it's where most sidecars ship their runtime code
  const skipDirs = new Set(['node_modules', '.git', 'test', 'tests', '.idea']);

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

async function activateSidecarViaLs(sidecarId, rpcFn = hangarRpc, delayMs = 250) {
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
  gitRepo = '', tarballUrl = '',
  sidecarsDir = GLOBAL_SIDECARS_DIR, configPath = HANGAR_CONFIG_PATH,
  agyConfigPath = CONFIG_JSON_PATH, rpcFn = hangarRpc, delayMs = 250,
} = {}) {
  const inspection = inspectSidecarDirectory(folderPath);
  const id = sanitizeSidecarId(sidecarId || inspection.id);
  if (!id || RESERVED_SIDECAR_IDS.has(id)) throw new Error(`Invalid or reserved sidecarId: "${id}"`);
  assertHangarConfigSavable(loadHangarConfig(configPath));

  linkSidecarDir(inspection.resolvedPath, join(sidecarsDir, id));
  updateAgySidecarConfig(id, true, agyConfigPath, { createIfMissing: false });

  const effectiveWorkspaces =
    scope === 'global' ? ['*'] : Array.isArray(workspaces) && workspaces.length > 0 ? workspaces : ['*'];
  const effectiveScope = effectiveWorkspaces.includes('*') ? 'global' : scope;

  const rulePatch = {
    scope: effectiveScope,
    workspaces: effectiveWorkspaces,
    installedVersion: inspection.version,
    capabilityTier: inspection.capabilityTier,
    source,
  };
  if (gitRepo) rulePatch.gitRepo = String(gitRepo);
  if (tarballUrl) rulePatch.tarballUrl = String(tarballUrl);

  const rule = updateSidecarRule(id, rulePatch, { configPath, sidecarsDir });
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

async function materializeRemotePackage({
  id,
  cleanRepo = '',
  gitRef = '',
  tarballUrl = '',
  version = 'latest',
  sha256 = '',
  packagesDir = HANGAR_PACKAGES_DIR,
  fetchFn = globalThis.fetch,
  execFn = execFileSync,
  acceptedTier,
} = {}) {
  // A leading "-" would be parsed by git as an option rather than a repository or branch
  if (cleanRepo.startsWith('-') || gitRef.startsWith('-')) {
    throw new Error(`Invalid repository spec: ${cleanRepo}${gitRef ? `@${gitRef}` : ''}`);
  }
  const effectiveVersion = version && version !== 'latest' ? version : gitRef || 'latest';
  const cleanVer = String(effectiveVersion).replace(/[^a-z0-9._-]+/gi, '') || 'latest';
  const targetDir = join(packagesDir, `${id}@${cleanVer}`);

  mkdirSync(packagesDir, { recursive: true });
  // Build the new copy beside targetDir so a failed download, clone or npm install leaves the live one intact
  const stagingDir = mkdtempSync(`${targetDir}.staging-`);
  try {
    let materializedViaTarball = false;
    if (tarballUrl) {
      try {
        const res = await fetchFn(tarballUrl, { signal: AbortSignal.timeout(15000) });
        if (!res?.ok) throw new Error(`Failed to download tarball (${res?.status || 'network error'})`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (sha256) {
          const digest = createHash('sha256').update(buf).digest('hex');
          if (digest.toLowerCase() !== String(sha256).toLowerCase()) {
            throw new Error(`SHA-256 mismatch: expected ${sha256}, got ${digest}`);
          }
        }
        const tgzPath = join(packagesDir, `${id}-${Date.now()}.tgz`);
        writeFileSync(tgzPath, buf);
        try {
          execFn('tar', ['-xzf', tgzPath, '-C', stagingDir, '--strip-components=1'], { stdio: 'pipe' });
          materializedViaTarball = true;
        } finally {
          removeLinkOrDir(tgzPath);
        }
      } catch (err) {
        if (!cleanRepo || sha256 || String(err?.message || '').startsWith('SHA-256 mismatch')) {
          throw err;
        }
        rmSync(stagingDir, { recursive: true, force: true });
        mkdirSync(stagingDir);
      }
    }
    if (!materializedViaTarball) {
      const cloneArgs = ['clone', '--depth', '1'];
      if (gitRef) cloneArgs.push('--branch', gitRef);
      cloneArgs.push('--', cleanRepo, stagingDir);
      execFn('git', cloneArgs, { stdio: 'pipe' });
    }

    const inspection = inspectSidecarDirectory(stagingDir);
    // Checked before npm install and the swap, so a refusal leaves any existing install untouched
    if (acceptedTier !== undefined && tierRank(inspection.capabilityTier) > tierRank(acceptedTier)) {
      throw new TierConsentRequiredError(inspection, acceptedTier);
    }
    if (inspection.dependenciesCount > 0) {
      try {
        const npmArgs = ['install', '--omit=dev', '--ignore-scripts'];
        const npmCli = process.platform === 'win32'
          ? join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
          : '';
        if (npmCli && existsSync(npmCli)) {
          execFn(process.execPath, [npmCli, ...npmArgs], { cwd: stagingDir, stdio: 'pipe' });
        } else {
          execFn(process.platform === 'win32' ? 'npm.cmd' : 'npm', npmArgs, { cwd: stagingDir, stdio: 'pipe' });
        }
      } catch (err) {
        if (inspection.externalDependencies > 0 || !bundleSidecarKit(stagingDir, KIT_ROOT)) throw err;
      }
    }

    swapIntoPlace(stagingDir, targetDir);
    return { targetDir, inspection: { ...inspection, resolvedPath: targetDir } };
  } catch (err) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw err;
  }
}

// acceptedTier is the capability tier the user agreed to. When Hangar's scan of the downloaded code finds
// a higher one, nothing is linked and the result is { needsConsent: true, scannedTier } so the UI can ask.
export async function installRemoteSidecar({
  sidecarId = '', gitRepo = '', tarballUrl = '', version = 'latest', sha256 = '',
  scope = 'project', workspaces = [], acceptedTier = 'TIER_1_TELEMETRY', packagesDir = HANGAR_PACKAGES_DIR,
  sidecarsDir = GLOBAL_SIDECARS_DIR, configPath = HANGAR_CONFIG_PATH,
  agyConfigPath = CONFIG_JSON_PATH, rpcFn = hangarRpc, fetchFn = globalThis.fetch,
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

  let materialized;
  try {
    materialized = await materializeRemotePackage({
      id, cleanRepo, gitRef, tarballUrl, version, sha256, packagesDir, fetchFn, execFn,
      acceptedTier: String(acceptedTier || ''),
    });
  } catch (err) {
    if (!(err instanceof TierConsentRequiredError)) throw err;
    return {
      ok: false,
      needsConsent: true,
      sidecarId: sanitizeSidecarId(sidecarId || err.inspection.id || id),
      displayName: err.inspection.displayName,
      scannedTier: err.inspection.capabilityTier,
      acceptedTier,
    };
  }
  const { targetDir, inspection } = materialized;

  const finalId = sanitizeSidecarId(sidecarId || inspection.id || id);
  return linkLocalSidecar({
    folderPath: targetDir, sidecarId: finalId, scope, workspaces,
    source: tarballUrl ? 'registry' : 'github',
    gitRepo: cleanRepo.replace(/\.git$/i, ''),
    tarballUrl,
    sidecarsDir, configPath, agyConfigPath, rpcFn, delayMs,
  });
}

export async function selfUpdateHangar({
  gitRepo = '', tarballUrl = '', version = 'latest', sha256 = '',
  packagesDir = HANGAR_PACKAGES_DIR, sidecarsDir = GLOBAL_SIDECARS_DIR,
  agyConfigPath = CONFIG_JSON_PATH, rpcFn = hangarRpc, fetchFn = globalThis.fetch,
  execFn = execFileSync, delayMs = 250, deferRestart = false,
} = {}) {
  const defaultRepo =
    SEED_REGISTRY.hangar?.release?.gitRepo || 'https://github.com/arthurcavallari/antigravity-hangar';
  const { repoUrl: cleanRepo, gitRef } = parseGitRepoSpec(gitRepo || (!tarballUrl ? defaultRepo : ''));

  const { targetDir, inspection } = await materializeRemotePackage({
    id: SIDECAR_ID, cleanRepo, gitRef, tarballUrl, version, sha256, packagesDir, fetchFn, execFn,
  });

  if (inspection.externalDependencies === 0) {
    bundleSidecarKit(targetDir, KIT_ROOT);
  }

  linkSidecarDir(inspection.resolvedPath, join(sidecarsDir, SIDECAR_ID));
  updateAgySidecarConfig(SIDECAR_ID, true, agyConfigPath, { createIfMissing: false });

  let activation;
  if (deferRestart) {
    setTimeout(() => {
      activateSidecarViaLs(SIDECAR_ID, rpcFn, delayMs).catch(() => {});
    }, 150).unref?.();
    activation = { activated: true, method: 'deferred-restart' };
  } else {
    activation = await activateSidecarViaLs(SIDECAR_ID, rpcFn, delayMs);
  }

  return {
    ok: true,
    sidecarId: SIDECAR_ID,
    previousVersion: HANGAR_VERSION,
    updatedVersion: inspection.version,
    linkedTo: inspection.resolvedPath,
    activation,
  };
}

export async function uninstallSidecar({
  sidecarId, packagesDir = HANGAR_PACKAGES_DIR, sidecarsDir = GLOBAL_SIDECARS_DIR,
  configPath = HANGAR_CONFIG_PATH, agyConfigPath = CONFIG_JSON_PATH, rpcFn = hangarRpc,
} = {}) {
  const id = sanitizeSidecarId(sidecarId);
  if (!id || RESERVED_SIDECAR_IDS.has(id) || String(sidecarId).includes('/')) {
    throw new Error(`Cannot uninstall protected or plugin sidecar: ${sidecarId}`);
  }

  // Validate before disabling or deleting anything so a refusal leaves the install untouched
  const linkPath = join(sidecarsDir, id);
  assertReplaceableSidecarLink(linkPath);
  const hangarCfg = loadHangarConfig(configPath);
  assertHangarConfigSavable(hangarCfg);

  await rpcFn('ManageSidecar', { action: 'SIDECAR_ACTION_DISABLE', sidecarId: id }).catch(() => {});
  removeSidecarLink(linkPath);

  if (existsSync(packagesDir)) {
    for (const entry of readdirSync(packagesDir)) {
      if (entry === id || entry.startsWith(`${id}@`)) removeLinkOrDir(join(packagesDir, entry));
    }
  }

  delete hangarCfg.sidecars[id];
  hangarCfg.manuallyStopped = (hangarCfg.manuallyStopped || []).filter((s) => s !== id);
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
