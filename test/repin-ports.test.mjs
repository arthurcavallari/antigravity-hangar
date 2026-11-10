// scripts/repin-ports.mjs: which ports it tracks, how it decides a pin needs to move, the report it writes for the
// PR, and that it only moves pins whose new commit ports. git and the porter are stubbed: nothing is fetched.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { applyRepin, diffPreviews, githubSlug, planRepins, portedEntries, renderReport, runRepins } from '../scripts/repin-ports.mjs';
import { validateRegistry } from '../scripts/validate-registry.mjs';

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const REPO = 'https://github.com/acme/plugins';

const port = (id, overrides = {}) => ({
  id, name: id, kind: 'plugin', port: { from: 'claude' }, latestVersion: '1.0.0', capabilityTier: 'TIER_1_TELEMETRY',
  homepage: `${REPO}/tree/${OLD}/plugins/${id}`, release: { gitRepo: REPO, ref: OLD, path: `plugins/${id}` }, ...overrides,
});

// head: the upstream's latest commit per repo; trees: `${sha}:${path}` -> tree id (missing means no such folder)
function fakeGit({ head = { [REPO]: NEW }, trees = {} } = {}) {
  const calls = [];
  return {
    calls,
    headCommit(url) {
      calls.push(['head', url]);
      if (!head[url]) throw new Error(`no access to ${url}`);
      return head[url];
    },
    folderTree(url, sha, path) {
      calls.push(['tree', url, sha, path]);
      return trees[`${sha}:${path}`] ?? null;
    },
  };
}

const preview = (tier, { version = '1.0.0', ported = ['skill:a'], flags = [], unported = [], warnings = [] } = {}) => ({
  ok: true, version, scannedTier: tier, report: { ported, flags, unported, warnings, tier },
});

