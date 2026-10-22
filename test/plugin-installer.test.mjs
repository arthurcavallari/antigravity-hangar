import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  flagsDigest, installRemotePlugin, listInstalledPlugins, pluginRequest, previewPluginPort, uninstallPlugin,
} from '../lib/plugin-installer.mjs';
import { fetchHangarState } from '../lib/state-orchestrator.mjs';
import { loadHangarConfig, writeJsonNoBom } from '../lib/config-store.mjs';

const SHA = 'a'.repeat(40);
const HIGH_FLAG = { kind: 'pipe-to-shell', severity: 'high', file: 'hooks.json', line: 3, excerpt: 'curl x | sh' };

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'hangar-plugin-test-'));
  return {
    dir,
    packagesDir: join(dir, 'packages'),
    pluginsDir: join(dir, 'home', '.gemini', 'config', 'plugins'),
    configPath: join(dir, 'hangar.json'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content, 'utf8');
  }
}

// Stands in for git (the checkout gets `files`) and for `agy plugin install` (copies into pluginsDir)
function fakeExec(box, files, calls = []) {
  return (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'git' && args[0] === 'clone') writeTree(args[args.length - 1], files);
    if (cmd === 'git' && args[0] === 'init') writeTree(args[2], files);
    if (cmd === 'agy') {
      const name = JSON.parse(readFileSync(join(args[2], 'plugin.json'), 'utf8')).name;
      cpSync(args[2], join(box.pluginsDir, name), { recursive: true });
    }
  };
}

function fakePorter({ tier = 'TIER_2_LOCAL_TOOLING', flags = [], ecosystems = ['claude'] } = {}) {
  const calls = [];
  return {
    calls,
    portPackage: async ({ srcDir, outDir, slug }) => {
      calls.push({ port: srcDir, outDir, slug });
      writeTree(outDir, { 'plugin.json': JSON.stringify({ name: slug }), 'skills/review/SKILL.md': '---\nname: review\n---\n' });
      const report = {
        slug, ecosystems, ported: ['skill:review'], unported: [{ item: 'hook:UserPromptSubmit', reason: 'no agy event' }],
        warnings: [], flags, tier, tierReasons: ['hooks: PreToolUse'],
      };
      return { report, tier };
    },
    auditPlugin: (dir) => {
      calls.push({ audit: dir });
      return { flags, warnings: [], tier, reasons: [] };
    },
  };
}

const CLAUDE_SOURCE = {
  'plugins/review/.claude-plugin/plugin.json': '{"name":"review"}',
  'plugins/review/commands/review.md': '# Review',
  'README.md': 'monorepo',
};

function portRequest(box, overrides = {}) {
  return {
    pluginId: 'review-port',
    gitRepo: 'https://github.com/acme/plugins',
    ref: 'v1.2.0',
    path: 'plugins/review',
    port: { from: 'claude' },
    version: '1.2.0',
    acceptedTier: 'TIER_2_LOCAL_TOOLING',
    packagesDir: box.packagesDir,
    pluginsDir: box.pluginsDir,
    configPath: box.configPath,
    ...overrides,
  };
}

function recordingRpc(responses = {}) {
  const calls = [];
  const rpcFn = async (method, body) => {
    calls.push({ method, body });
    return responses[method] ?? {};
  };
  return { calls, rpcFn };
}

