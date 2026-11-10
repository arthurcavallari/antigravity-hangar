#!/usr/bin/env node
// Proposes new pins for the ported plugins in registry.json.
//
// A ported plugin is pinned to an upstream commit (release.ref): Hangar clones that commit, ports and audits it
// on the user's machine, and offers installed copies an update only when the pin moves. The pin is the review
// point, since it ties the listed tier and audit to code someone checked. This script does the legwork of moving
// it: for each entry pinned to a commit, it finds the upstream default branch's latest commit, and if anything in
// the plugin's folder changed, ports both commits the way Hangar's installer does (previewPluginPort) and reports
// what changed: tier, audit findings, items not ported and warnings. With --write it updates the pins in
// registry.json. It never merges anything: a person reviews the report and the upstream diff.
//
//   node scripts/repin-ports.mjs [--write] [--report <file.md>] [--only <id,id>] [--registry <file>]
//
// --registry reads (and with --write, writes) another copy of registry.json, for trying it out.
//
// The porter reads and rewrites the plugin's files; no upstream code runs.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FULL_SHA = /^[0-9a-f]{40}$/;
const GITHUB_REPO = /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;
export const TIERS = ['TIER_1_TELEMETRY', 'TIER_2_LOCAL_TOOLING', 'TIER_3_AGENT_CONTROL'];
const TIER_LABEL = { TIER_1_TELEMETRY: 'Tier 1 (telemetry)', TIER_2_LOCAL_TOOLING: 'Tier 2 (local tooling)', TIER_3_AGENT_CONTROL: 'Tier 3 (agent control)' };
const tierLabel = (t) => TIER_LABEL[t] || t || 'unknown';

// "owner/repo" for a github.com repository URL, or null
export function githubSlug(gitRepo) {
  const m = GITHUB_REPO.exec(String(gitRepo || ''));
  return m ? `${m[1]}/${m[2]}` : null;
}

// Splits the registry's plugins into the ported ones this script can track (pinned to a commit on GitHub) and
// the ported ones it can't, with the reason
export function portedEntries(registry) {
  const tracked = [];
  const untracked = [];
  for (const pkg of registry?.packages || []) {
    if (pkg?.kind !== 'plugin' || !pkg.port) continue;
    const { gitRepo, ref } = pkg.release || {};
    if (!githubSlug(gitRepo)) untracked.push({ id: pkg.id, reason: 'its upstream is not a github.com repository' });
    else if (!FULL_SHA.test(String(ref || ''))) untracked.push({ id: pkg.id, reason: `it's pinned to the tag "${ref}", not a commit` });
    else tracked.push(pkg);
  }
  return { tracked, untracked };
}

// git through the command line. Upstream checkouts are blobless and shallow: only the commits and trees needed
// to see whether a folder changed are fetched.
export function cliGit({ execFn = execFileSync, workRoot = mkdtempSync(join(tmpdir(), 'hangar-repin-')) } = {}) {
  const run = (args, opts = {}) => String(execFn('git', args, { stdio: 'pipe', encoding: 'utf8', timeout: 120_000, ...opts })).trim();
  const repos = new Map();
  const repoDir = (url) => {
    if (!repos.has(url)) {
      const dir = join(workRoot, `r${repos.size}`);
      run(['init', '-q', '--bare', dir]);
      repos.set(url, { dir, fetched: new Set() });
    }
    return repos.get(url);
  };
  return {
    headCommit(url) {
      const line = run(['ls-remote', '--', url, 'HEAD']).split('\n')[0] || '';
      const sha = line.split(/\s+/)[0];
      if (!FULL_SHA.test(sha)) throw new Error(`git ls-remote gave no HEAD commit for ${url}`);
      return sha;
    },
    // The tree id of `path` at `sha`, or null when the folder isn't there
    folderTree(url, sha, path) {
      const repo = repoDir(url);
      if (!repo.fetched.has(sha)) {
        run(['-C', repo.dir, 'fetch', '-q', '--depth', '1', '--filter=blob:none', '--', url, sha]);
        repo.fetched.add(sha);
      }
      try {
        return run(['-C', repo.dir, 'rev-parse', '--verify', '-q', `${sha}:${path || ''}`]) || null;
      } catch {
        return null;
      }
    },
  };
}

// What each tracked entry needs: 'current' (the pin is the upstream head), 'unchanged' (upstream moved, this
// folder didn't), 'changed', 'missing' (the folder is gone at the head) or 'error'
export function planRepins(entries, git) {
  const heads = new Map();
  return entries.map((entry) => {
    const { gitRepo, ref, path = '' } = entry.release;
    try {
      if (!heads.has(gitRepo)) heads.set(gitRepo, git.headCommit(gitRepo));
      const head = heads.get(gitRepo);
      if (head === ref) return { entry, status: 'current', head };
      const oldTree = git.folderTree(gitRepo, ref, path);
      const newTree = git.folderTree(gitRepo, head, path);
      if (!newTree) return { entry, status: 'missing', head };
      if (oldTree === newTree) return { entry, status: 'unchanged', head };
      return { entry, status: 'changed', head };
    } catch (err) {
      return { entry, status: 'error', error: String(err?.message || err) };
    }
  });
}

