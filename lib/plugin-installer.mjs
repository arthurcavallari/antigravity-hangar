/**
 * @fileoverview Plugin installer for Antigravity Hangar. Downloads a registry plugin, ports it with
 * agy-plugin-porter when it comes from another tool (Claude Code, Gemini CLI, Cursor, Roo/Kilo, Codex),
 * audits it, installs it with `agy plugin install`, and enables it through the Language Server. Also
 * lists installed plugins and uninstalls the ones Hangar installed.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { removeLinkOrDir } from 'antigravity-sidecar-kit/setup';
import { GLOBAL_PLUGINS_DIR, HANGAR_CONFIG_PATH, HANGAR_PACKAGES_DIR } from './constants.mjs';
import {
  assertHangarConfigSavable, loadHangarConfig, readJsonSafe, saveHangarConfig,
} from './config-store.mjs';
import { hangarRpc } from './ls-rpc.mjs';
import { tierRank } from './package-installer.mjs';
import { downloadRemoteSource, parseGitRepoSpec, resolvePackageSubdir, swapIntoPlace } from './remote-source.mjs';

// What `agy plugin install` accepts as a plugin name, which becomes the plugin's folder name
const PLUGIN_NAME = /^[a-z0-9][a-z0-9_-]*$/;
const PORT_SOURCES = new Set(['claude', 'gemini', 'cursor', 'roo', 'codex', 'auto']);

// Folders installed or replaced since Hangar started. Antigravity reads plugin folders on startup and
// restarts Hangar with it, so these are the installs still waiting for that restart.
const pendingRestart = new Set();

// agy-plugin-porter is pinned to a GitHub commit until 0.1.0 is on npm (then depend on "^0.1.0"). It's
// loaded on first use, so Hangar still starts, and installs sidecars, if an update couldn't install it.
let porterModule = null;
async function loadPorter() {
  try {
    porterModule ??= await import('agy-plugin-porter');
    return porterModule;
  } catch (err) {
    throw new Error(`Hangar can't install plugins without agy-plugin-porter: ${err.message}`);
  }
}

const pluginDirOf = (plugin) => String(plugin?.path || '').split(/[\\/]/).filter(Boolean).pop() || '';
const enablePlugin = (dir, rpcFn) =>
  rpcFn('JetboxWriteState', { userConfig: { plugins: { [dir]: { enabled: true } } } });

// Changes whenever the audit finds something different, so consent given for one scan can't cover another
export function flagsDigest(flags = []) {
  if (!flags.length) return '';
  const keys = flags.map((f) => [f.kind, f.severity, f.file || '', f.line || 0].join(':')).sort();
  return createHash('sha256').update(keys.join('\n')).digest('hex').slice(0, 16);
}

// Maps an /api/store request body onto installRemotePlugin() and previewPluginPort() options
export function pluginRequest(data = {}) {
  const str = (v) => (typeof v === 'string' ? v : '');
  return {
    pluginId: str(data?.pluginId),
    gitRepo: str(data?.gitRepo),
    tarballUrl: str(data?.tarballUrl),
    sha256: str(data?.sha256),
    ref: str(data?.ref),
    path: str(data?.path),
    port: data?.port && typeof data.port === 'object' ? { from: str(data.port.from) } : null,
    version: str(data?.version),
    acceptedTier: str(data?.acceptedTier) || 'TIER_1_TELEMETRY',
    acceptedFlags: str(data?.acceptedFlags),
  };
}

// The id names the plugin's folder, so it's refused rather than rewritten when it isn't already valid
function assertPluginId(pluginId) {
  if (!PLUGIN_NAME.test(String(pluginId || ''))) throw new Error(`Invalid pluginId: "${pluginId}"`);
  return pluginId;
}

function resolveRequest({ pluginId, gitRepo, tarballUrl, ref, port }) {
  const id = assertPluginId(pluginId);
  if (!gitRepo && !tarballUrl) throw new Error('Either gitRepo or tarballUrl is required to install a plugin');
  const { repoUrl, gitRef } = parseGitRepoSpec(gitRepo);
  const pinnedRef = ref || gitRef;
  if (port) {
    if (!PORT_SOURCES.has(port.from)) throw new Error(`Unknown port source: "${port.from}"`);
    // A port is built from the upstream on this machine, so it must be pinned to stay reproducible
    if (!repoUrl || !pinnedRef) throw new Error(`${id} is ported, so it needs a gitRepo pinned to a tag or commit`);
  }
  return { id, repoUrl, gitRef: pinnedRef };
}

// A symlink in the download could pull a file from outside it (an SSH key, say) into the plugin
function assertNoSymlinks(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    if (entry.isSymbolicLink()) throw new Error(`The download contains a symbolic link (${entry.name}); Hangar won't install it`);
    if (entry.isDirectory()) assertNoSymlinks(join(dir, entry.name));
  }
}

// Downloads the package into workDir and builds the plugin to install in workDir/plugin. Ported plugins
// go through agy-plugin-porter; native ones are copied and get the same audit the porter runs.
async function buildPlugin({ id, repoUrl, gitRef, tarballUrl, sha256, path, port, workDir, porter, fetchFn, execFn }) {
  const srcRoot = join(workDir, 'src');
  mkdirSync(srcRoot);
  await downloadRemoteSource({
    id, cleanRepo: repoUrl, gitRef, tarballUrl, sha256, destDir: srcRoot, packagesDir: workDir, fetchFn, execFn,
  });
  const srcDir = resolvePackageSubdir(srcRoot, path, id);
  assertNoSymlinks(srcDir);

  const outDir = join(workDir, 'plugin');
  const { portPackage, auditPlugin } = porter || (await loadPorter());
  let report;
  if (port) {
    try {
      ({ report } = await portPackage({ srcDir, outDir, slug: id }));
    } catch (err) {
      throw new Error(`Couldn't port ${id}: ${err.message}`);
    }
    if (port.from !== 'auto' && !report.ecosystems.includes(port.from)) {
      throw new Error(`${id} is listed as a ${port.from} plugin, but the porter found ${report.ecosystems.join(' + ') || 'nothing it knows'}`);
    }
  } else {
    if (!existsSync(join(srcDir, 'plugin.json'))) {
      throw new Error(`${id} has no plugin.json${path ? ` in ${path}` : ''}; a plugin from another tool needs a "port" entry`);
    }
    cpSync(srcDir, outDir, { recursive: true, filter: (p) => !/[\\/]\.git$/.test(p) });
    const audit = auditPlugin(outDir);
    report = {
      ecosystems: ['antigravity'], ported: [], unported: [], warnings: audit.warnings,
      flags: audit.flags, tier: audit.tier, tierReasons: audit.reasons,
    };
  }
  const manifest = readJsonSafe(join(outDir, 'plugin.json'), {});
  if (!PLUGIN_NAME.test(String(manifest?.name || ''))) {
    throw new Error(`${id}'s plugin.json name "${manifest?.name ?? ''}" isn't one agy can install (use a-z, 0-9, "-" and "_")`);
  }
  return { outDir, report, dir: manifest.name, version: String(manifest.version || '') };
}

// What the consent dialog shows: item names, reasons and audit findings, never whole files
function portSummary({ ecosystems = [], ported = [], unported = [], warnings = [], flags = [], tier, tierReasons = [] }) {
  return { ecosystems, ported, unported, warnings, flags, tier, tierReasons };
}

// agy plugin install replaces a folder of the same name without asking, so only a plugin Hangar installed
// under this id may be replaced; any other plugin with that name belongs to the user
function assertReplaceablePlugin(dir, record, pluginsDir) {
  if (record?.dir === dir || !existsSync(join(pluginsDir, dir))) return;
  throw new Error(`A plugin named "${dir}" is already installed, and Hangar didn't install it. Uninstall it first, then retry.`);
}

// `agy plugin install <dir>` copies the plugin into the profile. Without the agy CLI, Hangar makes the same
// copy itself, staged beside plugins/ rather than in it, where a half-copied folder could load as a plugin.
function installIntoProfile(pluginDir, dir, { agyBin, execFn, pluginsDir }) {
  try {
    execFn(agyBin, ['plugin', 'install', pluginDir], { stdio: 'pipe', encoding: 'utf8', timeout: 120_000 });
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      throw new Error(`agy plugin install failed: ${String(err?.stderr || err?.stdout || err?.message || '').trim()}`);
    }
    mkdirSync(pluginsDir, { recursive: true });
    const staging = mkdtempSync(join(dirname(pluginsDir), '.hangar-plugin-'));
    try {
      cpSync(pluginDir, staging, { recursive: true });
      swapIntoPlace(staging, join(pluginsDir, dir));
    } catch (copyErr) {
      rmSync(staging, { recursive: true, force: true });
      throw copyErr;
    }
    return 'copy';
  }
  if (!existsSync(join(pluginsDir, dir, 'plugin.json'))) {
    throw new Error(`agy plugin install finished, but ${join(pluginsDir, dir)} wasn't created`);
  }
  return 'agy';
}

/**
 * Downloads, ports (when `port` is set), audits and installs a plugin. acceptedTier and acceptedFlags are
 * what the user agreed to: a capability tier, and the flagsDigest of the audit findings they were shown
 * (by previewPluginPort or an earlier needsConsent). A higher tier or different findings install nothing
 * and return { needsConsent: true, scannedTier, flagsDigest, report }.
 */