describe('repin-ports', () => {
  it('tracks only ported plugins pinned to a github.com commit, and says why it skips the others', () => {
    const registry = {
      packages: [
        port('tracked'),
        port('tagged', { release: { gitRepo: REPO, ref: 'v1.2.0' } }),
        port('elsewhere', { release: { gitRepo: 'https://gitlab.com/acme/plugins', ref: OLD } }),
        { id: 'native', kind: 'plugin', release: { tarballUrl: 'https://example.com/p.tgz' } },
        { id: 'a-sidecar', release: { gitRepo: REPO } },
      ],
    };
    const { tracked, untracked } = portedEntries(registry);
    assert.deepEqual(tracked.map((e) => e.id), ['tracked']);
    assert.deepEqual(untracked, [
      { id: 'tagged', reason: 'it\'s pinned to the tag "v1.2.0", not a commit' },
      { id: 'elsewhere', reason: 'its upstream is not a github.com repository' },
    ]);
    assert.equal(githubSlug('https://github.com/acme/plugins.git'), 'acme/plugins');
    assert.equal(githubSlug('https://github.com.evil.example/acme/plugins'), null);
  });

  it('moves a pin only when the upstream head changed the plugin\'s folder', () => {
    const entries = [
      port('current', { release: { gitRepo: REPO, ref: NEW, path: 'plugins/current' } }),
      port('quiet'),
      port('changed'),
      port('gone'),
      port('offline', { release: { gitRepo: 'https://github.com/acme/private', ref: OLD, path: 'x' } }),
    ];
    const git = fakeGit({
      trees: {
        [`${OLD}:plugins/quiet`]: 't1', [`${NEW}:plugins/quiet`]: 't1',
        [`${OLD}:plugins/changed`]: 't2', [`${NEW}:plugins/changed`]: 't3',
        [`${OLD}:plugins/gone`]: 't4',
      },
    });
    const plan = planRepins(entries, git);
    assert.deepEqual(plan.map((r) => [r.entry.id, r.status]), [
      ['current', 'current'], ['quiet', 'unchanged'], ['changed', 'changed'], ['gone', 'missing'], ['offline', 'error'],
    ]);
    assert.match(plan[4].error, /no access/);
    assert.equal(git.calls.filter(([op, url]) => op === 'head' && url === REPO).length, 1, 'one head lookup per upstream');
  });

  it('compares the two ports: tier, audit findings (whatever their line), items not ported and warnings', () => {
    const before = preview('TIER_1_TELEMETRY', {
      version: '1.0.0', ported: ['a', 'b'],
      flags: [{ severity: 'medium', kind: 'high-entropy', file: 'skills/a/SKILL.md', line: 3 }],
      unported: [{ item: 'hook:Notification', reason: 'no agy event' }], warnings: ['w1'],
    });
    const after = preview('TIER_3_AGENT_CONTROL', {
      version: '1.1.0', ported: ['a', 'b', 'c'],
      flags: [
        { severity: 'medium', kind: 'high-entropy', file: 'skills/a/SKILL.md', line: 9 },
        { severity: 'high', kind: 'network-call', file: 'hooks/run.sh', line: 1 },
      ],
      unported: [], warnings: ['w1', 'w2'],
    });
    const diff = diffPreviews(before, after);
    assert.deepEqual(diff.version, { from: '1.0.0', to: '1.1.0' });
    assert.deepEqual(diff.tier, { from: 'TIER_1_TELEMETRY', to: 'TIER_3_AGENT_CONTROL', raised: true });
    assert.deepEqual(diff.ported, { from: 2, to: 3 });
    assert.deepEqual(diff.flags, { added: ['high network-call hooks/run.sh'], removed: [] }, 'a moved finding is the same finding');
    assert.deepEqual(diff.unported, { added: [], removed: ['hook:Notification: no agy event'] });
    assert.deepEqual(diff.warnings, { added: ['w2'], removed: [] });
    assert.equal(diffPreviews(after, before).tier.raised, false, 'a lower tier is not raised');
  });

  it('moves the pin, version, tier and homepage in place, keeping the key order', () => {
    const entry = port('p');
    const keys = Object.keys(entry);
    applyRepin(entry, { ref: NEW, version: '1.1.0', tier: 'TIER_2_LOCAL_TOOLING' });
    assert.equal(entry.release.ref, NEW);
    assert.equal(entry.latestVersion, '1.1.0');
    assert.equal(entry.capabilityTier, 'TIER_2_LOCAL_TOOLING');
    assert.equal(entry.homepage, `${REPO}/tree/${NEW}/plugins/p`);
    assert.deepEqual(Object.keys(entry), keys);
    const noVersion = applyRepin(port('q'), { ref: NEW, version: '', tier: 'TIER_1_TELEMETRY' });
    assert.equal(noVersion.latestVersion, '1.0.0', 'a port without a version keeps the listed one');
  });

  it('moves only the pins whose new commit ports, and leaves registry.json valid', async () => {
    const registry = JSON.parse(readFileSync(new URL('../registry.json', import.meta.url), 'utf8'));
    registry.packages.push(port('acme-good'), port('acme-broken'), port('acme-quiet'));
    const git = fakeGit({
      trees: {
        [`${OLD}:plugins/acme-good`]: 'g1', [`${NEW}:plugins/acme-good`]: 'g2',
        [`${OLD}:plugins/acme-broken`]: 'b1', [`${NEW}:plugins/acme-broken`]: 'b2',
        [`${OLD}:plugins/acme-quiet`]: 'q1', [`${NEW}:plugins/acme-quiet`]: 'q1',
      },
    });
    const ported = [];
    const fakePreview = async ({ entry, ref }) => {
      ported.push(`${entry.id}@${ref.slice(0, 1)}`);
      if (entry.id === 'acme-broken' && ref === NEW) throw new Error('acme-broken is listed as a claude plugin, but the porter found nothing it knows');
      return preview(ref === NEW ? 'TIER_3_AGENT_CONTROL' : 'TIER_1_TELEMETRY', { version: ref === NEW ? '2.0.0' : '1.0.0' });
    };
    const outcome = await runRepins(registry, {
      git, preview: fakePreview, only: ['acme-good', 'acme-broken', 'acme-quiet'],
    });
    assert.deepEqual(ported, ['acme-good@a', 'acme-good@b', 'acme-broken@a', 'acme-broken@b'], 'unchanged folders are never ported');
    const byId = Object.fromEntries(outcome.results.map((r) => [r.entry.id, r]));
    assert.equal(byId['acme-good'].status, 'repinned');
    assert.equal(byId['acme-broken'].status, 'failed');
    assert.equal(byId['acme-quiet'].status, 'unchanged');
    const entry = (id) => registry.packages.find((p) => p.id === id);
    assert.equal(entry('acme-good').release.ref, NEW);
    assert.equal(entry('acme-good').latestVersion, '2.0.0');
    assert.equal(entry('acme-good').capabilityTier, 'TIER_3_AGENT_CONTROL');
    assert.equal(entry('acme-broken').release.ref, OLD, 'a commit that does not port keeps the old pin');
    assert.deepEqual(validateRegistry(registry, { packageVersion: registry.hangar.latestVersion }), []);

    const report = renderReport(outcome, { porterVersion: '0.2.2' });
    assert.match(report, /Moves the pins of 1 ported plugin to/);
    assert.match(report, /\[!WARNING\]\n> \*\*acme-good\*\*: the tier rises/);
    assert.match(report, new RegExp(`https://github.com/acme/plugins/compare/${OLD}\\.\\.\\.${NEW}`));
    assert.match(report, /Tier 1 \(telemetry\) → Tier 3 \(agent control\) ⚠️ raised/);
    assert.match(report, /### Kept at their current pin\n- \*\*acme-broken:\*\* the latest commit \(b{12}\) doesn't port: acme-broken is listed/);
    assert.match(report, /Up to date \(no change in their folders\): acme-quiet\./);
    assert.match(report, /agy-plugin-porter 0\.2\.2/);
  });

  it('a dry run reports without moving any pin', async () => {
    const registry = { packages: [port('p')] };
    const git = fakeGit({ trees: { [`${OLD}:plugins/p`]: 'x', [`${NEW}:plugins/p`]: 'y' } });
    const outcome = await runRepins(registry, { git, preview: async () => preview('TIER_1_TELEMETRY'), dryRun: true });
    assert.equal(outcome.results[0].status, 'repinned');
    assert.equal(registry.packages[0].release.ref, OLD);
    assert.match(renderReport({ results: [], untracked: [] }), /^No ported plugin needs a new pin\./);
  });
});