// An audit finding's identity across commits: line numbers move when unrelated lines change
const flagKey = (f) => `${f.severity || ''} ${f.kind || ''}${f.file ? ` ${f.file}` : ''}`.trim();
const unportedKey = (u) => (typeof u === 'string' ? u : `${u?.item || ''}: ${u?.reason || ''}`);
function setDiff(before = [], after = [], key = String) {
  const a = new Set(before.map(key));
  const b = new Set(after.map(key));
  return { added: [...b].filter((x) => !a.has(x)), removed: [...a].filter((x) => !b.has(x)) };
}

// How the port at the new commit differs from the port at the current pin
export function diffPreviews(oldPreview, newPreview) {
  const o = oldPreview?.report || {};
  const n = newPreview?.report || {};
  const from = oldPreview?.scannedTier || null;
  const to = newPreview?.scannedTier || null;
  return {
    version: { from: oldPreview?.version || null, to: newPreview?.version || null },
    tier: { from, to, raised: Boolean(from && to && TIERS.indexOf(to) > TIERS.indexOf(from)) },
    ported: { from: (o.ported || []).length, to: (n.ported || []).length },
    flags: setDiff(o.flags, n.flags, flagKey),
    unported: setDiff(o.unported, n.unported, unportedKey),
    warnings: setDiff(o.warnings, n.warnings),
  };
}

// Moves an entry's pin, in place so registry.json keeps its key order
export function applyRepin(entry, { ref, version, tier }) {
  const oldRef = entry.release.ref;
  entry.release.ref = ref;
  if (version) entry.latestVersion = version;
  if (tier) entry.capabilityTier = tier;
  if (typeof entry.homepage === 'string' && entry.homepage.includes(oldRef)) entry.homepage = entry.homepage.split(oldRef).join(ref);
  return entry;
}

// Plans, ports and (unless dryRun) moves the pins. `preview({entry, ref})` ports one commit the way Hangar's
// installer does. Returns one result per tracked entry, plus the untracked ones.
export async function runRepins(registry, { git, preview, only = null, dryRun = false } = {}) {
  const { tracked, untracked } = portedEntries(registry);
  const entries = only ? tracked.filter((e) => only.includes(e.id)) : tracked;
  const results = planRepins(entries, git);
  for (const r of results) {
    if (r.status !== 'changed') continue;
    const { entry, head } = r;
    let oldPreview = null;
    try {
      oldPreview = await preview({ entry, ref: entry.release.ref });
    } catch (err) {
      r.oldError = String(err?.message || err);
    }
    let newPreview;
    try {
      newPreview = await preview({ entry, ref: head });
    } catch (err) {
      r.status = 'failed';
      r.error = String(err?.message || err);
      continue;
    }
    r.from = entry.release.ref;
    r.diff = diffPreviews(oldPreview, newPreview);
    r.status = 'repinned';
    if (!dryRun) applyRepin(entry, { ref: head, version: newPreview.version, tier: newPreview.scannedTier });
  }
  return { results, untracked };
}

const short = (sha) => String(sha || '').slice(0, 12);
const list = (items, max = 10) => {
  const shown = items.slice(0, max).map((x) => `  - ${x}`);
  if (items.length > max) shown.push(`  - …and ${items.length - max} more`);
  return shown.join('\n');
};