export async function installRemotePlugin({
  pluginId = '', gitRepo = '', tarballUrl = '', sha256 = '', ref = '', path = '', port = null, version = '',
  acceptedTier = 'TIER_1_TELEMETRY', acceptedFlags = '',
  packagesDir = HANGAR_PACKAGES_DIR, pluginsDir = GLOBAL_PLUGINS_DIR, configPath = HANGAR_CONFIG_PATH,
  rpcFn = hangarRpc, fetchFn = globalThis.fetch, execFn = execFileSync, porter = null, agyBin = 'agy',
} = {}) {
  const request = resolveRequest({ pluginId, gitRepo, tarballUrl, ref, port });
  const { id } = request;
  const hangarCfg = loadHangarConfig(configPath);
  assertHangarConfigSavable(hangarCfg);

  const cleanVer = String(version || request.gitRef || 'latest').replace(/[^a-z0-9._-]+/gi, '') || 'latest';
  const targetDir = join(packagesDir, `${id}@${cleanVer}`);
  mkdirSync(packagesDir, { recursive: true });
  // Built beside targetDir, so a failed download, port or refusal leaves the previous copy intact
  const workDir = mkdtempSync(`${targetDir}.staging-`);
  let built;
  try {
    built = await buildPlugin({ ...request, tarballUrl, sha256, path, port, workDir, porter, fetchFn, execFn });
    assertReplaceablePlugin(built.dir, hangarCfg.plugins[id], pluginsDir);
    const { tier, flags } = built.report;
    if (tierRank(tier) > tierRank(acceptedTier) || (flags.length > 0 && acceptedFlags !== flagsDigest(flags))) {
      return {
        ok: false, needsConsent: true, pluginId: id, scannedTier: tier, acceptedTier,
        flagsDigest: flagsDigest(flags), report: portSummary(built.report),
      };
    }
    swapIntoPlace(built.outDir, targetDir);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }

  const installedWith = installIntoProfile(targetDir, built.dir, { agyBin, execFn, pluginsDir });
  pendingRestart.add(built.dir);
  // Never by editing config.json: the Language Server applies this write live. It also clears a stale
  // enabled:false left by an earlier uninstall, which would otherwise bring the plugin back disabled.
  const enabled = await enablePlugin(built.dir, rpcFn).then(
    () => ({ ok: true }),
    (err) => ({ ok: false, reason: err.message })
  );

  // Re-read: porting can take a while, and other hangar.json writes (layout, rules) may have landed
  const cfg = loadHangarConfig(configPath);
  cfg.plugins[id] = {
    dir: built.dir,
    installedVersion: version || built.version,
    capabilityTier: built.report.tier,
    portedFrom: port ? built.report.ecosystems.filter((e) => e !== 'antigravity') : [],
    source: tarballUrl ? 'registry' : 'github',
    gitRepo: request.repoUrl.replace(/\.git$/i, ''),
    ...(request.gitRef ? { ref: request.gitRef } : {}),
    ...(path ? { path } : {}),
  };
  saveHangarConfig(cfg, configPath);
  return {
    ok: true, pluginId: id, dir: built.dir, installedWith, enabled, restartRequired: true,
    report: portSummary(built.report),
  };
}