describe('Hangar plugin installer', () => {
  it('ports a pinned plugin from a subfolder, installs it with agy, enables it through the Language Server, and records it', async () => {
    const box = sandbox();
    try {
      const execCalls = [];
      const porter = fakePorter();
      const { calls, rpcFn } = recordingRpc();
      const res = await installRemotePlugin({
        ...portRequest(box), porter, rpcFn, execFn: fakeExec(box, CLAUDE_SOURCE, execCalls),
      });

      assert.equal(res.ok, true);
      assert.equal(res.dir, 'review-port');
      assert.equal(res.restartRequired, true);
      assert.equal(res.installedWith, 'agy');
      assert.deepEqual(res.enabled, { ok: true });
      assert.deepEqual(res.report.unported, [{ item: 'hook:UserPromptSubmit', reason: 'no agy event' }]);

      assert.equal(porter.calls[0].slug, 'review-port');
      assert.match(porter.calls[0].port, /plugins[\\/]review$/);
      assert.deepEqual(execCalls[0].args.slice(0, 7), ['clone', '--depth', '1', '--branch', 'v1.2.0', '--', 'https://github.com/acme/plugins']);
      const targetDir = join(box.packagesDir, 'review-port@1.2.0');
      assert.deepEqual(execCalls[1], { cmd: 'agy', args: ['plugin', 'install', targetDir] });
      assert.deepEqual(readdirSync(box.packagesDir), ['review-port@1.2.0'], 'no staging folders are left behind');
      assert.equal(existsSync(join(box.pluginsDir, 'review-port', 'skills', 'review', 'SKILL.md')), true);

      assert.deepEqual(calls, [
        { method: 'JetboxWriteState', body: { userConfig: { plugins: { 'review-port': { enabled: true } } } } },
      ]);
      assert.equal(existsSync(join(dirname(box.pluginsDir), 'config.json')), false, 'config.json is never edited');
      assert.deepEqual(loadHangarConfig(box.configPath).plugins['review-port'], {
        dir: 'review-port',
        installedVersion: '1.2.0',
        capabilityTier: 'TIER_2_LOCAL_TOOLING',
        portedFrom: ['claude'],
        source: 'github',
        gitRepo: 'https://github.com/acme/plugins',
        ref: 'v1.2.0',
        path: 'plugins/review',
      });
    } finally {
      box.cleanup();
    }
  });

  it('fetches a full commit SHA directly, since git clone --branch only takes tags and branches', async () => {
    const box = sandbox();
    try {
      const execCalls = [];
      await installRemotePlugin({
        ...portRequest(box, { ref: SHA }), porter: fakePorter(), rpcFn: async () => ({}),
        execFn: fakeExec(box, CLAUDE_SOURCE, execCalls),
      });
      const git = execCalls.filter((c) => c.cmd === 'git').map((c) => c.args);
      assert.equal(git[0][0], 'init');
      assert.deepEqual(git[1].slice(2), ['fetch', '-q', '--depth', '1', '--', 'https://github.com/acme/plugins', SHA]);
      assert.deepEqual(git[2].slice(2), ['checkout', '-q', 'FETCH_HEAD']);
      assert.equal(loadHangarConfig(box.configPath).plugins['review-port'].ref, SHA);
    } finally {
      box.cleanup();
    }
  });

  it('asks for consent when the scan finds a higher tier or audit flags, and installs nothing until the user agrees', async () => {
    const box = sandbox();
    try {
      const execCalls = [];
      const { calls, rpcFn } = recordingRpc();
      const opts = {
        ...portRequest(box, { acceptedTier: 'TIER_1_TELEMETRY' }),
        porter: fakePorter({ tier: 'TIER_3_AGENT_CONTROL', flags: [HIGH_FLAG] }),
        rpcFn,
        execFn: fakeExec(box, CLAUDE_SOURCE, execCalls),
      };
      const refused = await installRemotePlugin(opts);
      assert.equal(refused.needsConsent, true);
      assert.equal(refused.scannedTier, 'TIER_3_AGENT_CONTROL');
      assert.equal(refused.flagsDigest, flagsDigest([HIGH_FLAG]));
      assert.deepEqual(refused.report.flags, [HIGH_FLAG]);

      // Accepting the tier alone doesn't cover findings the user hasn't seen
      const stillRefused = await installRemotePlugin({ ...opts, acceptedTier: 'TIER_3_AGENT_CONTROL' });
      assert.equal(stillRefused.needsConsent, true);
      assert.equal(execCalls.some((c) => c.cmd === 'agy'), false);
      assert.deepEqual(calls, []);
      assert.deepEqual(readdirSync(box.packagesDir), []);
      assert.equal(existsSync(box.configPath), false);

      const installed = await installRemotePlugin({
        ...opts, acceptedTier: 'TIER_3_AGENT_CONTROL', acceptedFlags: refused.flagsDigest,
      });
      assert.equal(installed.ok, true);
      assert.equal(loadHangarConfig(box.configPath).plugins['review-port'].capabilityTier, 'TIER_3_AGENT_CONTROL');
    } finally {
      box.cleanup();
    }
  });

  it('installs a native plugin without porting it, audited by the same auditor, and leaves .git behind', async () => {
    const box = sandbox();
    try {
      const porter = fakePorter({ tier: 'TIER_1_TELEMETRY', ecosystems: ['antigravity'] });
      const res = await installRemotePlugin({
        pluginId: 'native-tool', gitRepo: 'acme/native-tool', ref: 'v2.0.0',
        packagesDir: box.packagesDir, pluginsDir: box.pluginsDir, configPath: box.configPath,
        porter, rpcFn: async () => ({}),
        execFn: fakeExec(box, {
          'plugin.json': '{"name":"native-tool","version":"2.0.0"}',
          'rules/AGENTS.md': 'Be brief.',
          '.git/config': '[core]',
        }),
      });
      assert.equal(res.ok, true);
      assert.equal(porter.calls.some((c) => c.port), false, 'native plugins skip portPackage');
      assert.equal(porter.calls.filter((c) => c.audit).length, 1);
      assert.equal(existsSync(join(box.pluginsDir, 'native-tool', 'rules', 'AGENTS.md')), true);
      assert.equal(existsSync(join(box.pluginsDir, 'native-tool', '.git')), false);
      const record = loadHangarConfig(box.configPath).plugins['native-tool'];
      assert.equal(record.installedVersion, '2.0.0');
      assert.deepEqual(record.portedFrom, []);
      assert.equal(record.gitRepo, 'https://github.com/acme/native-tool');
    } finally {
      box.cleanup();
    }
  });

  it('refuses downloads that would install the wrong code, before agy or the Language Server run', async () => {
    const box = sandbox();
    try {
      const execCalls = [];
      const { calls, rpcFn } = recordingRpc();
      const attempt = (overrides, files = CLAUDE_SOURCE, porter = fakePorter()) =>
        installRemotePlugin({ ...portRequest(box, overrides), porter, rpcFn, execFn: fakeExec(box, files, execCalls) });

      await assert.rejects(attempt({ port: { from: 'cursor' } }), /listed as a cursor plugin, but the porter found claude/);
      await assert.rejects(attempt({ path: '../outside' }), /no folder "\.\.\/outside"/);
      await assert.rejects(attempt({ port: null, path: '' }), /no plugin\.json; a plugin from another tool needs a "port" entry/);
      await assert.rejects(attempt({ ref: '', gitRepo: 'https://github.com/acme/plugins' }), /needs a gitRepo pinned/);
      await assert.rejects(attempt({ port: { from: 'vscode' } }), /Unknown port source/);
      await assert.rejects(attempt({ pluginId: '../evil' }), /Invalid pluginId/);
      await assert.rejects(
        attempt({ port: null, path: '' }, { 'plugin.json': '{"name":"Not.Valid"}' }),
        /isn't one agy can install/
      );

      const linkedFiles = { ...CLAUDE_SOURCE };
      const exec = fakeExec(box, linkedFiles, execCalls);
      await assert.rejects(
        installRemotePlugin({
          ...portRequest(box), porter: fakePorter(), rpcFn,
          execFn: (cmd, args) => {
            exec(cmd, args);
            const dest = args[args.length - 1];
            if (args[0] === 'clone') symlinkSync(box.dir, join(dest, 'plugins', 'review', 'leak'), process.platform === 'win32' ? 'junction' : 'dir');
          },
        }),
        /symbolic link \(leak\)/
      );

      assert.equal(execCalls.some((c) => c.cmd === 'agy'), false);
      assert.deepEqual(calls, []);
      assert.equal(existsSync(box.pluginsDir), false);
    } finally {
      box.cleanup();
    }
  });

  it("never replaces a plugin folder Hangar didn't install, but does replace its own on update", async () => {
    const box = sandbox();
    try {
      writeTree(join(box.pluginsDir, 'review-port'), { 'plugin.json': '{"name":"review-port","description":"mine"}' });
      const opts = { ...portRequest(box), porter: fakePorter(), rpcFn: async () => ({}), execFn: fakeExec(box, CLAUDE_SOURCE) };
      await assert.rejects(installRemotePlugin(opts), /already installed, and Hangar didn't install it/);
      assert.match(readFileSync(join(box.pluginsDir, 'review-port', 'plugin.json'), 'utf8'), /mine/);

      rmSync(join(box.pluginsDir, 'review-port'), { recursive: true });
      await installRemotePlugin(opts);
      const updated = await installRemotePlugin({ ...opts, version: '1.3.0', ref: 'v1.3.0' });
      assert.equal(updated.ok, true);
      assert.equal(loadHangarConfig(box.configPath).plugins['review-port'].installedVersion, '1.3.0');
    } finally {
      box.cleanup();
    }
  });

  it('copies the plugin into the profile when the agy CLI is missing, and reports a real agy failure', async () => {
    const box = sandbox();
    try {
      const exec = fakeExec(box, CLAUDE_SOURCE);
      const withAgy = (agy) => (cmd, args) => (cmd === 'agy' ? agy() : exec(cmd, args));
      const missing = () => { throw Object.assign(new Error('spawnSync agy ENOENT'), { code: 'ENOENT' }); };
      const res = await installRemotePlugin({
        ...portRequest(box), porter: fakePorter(), rpcFn: async () => ({}), execFn: withAgy(missing),
      });
      assert.equal(res.installedWith, 'copy');
      assert.equal(existsSync(join(box.pluginsDir, 'review-port', 'plugin.json')), true);
      assert.deepEqual(readdirSync(dirname(box.pluginsDir)), ['plugins'], 'no staging folder is left beside plugins/');

      const failing = () => { throw Object.assign(new Error('exit 1'), { status: 1, stderr: 'Error: invalid plugin name: "x"\n' }); };
      await assert.rejects(
        installRemotePlugin({ ...portRequest(box), porter: fakePorter(), rpcFn: async () => ({}), execFn: withAgy(failing) }),
        /agy plugin install failed: Error: invalid plugin name: "x"$/
      );
    } finally {
      box.cleanup();
    }
  });

  it('previews a port in a temp folder without installing or recording anything', async () => {
    const box = sandbox();
    try {
      const execCalls = [];
      const porter = fakePorter({ flags: [HIGH_FLAG] });
      const { calls, rpcFn } = recordingRpc();
      const preview = await previewPluginPort({
        ...pluginRequest({ pluginId: 'review-port', gitRepo: 'acme/plugins', ref: 'v1.2.0', path: 'plugins/review', port: { from: 'claude' } }),
        porter, rpcFn, execFn: fakeExec(box, CLAUDE_SOURCE, execCalls),
      });
      assert.equal(preview.ok, true);
      assert.equal(preview.scannedTier, 'TIER_2_LOCAL_TOOLING');
      assert.equal(preview.flagsDigest, flagsDigest([HIGH_FLAG]));
      assert.equal(preview.report.unported.length, 1);
      assert.equal(preview.restartRequired, true);
      assert.equal(existsSync(porter.calls[0].outDir), false, 'the dry run is cleaned up');
      assert.equal(execCalls.some((c) => c.cmd === 'agy'), false);
      assert.deepEqual(calls, []);
      assert.equal(existsSync(box.configPath), false);
    } finally {
      box.cleanup();
    }
  });

  it('uninstalls a loaded plugin with DeletePlugin, re-enabling it first so a reinstall comes back enabled', async () => {
    const box = sandbox();
    try {
      await installRemotePlugin({
        ...portRequest(box), porter: fakePorter(), rpcFn: async () => ({}), execFn: fakeExec(box, CLAUDE_SOURCE),
      });
      const { calls, rpcFn } = recordingRpc({
        GetAllPlugins: { plugins: [{ name: 'review-port', path: join(box.pluginsDir, 'review-port'), disabled: true }] },
      });
      const res = await uninstallPlugin({ pluginId: 'review-port', ...box, rpcFn });

      assert.deepEqual(calls.map((c) => c.method), ['GetAllPlugins', 'JetboxWriteState', 'DeletePlugin']);
      assert.deepEqual(calls[1].body, { userConfig: { plugins: { 'review-port': { enabled: true } } } });
      assert.deepEqual(calls[2].body, { pluginId: 'review-port' });
      assert.equal(res.reEnabled, true);
      assert.equal(res.method, 'DeletePlugin');
      assert.deepEqual(readdirSync(box.packagesDir), []);
      assert.equal(loadHangarConfig(box.configPath).plugins['review-port'], undefined);
    } finally {
      box.cleanup();
    }
  });

  it("deletes a plugin Antigravity hasn't loaded yet itself, and refuses plugins Hangar didn't install", async () => {
    const box = sandbox();
    try {
      await installRemotePlugin({
        ...portRequest(box), porter: fakePorter(), rpcFn: async () => ({}), execFn: fakeExec(box, CLAUDE_SOURCE),
      });
      const { calls, rpcFn } = recordingRpc({ GetAllPlugins: { plugins: [] } });
      const res = await uninstallPlugin({ pluginId: 'review-port', ...box, rpcFn });
      assert.equal(res.method, 'removed');
      assert.deepEqual(calls.map((c) => c.method), ['GetAllPlugins']);
      assert.equal(existsSync(join(box.pluginsDir, 'review-port')), false);

      writeTree(join(box.pluginsDir, 'theirs'), { 'plugin.json': '{"name":"theirs"}' });
      await assert.rejects(uninstallPlugin({ pluginId: 'theirs', ...box, rpcFn }), /Hangar didn't install the plugin "theirs"/);
      assert.equal(existsSync(join(box.pluginsDir, 'theirs', 'plugin.json')), true);
    } finally {
      box.cleanup();
    }
  });

  it('reduces GetAllPlugins to names, states and counts, and marks Hangar installs that wait for a restart', async () => {
    const box = sandbox();
    try {
      writeTree(join(box.pluginsDir, 'fresh-install'), { 'plugin.json': '{"name":"fresh-install"}' });
      const pluginsRes = {
        plugins: [
          {
            name: 'review-port',
            path: `${box.pluginsDir}/review-port`,
            disabled: true,
            skills: [{ name: 'review', content: 'SECRET SKILL BODY' }, { name: 'audit', content: 'SECRET' }],
            agents: [{ name: 'reviewer' }],
            rules: [{ absolutePath: '/x/rules/AGENTS.md', content: 'SECRET RULE' }],
            hooksJson: '{"guard":{"PreToolUse":[]},"start":{"SessionStart":[]}}',
            mcpServers: [{ name: 'github' }],
          },
          { name: 'science', path: 'C:\\Program Files\\Antigravity\\builtin\\plugins\\science', skills: [] },
        ],
      };
      const hangarConfig = {
        plugins: {
          'review-port': { dir: 'review-port', installedVersion: '1.2.0', capabilityTier: 'TIER_2_LOCAL_TOOLING', portedFrom: ['claude'] },
          'fresh-install': { dir: 'fresh-install', installedVersion: '0.1.0' },
          gone: { dir: 'gone' },
        },
      };
      const list = listInstalledPlugins(pluginsRes, hangarConfig, { pluginsDir: box.pluginsDir });

      assert.equal(JSON.stringify(list).includes('SECRET'), false);
      assert.deepEqual(list.map((p) => p.dir), ['fresh-install', 'review-port', 'science']);
      const [fresh, review, science] = list;
      assert.deepEqual(review.counts, { skills: 2, agents: 1, rules: 1, mcpServers: 1, hooks: 2 });
      assert.equal(review.disabled, true);
      assert.equal(review.pluginId, 'review-port');
      assert.deepEqual(review.portedFrom, ['claude']);
      assert.equal(review.restartRequired, false);
      assert.equal(fresh.restartRequired, true);
      assert.equal(fresh.counts, null);
      assert.equal(science.builtin, true);
      assert.equal(science.pluginId, '');
      assert.deepEqual(listInstalledPlugins(null, hangarConfig, { pluginsDir: box.pluginsDir }), []);
    } finally {
      box.cleanup();
    }
  });

  it('serves the reduced plugin list from /api/state, asking GetAllPlugins about the open workspaces', async () => {
    const box = sandbox();
    try {
      const { calls, rpcFn } = recordingRpc({
        GetAllPlugins: { plugins: [{ name: 'demo', path: '/home/u/.gemini/config/plugins/demo', skills: [{ content: 'SECRET' }] }] },
      });
      const hibernator = { syncManualStops() {}, reconcile: async () => [], getIdleSeconds: () => 0 };
      const state = await fetchHangarState({
        clientWorkspaceUris: ['file:///c:/work/app'], configPath: box.configPath,
        sidecarsDir: join(box.dir, 'sidecars'), pluginsDir: box.pluginsDir, hibernator, rpcFn,
      });
      assert.deepEqual(calls.find((c) => c.method === 'GetAllPlugins').body, { workspaceUris: ['file:///c:/work/app'] });
      assert.equal(state.plugins.length, 1);
      assert.equal(state.plugins[0].counts.skills, 1);
      assert.equal(JSON.stringify(state).includes('SECRET'), false);
    } finally {
      box.cleanup();
    }
  });

  it('works against the real agy-plugin-porter API for a Cursor source, which needs no agy', async () => {
    const box = sandbox();
    try {
      const res = await installRemotePlugin({
        pluginId: 'cursor-style', gitRepo: 'acme/cursor-rules', ref: 'v1.0.0', port: { from: 'cursor' },
        acceptedTier: 'TIER_1_TELEMETRY',
        packagesDir: box.packagesDir, pluginsDir: box.pluginsDir, configPath: box.configPath, rpcFn: async () => ({}),
        execFn: fakeExec(box, {
          '.cursor/rules/style.mdc': '---\ndescription: House style\nalwaysApply: true\n---\nUse tabs.\n',
        }),
      });
      assert.equal(res.ok, true);
      assert.deepEqual(res.report.ecosystems, ['cursor']);
      assert.equal(res.report.tier, 'TIER_1_TELEMETRY');
      assert.ok(res.report.ported.length > 0);
      const manifest = JSON.parse(readFileSync(join(box.pluginsDir, 'cursor-style', 'plugin.json'), 'utf8'));
      assert.equal(manifest.name, 'cursor-style');
      assert.ok(readdirSync(join(box.pluginsDir, 'cursor-style', 'rules')).length > 0);
    } finally {
      box.cleanup();
    }
  });
});