// The PR body: what to review first, then each plugin's report diff
export function renderReport({ results, untracked = [] }, { porterVersion = '' } = {}) {
  const repinned = results.filter((r) => r.status === 'repinned');
  const needsEyes = repinned.filter((r) => r.diff.tier.raised || r.diff.flags.added.length);
  const lines = [];
  if (repinned.length) {
    lines.push(`Moves the pins of ${repinned.length} ported plugin${repinned.length === 1 ? '' : 's'} to the upstream's latest commit, with each port's report compared to the current pin's.`);
    lines.push('');
    lines.push("Merging this offers the new versions to every Hangar, and auto-update installs them. Review each upstream diff before merging: the report shows what the porter and audit found, not whether the code is safe.");
  } else {
    lines.push('No ported plugin needs a new pin.');
  }
  if (needsEyes.length) {
    lines.push('');
    lines.push(`> [!WARNING]\n> ${needsEyes.map((r) => `**${r.entry.id}**`).join(', ')}: the tier rises or the audit has new findings.`);
  }
  for (const r of repinned) {
    const { entry, diff } = r;
    const slug = githubSlug(entry.release.gitRepo);
    lines.push('');
    lines.push(`### ${entry.id}`);
    lines.push(`- **Upstream:** [${short(r.from)} → ${short(r.head)}](https://github.com/${slug}/compare/${r.from}...${r.head})${entry.release.path ? `, folder \`${entry.release.path}\`` : ''}`);
    if (diff.version.from !== diff.version.to) lines.push(`- **Version:** ${diff.version.from || 'none'} → ${diff.version.to || 'none'}`);
    lines.push(`- **Tier:** ${diff.tier.from === diff.tier.to ? `${tierLabel(diff.tier.to)}, unchanged` : `${tierLabel(diff.tier.from)} → ${tierLabel(diff.tier.to)}${diff.tier.raised ? ' ⚠️ raised' : ''}`}`);
    lines.push(`- **Ported items:** ${diff.ported.from} → ${diff.ported.to}`);
    if (diff.flags.added.length) lines.push(`- **New audit findings** ⚠️\n${list(diff.flags.added)}`);
    if (diff.flags.removed.length) lines.push(`- **Audit findings gone**\n${list(diff.flags.removed)}`);
    if (diff.unported.added.length) lines.push(`- **Newly not ported**\n${list(diff.unported.added)}`);
    if (diff.unported.removed.length) lines.push(`- **Now ported**\n${list(diff.unported.removed)}`);
    if (diff.warnings.added.length) lines.push(`- **New warnings**\n${list(diff.warnings.added)}`);
    if (diff.warnings.removed.length) lines.push(`- **Warnings gone:** ${diff.warnings.removed.length}`);
    if (r.oldError) lines.push(`- **The current pin no longer ports** (${r.oldError}), so there's nothing to compare against.`);
  }
  const skipped = results.filter((r) => ['failed', 'missing', 'error'].includes(r.status));
  if (skipped.length) {
    lines.push('');
    lines.push('### Kept at their current pin');
    for (const r of skipped) {
      const why = r.status === 'missing' ? `the folder \`${r.entry.release.path}\` is gone at ${short(r.head)}`
        : r.status === 'failed' ? `the latest commit (${short(r.head)}) doesn't port: ${r.error}` : r.error;
      lines.push(`- **${r.entry.id}:** ${why}`);
    }
  }
  const quiet = results.filter((r) => r.status === 'current' || r.status === 'unchanged');
  if (quiet.length) {
    lines.push('');
    lines.push(`Up to date (no change in their folders): ${quiet.map((r) => r.entry.id).join(', ')}.`);
  }
  if (untracked.length) {
    lines.push('');
    lines.push(`Not tracked: ${untracked.map((u) => `${u.id} (${u.reason})`).join('; ')}.`);
  }
  lines.push('');
  lines.push(`Ported with agy-plugin-porter ${porterVersion || '(unknown version)'} through Hangar's \`previewPluginPort\`, the same port and audit Hangar runs before an install. \`agy plugin validate\` isn't run, as Hangar's installer doesn't run it either.`);
  return `${lines.join('\n')}\n`;
}

function parseArgs(argv) {
  const opts = { write: false, report: '', only: null, registry: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--write') opts.write = true;
    else if (a === '--report') opts.report = argv[++i] || '';
    else if (a === '--registry') opts.registry = argv[++i] || '';
    else if (a === '--only') opts.only = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else throw new Error(`unknown option ${a}`);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const registryPath = opts.registry ? resolve(opts.registry) : join(REPO_ROOT, 'registry.json');
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  const { previewPluginPort } = await import('../lib/plugin-installer.mjs');
  const preview = ({ entry, ref }) => previewPluginPort({
    pluginId: entry.id, gitRepo: entry.release.gitRepo, ref, path: entry.release.path || '', port: entry.port,
  });
  const outcome = await runRepins(registry, { git: cliGit(), preview, only: opts.only, dryRun: !opts.write });
  const porterPkg = join(REPO_ROOT, 'node_modules', 'agy-plugin-porter', 'package.json');
  const porterVersion = existsSync(porterPkg) ? JSON.parse(readFileSync(porterPkg, 'utf8')).version : '';
  const report = renderReport(outcome, { porterVersion });
  const count = outcome.results.filter((r) => r.status === 'repinned').length;
  if (opts.write && count) writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  if (opts.report) writeFileSync(opts.report, report);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `count=${count}\n`);
  for (const r of outcome.results) console.log(`${r.entry.id}: ${r.status}${r.error ? ` (${r.error})` : ''}`);
  console.log(`${count} to repin${opts.write ? '' : ' (dry run: registry.json unchanged)'}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => {
    console.error(`repin-ports: ${err.message}`);
    process.exit(1);
  });
}