// Dry run for the consent dialog: downloads and ports into a temp folder, then returns the report.
// Nothing is installed or recorded.
export async function previewPluginPort({
  pluginId = '', gitRepo = '', tarballUrl = '', sha256 = '', ref = '', path = '', port = null,
  fetchFn = globalThis.fetch, execFn = execFileSync, porter = null,
} = {}) {
  const request = resolveRequest({ pluginId, gitRepo, tarballUrl, ref, port });
  const workDir = mkdtempSync(join(tmpdir(), 'hangar-port-preview-'));
  try {
    const { report, dir } = await buildPlugin({ ...request, tarballUrl, sha256, path, port, workDir, porter, fetchFn, execFn });
    return {
      ok: true, pluginId: request.id, dir, scannedTier: report.tier, flagsDigest: flagsDigest(report.flags),
      report: portSummary(report), restartRequired: true,
    };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

// Uninstalls a plugin Hangar installed. A plugin Antigravity has loaded is removed with DeletePlugin; one
// installed since Antigravity started isn't loaded yet, so its folder is simply deleted.
export async function uninstallPlugin({
  pluginId = '', packagesDir = HANGAR_PACKAGES_DIR, pluginsDir = GLOBAL_PLUGINS_DIR,
  configPath = HANGAR_CONFIG_PATH, rpcFn = hangarRpc,
} = {}) {
  const id = assertPluginId(pluginId);
  const hangarCfg = loadHangarConfig(configPath);
  assertHangarConfigSavable(hangarCfg);
  const dir = hangarCfg.plugins[id]?.dir;
  if (!dir || !PLUGIN_NAME.test(dir)) {
    throw new Error(`Hangar didn't install the plugin "${pluginId}", so it won't uninstall it; use Antigravity's Plugins page`);
  }

  const loaded = ((await rpcFn('GetAllPlugins', {}))?.plugins || []).find((p) => pluginDirOf(p) === dir);
  if (loaded) {
    // DeletePlugin leaves plugins.<dir> in config.json, where a disabled entry would make a reinstall come
    // back disabled. Enabling first makes it harmless; it's always sent, since the cached list can lag.
    await enablePlugin(dir, rpcFn);
    await rpcFn('DeletePlugin', { pluginId: dir });
  } else {
    removeLinkOrDir(join(pluginsDir, dir));
  }
  pendingRestart.delete(dir);

  if (existsSync(packagesDir)) {
    for (const entry of readdirSync(packagesDir)) {
      if (entry.startsWith(`${id}@`)) removeLinkOrDir(join(packagesDir, entry));
    }
  }
  delete hangarCfg.plugins[id];
  saveHangarConfig(hangarCfg, configPath);
  return { ok: true, pluginId: id, dir, reEnabled: Boolean(loaded?.disabled), method: loaded ? 'DeletePlugin' : 'removed' };
}

// GetAllPlugins inlines every bundled SKILL.md, so nothing but names, states and counts leaves here
export function reducePlugin(plugin = {}) {
  const count = (v) => (Array.isArray(v) ? v.length : 0);
  let hooks = 0;
  try {
    hooks = plugin.hooksJson ? Object.keys(JSON.parse(plugin.hooksJson)).length : 0;
  } catch {
    hooks = 1;
  }
  const dir = pluginDirOf(plugin);
  return {
    name: String(plugin.name || dir),
    dir,
    disabled: Boolean(plugin.disabled),
    builtin: /[\\/]builtin[\\/]plugins[\\/]/.test(String(plugin.path || '')),
    counts: {
      skills: count(plugin.skills),
      agents: count(plugin.agents),
      rules: count(plugin.rules),
      mcpServers: count(plugin.mcpServers),
      hooks,
    },
  };
}

// The plugins Antigravity loaded, plus any Hangar installed that it hasn't loaded yet. Hangar's own installs
// carry their registry id, version, tier and source, and say when they're waiting for a restart.
export function listInstalledPlugins(pluginsRes, hangarConfig = {}, { pluginsDir = GLOBAL_PLUGINS_DIR } = {}) {
  if (!Array.isArray(pluginsRes?.plugins)) return [];
  const loaded = pluginsRes.plugins.map(reducePlugin);
  const loadedDirs = new Set(loaded.map((p) => p.dir));
  const records = Object.entries(hangarConfig.plugins || {}).map(([pluginId, r]) => ({ ...r, pluginId }));
  const unloaded = records
    .filter((r) => r.dir && !loadedDirs.has(r.dir) && existsSync(join(pluginsDir, r.dir)))
    .map((r) => ({ name: r.dir, dir: r.dir, disabled: false, builtin: false, counts: null }));
  return [...loaded, ...unloaded]
    .map((p) => {
      const record = records.find((r) => r.dir === p.dir);
      return {
        ...p,
        pluginId: record?.pluginId || '',
        installedVersion: record?.installedVersion || '',
        capabilityTier: record?.capabilityTier || '',
        portedFrom: record?.portedFrom || [],
        restartRequired: Boolean(record) && (!loadedDirs.has(p.dir) || pendingRestart.has(p.dir)),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
