import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  countPluginHooks, flagsDigest, installRemotePlugin, listInstalledPlugins, pluginRequest, previewPluginPort, reducePlugin, uninstallPlugin,
} from '../lib/plugin-installer.mjs';
import { inspectInstalledPluginHealth } from '../lib/plugin-diagnostics.mjs';
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

// Stands in for git (the checkout gets `files`) and for `agy plugin install` (copies into pluginsDir) and
// `agy plugin uninstall` (deletes from pluginsDir)
function fakeExec(box, files, calls = []) {
  return (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'git' && args[0] === 'clone') writeTree(args[args.length - 1], files);
    if (cmd === 'git' && args[0] === 'init') writeTree(args[2], files);
    if (cmd === 'agy' && args[1] === 'uninstall') {
      rmSync(join(box.pluginsDir, args[2]), { recursive: true, force: true });
    } else if (cmd === 'agy') {
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
    // The wait for Antigravity to list the plugin is real time, so keep it short here
    pollMs: 1,
    maxWaitMs: 1,
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

      assert.deepEqual(calls.filter((c) => c.method !== 'GetAllPlugins'), [
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

  it('asks for a restart only when Antigravity does not list the plugin after the install', async () => {
    for (const [label, listed] of [['listed right away', true], ['not listed', false]]) {
      const box = sandbox();
      try {
        const { calls, rpcFn } = recordingRpc({
          GetAllPlugins: { plugins: listed ? [{ name: 'review-port', path: `file:///C:/Users/x/.gemini/config/plugins/review-port` }] : [{ name: 'other', path: 'file:///x/plugins/other' }] },
        });
        const res = await installRemotePlugin({
          ...portRequest(box), porter: fakePorter(), rpcFn, execFn: fakeExec(box, CLAUDE_SOURCE, []),
        });
        assert.equal(res.ok, true, label);
        assert.equal(res.restartRequired, !listed, label);
        const order = calls.map((c) => c.method);
        assert.equal(order[0], 'JetboxWriteState', 'the plugin is enabled before the list is read');
        assert.equal(order.includes('GetAllPlugins'), true, label);
      } finally {
        box.cleanup();
      }
    }
  });

  it('waits for the plugin to show up before asking for a restart', async () => {
    const box = sandbox();
    try {
      let reads = 0;
      const rpcFn = async (method) => {
        if (method !== 'GetAllPlugins') return {};
        reads += 1;
        return { plugins: reads >= 3 ? [{ name: 'review-port', path: 'file:///x/plugins/review-port' }] : [] };
      };
      const res = await installRemotePlugin({
        ...portRequest(box, { pollMs: 1, maxWaitMs: 1000 }), porter: fakePorter(), rpcFn, execFn: fakeExec(box, CLAUDE_SOURCE, []),
      });
      assert.equal(res.restartRequired, false);
      assert.equal(reads, 3);
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
      assert.equal('restartRequired' in preview, false, 'a dry run can not know, so it says nothing');
      assert.equal(existsSync(porter.calls[0].outDir), false, 'the dry run is cleaned up');
      assert.equal(execCalls.some((c) => c.cmd === 'agy'), false);
      assert.deepEqual(calls, []);
      assert.equal(existsSync(box.configPath), false);
    } finally {
      box.cleanup();
    }
  });

  it('switches the plugin off, waits for its sidecars to stop, then uninstalls with agy, since the Language Server refuses DeletePlugin to sidecars', async () => {
    const box = sandbox();
    try {
      const execFn = fakeExec(box, CLAUDE_SOURCE);
      await installRemotePlugin({ ...portRequest(box), porter: fakePorter(), rpcFn: async () => ({}), execFn });
      const calls = [];
      let paneStatus = 'SIDECAR_STATUS_RUNNING';
      const rpcFn = async (method, body) => {
        calls.push({ method, body });
        if (method === 'ManageSidecar') setTimeout(() => { paneStatus = 'SIDECAR_STATUS_STOPPED'; }, 30);
        if (method !== 'GetSidecars') return {};
        return { sidecars: [
          { sidecarId: 'review-port/pane', status: paneStatus },
          { sidecarId: 'review-port-other/pane', status: 'SIDECAR_STATUS_RUNNING' },
        ] };
      };
      const execCalls = [];
      const res = await uninstallPlugin({
        pluginId: 'review-port', ...box, rpcFn, pollMs: 5,
        execFn: (cmd, args, opts) => {
          execCalls.push({ cmd, args, opts, paneStatus });
          execFn(cmd, args);
        },
      });

      assert.deepEqual(calls[0], { method: 'JetboxWriteState', body: { userConfig: { plugins: { 'review-port': { enabled: false } } } } });
      assert.deepEqual(calls.filter((c) => c.method === 'ManageSidecar').map((c) => c.body), [
        { action: 'SIDECAR_ACTION_DISABLE', sidecarId: 'review-port/pane' },
      ], "stops only this plugin's sidecars");
      assert.deepEqual(execCalls.map((c) => [c.cmd, ...c.args]), [['agy', 'plugin', 'uninstall', 'review-port']]);
      assert.equal(execCalls[0].paneStatus, 'SIDECAR_STATUS_STOPPED', 'agy runs once the sidecar has stopped');
      assert.equal(execCalls[0].opts.input, 'y\n', 'answers the y/N prompt the user already answered in Hangar');
      assert.equal(res.method, 'agy');
      assert.equal(existsSync(join(box.pluginsDir, 'review-port')), false);
      assert.deepEqual(readdirSync(box.packagesDir), []);
      assert.equal(loadHangarConfig(box.configPath).plugins['review-port'], undefined);
    } finally {
      box.cleanup();
    }
  });

  it('retries agy while a folder is in use, keeps the record when agy fails or leaves the folder, deletes the folder itself without agy, and refuses plugins Hangar did not install', async () => {
    const box = sandbox();
    try {
      const execFn = fakeExec(box, CLAUDE_SOURCE);
      await installRemotePlugin({ ...portRequest(box), porter: fakePorter(), rpcFn: async () => ({}), execFn });
      const { rpcFn } = recordingRpc();
      const opts = { pluginId: 'review-port', ...box, rpcFn, retryMs: 0 };
      const inUse = () => { throw Object.assign(new Error('exit 1'), { stderr: 'plugin is in use by another process' }); };
      let attempts = 0;
      await assert.rejects(uninstallPlugin({ ...opts, execFn: () => { attempts++; inUse(); } }), /in use by another process/);
      assert.equal(attempts, 3, 'gives up after three tries');

      const failing = () => { throw Object.assign(new Error('exit 1'), { stderr: 'unknown error' }); };
      await assert.rejects(uninstallPlugin({ ...opts, execFn: failing }), /agy plugin uninstall failed: unknown error/);
      await assert.rejects(uninstallPlugin({ ...opts, execFn: () => '' }), /is still there/);
      assert.ok(loadHangarConfig(box.configPath).plugins['review-port'], 'a failed uninstall keeps the record, so it can be retried');
      assert.equal(existsSync(join(box.pluginsDir, 'review-port', 'plugin.json')), true);

      attempts = 0;
      const res = await uninstallPlugin({ ...opts, execFn: (cmd, args) => (++attempts === 1 ? inUse() : execFn(cmd, args)) });
      assert.equal(res.method, 'agy', 'succeeds once the folder is free');
      assert.equal(attempts, 2);

      await installRemotePlugin({ ...portRequest(box), porter: fakePorter(), rpcFn: async () => ({}), execFn });
      const noAgy = () => { throw Object.assign(new Error('spawn agy ENOENT'), { code: 'ENOENT' }); };
      assert.equal((await uninstallPlugin({ ...opts, execFn: noAgy })).method, 'removed');
      assert.equal(existsSync(join(box.pluginsDir, 'review-port')), false);

      writeTree(join(box.pluginsDir, 'theirs'), { 'plugin.json': '{"name":"theirs"}' });
      await assert.rejects(uninstallPlugin({ ...opts, pluginId: 'theirs', execFn: noAgy }), /Hangar didn't install the plugin "theirs"/);
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
            hooksJson: '{"guard":{"PreToolUse":[{"command":"echo 1"}]},"start":{"SessionStart":[{"command":"echo 2"}]}}',
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

  it('countPluginHooks sums lifecycle event arrays inside named-group and wrapper hooks.json', () => {
    const namedGroup = JSON.stringify({
      'soc-gate': {
        PreToolUse: [{ matcher: 'call_mcp_tool', hooks: [{ type: 'command', command: 'echo 1' }] }],
        PostToolUse: [{ matcher: 'call_mcp_tool', hooks: [{ type: 'command', command: 'echo 2' }] }],
      },
    });
    assert.equal(countPluginHooks(namedGroup), 2);

    const wrapperHooks = JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: 'run_command', hooks: [{ type: 'command', command: 'echo 1' }] },
          { matcher: 'edit_file', hooks: [{ type: 'command', command: 'echo 2' }] },
        ],
        PostToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: 'echo 3' }] }],
      },
    });
    assert.equal(countPluginHooks(wrapperHooks), 3);
    assert.equal(reducePlugin({ name: 'soc-gate', path: '/plugins/soc-gate', hooksJson: namedGroup }).counts.hooks, 2);
  });

  it('inspectInstalledPluginHealth reports missing stdio binaries and unconfigured ${VAR} placeholders without leaking values', () => {
    const box = sandbox();
    try {
      writeTree(join(box.pluginsDir, 'dynatrace'), {
        'plugin.json': JSON.stringify({ name: 'dynatrace', version: '1.0.0' }),
        'mcp_config.json': JSON.stringify({
          mcpServers: {
            'dt-stdio': {
              command: 'nonexistent-bin-xyz',
              args: ['--token', '${DT_PLATFORM_TOKEN}', '--root', '${PLUGIN_ROOT}'],
              env: {
                DT_ENV_URL: '${DT_ENV_URL}',
                CONFIGURED_SECRET: '${CONFIGURED_SECRET}',
              },
            },
            'dt-node': {
              command: 'node',
              args: ['server.mjs'],
            },
            'dt-http': {
              serverUrl: 'https://mcp.dynatrace.example/sse',
              headers: {
                Authorization: 'Bearer ${DT_PLATFORM_TOKEN}',
                'X-Api-Key': '${CONFIGURED_SECRET}',
              },
            },
          },
        }),
        'hooks/hooks.json': JSON.stringify({
          hooks: {
            PreToolUse: [
              {
                matcher: 'call_mcp_tool',
                hooks: [{ type: 'command', command: 'node ./scripts/guard.mjs' }],
              },
            ],
          },
        }),
      });

      const diag = inspectInstalledPluginHealth(box.pluginsDir, {
        DT_PLATFORM_TOKEN: '',
        DT_ENV_URL: '   ',
        CONFIGURED_SECRET: 'top-secret-token-value-do-not-leak',
      });

      assert.equal(diag.length, 1);
      assert.equal(diag[0].id, 'dynatrace');
      const [stdioSrv, nodeSrv, httpSrv] = diag[0].mcpServers;
      assert.equal(stdioSrv.key, 'dt-stdio');
      assert.equal(stdioSrv.transport, 'stdio');
      assert.equal(stdioSrv.commandExists, false);
      assert.deepEqual(stdioSrv.missingEnvVars, ['DT_PLATFORM_TOKEN', 'DT_ENV_URL']);

      assert.equal(nodeSrv.key, 'dt-node');
      assert.equal(nodeSrv.transport, 'stdio');
      assert.equal(nodeSrv.commandExists, true);
      assert.deepEqual(nodeSrv.missingEnvVars, []);

      assert.equal(httpSrv.key, 'dt-http');
      assert.equal(httpSrv.transport, 'http');
      assert.equal(httpSrv.commandExists, null);
      assert.deepEqual(httpSrv.missingEnvVars, ['DT_PLATFORM_TOKEN']);

      assert.deepEqual(diag[0].hooks, [
        { event: 'PreToolUse', matcher: 'call_mcp_tool', command: 'node ./scripts/guard.mjs' },
      ]);
      assert.equal(JSON.stringify(diag).includes('top-secret-token-value-do-not-leak'), false);
    } finally {
      box.cleanup();
    }
  });

  it('runs lintPluginOrSidecar with autofix before auditPlugin and persists lintReport in .hangar-receipt.json', async () => {
    const box = sandbox();
    try {
      let auditedMcp = null;
      let auditedHooks = null;
      let auditedRule = null;
      const porter = {
        portPackage: async () => { throw new Error('should not port native plugin'); },
        auditPlugin: (dir) => {
          auditedMcp = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8'));
          auditedHooks = JSON.parse(readFileSync(join(dir, 'hooks.json'), 'utf8'));
          auditedRule = readFileSync(join(dir, 'rules', 'AGENTS.md'), 'utf8');
          const flags = [];
          if (auditedMcp.mcpServers?.demo?.url) {
            flags.push({ kind: 'legacy-mcp-url', severity: 'medium', file: '.mcp.json', line: 1 });
          }
          return { flags, warnings: [], tier: 'TIER_1_TELEMETRY', reasons: [] };
        },
      };

      const res = await installRemotePlugin({
        pluginId: 'autofix-native',
        gitRepo: 'acme/autofix-native',
        ref: 'v1.0.0',
        acceptedTier: 'TIER_1_TELEMETRY',
        packagesDir: box.packagesDir,
        pluginsDir: box.pluginsDir,
        configPath: box.configPath,
        porter,
        rpcFn: async () => ({}),
        execFn: fakeExec(box, {
          'plugin.json': JSON.stringify({ name: 'autofix-native', version: '1.0.0' }),
          '.mcp.json': JSON.stringify({ demo: { url: 'https://mcp.example.com/sse' } }),
          'hooks.json': JSON.stringify({
            hooks: {
              PreToolUse: [{ matcher: 'mcp__demo', hooks: [{ type: 'command', command: 'node ./ok.mjs' }] }],
            },
          }),
          'rules/AGENTS.md': 'Run ${CLAUDE_PLUGIN_ROOT}/scripts/helper.mjs first.',
        }),
        pollMs: 1,
        maxWaitMs: 1,
      });

      assert.equal(res.ok, true);
      assert.equal(auditedMcp.mcpServers.demo.serverUrl, 'https://mcp.example.com/sse');
      assert.equal('url' in auditedMcp.mcpServers.demo, false);
      assert.equal(auditedHooks.hooks.PreToolUse[0].matcher, 'call_mcp_tool|mcp_demo|mcp_tool');
      assert.equal(auditedRule, 'Run ./scripts/helper.mjs first.');
      assert.ok(res.lintReport);
      assert.equal(res.lintReport.valid, true);
      assert.ok(res.lintReport.fixedCount >= 4);

      const receiptPath = join(box.pluginsDir, 'autofix-native', '.hangar-receipt.json');
      assert.equal(existsSync(receiptPath), true);
      const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
      assert.equal(receipt.pluginId, 'autofix-native');
      assert.deepEqual(receipt.lintReport, res.lintReport);
    } finally {
      box.cleanup();
    }
  });

  it('re-runs auditPlugin after lintPluginOrSidecar autofixes ported plugins and preserves unicode-tags-stripped flags (HUB-03, XREPO-01, XREPO-05)', async () => {
    const box = sandbox();
    try {
      const unicodeFlag = { kind: 'unicode-tags-stripped', severity: 'high', file: 'skills/review/SKILL.md', line: 1 };
      const postFixFlag = { kind: 'env-dump', severity: 'high', file: 'mcp_config.json', line: 1 };
      const porter = {
        portPackage: async ({ outDir, slug }) => {
          writeTree(outDir, {
            'plugin.json': JSON.stringify({ name: slug, version: '1.0.0' }),
            // Bare mcp_config.json before autofix wraps it into { mcpServers: { ... } }
            'mcp_config.json': JSON.stringify({ supabase: { command: 'npx', args: ['-y', '@supabase/mcp'] } }),
          });
          return {
            report: {
              slug,
              ecosystems: ['claude'],
              ported: ['mcp:supabase'],
              unported: [],
              warnings: [],
              flags: [unicodeFlag],
              tier: 'TIER_1_TELEMETRY',
              tierReasons: [],
            },
            tier: 'TIER_1_TELEMETRY',
          };
        },
        auditPlugin: (dir) => {
          const mcp = JSON.parse(readFileSync(join(dir, 'mcp_config.json'), 'utf8'));
          const hasWrappedMcp = Boolean(mcp.mcpServers?.supabase);
          return {
            flags: hasWrappedMcp ? [postFixFlag] : [],
            warnings: [],
            tier: hasWrappedMcp ? 'TIER_2_LOCAL_TOOLING' : 'TIER_1_TELEMETRY',
            reasons: hasWrappedMcp ? ['mcp_config.json: 1 MCP server (supabase)'] : [],
          };
        },
      };

      const refused = await installRemotePlugin({
        ...portRequest(box, { acceptedTier: 'TIER_1_TELEMETRY' }),
        porter,
        rpcFn: async () => ({}),
        execFn: fakeExec(box, CLAUDE_SOURCE),
      });
      assert.equal(refused.needsConsent, true, 'autofixed mcpServers escalation must require consent');
      assert.equal(refused.scannedTier, 'TIER_2_LOCAL_TOOLING');
      assert.deepEqual(refused.report.flags, [unicodeFlag, postFixFlag]);
      assert.equal(refused.flagsDigest, flagsDigest([unicodeFlag, postFixFlag]));
    } finally {
      box.cleanup();
    }
  });

  it('HGR-AUD-07 & HGR-AUD-08: countPluginHooks returns 0 for empty event arrays and malformed JSON, and installers use removeLinkOrDir for staging cleanup', () => {
    assert.equal(countPluginHooks('{"hooks":{"PreToolUse":[],"PostToolUse":[]}}'), 0);
    assert.equal(countPluginHooks('{"guard":{"PreToolUse":[]}}'), 0);
    assert.equal(countPluginHooks('{malformed json'), 0);

    const pluginInstSrc = readFileSync(new URL('../lib/plugin-installer.mjs', import.meta.url), 'utf8');
    const pkgInstSrc = readFileSync(new URL('../lib/package-installer.mjs', import.meta.url), 'utf8');
    const remoteSrc = readFileSync(new URL('../lib/remote-source.mjs', import.meta.url), 'utf8');
    assert.equal(pluginInstSrc.includes('rmSync('), false, 'plugin-installer.mjs must use removeLinkOrDir instead of raw rmSync');
    assert.equal(pkgInstSrc.includes('rmSync('), false, 'package-installer.mjs must use removeLinkOrDir instead of raw rmSync');
    assert.equal(remoteSrc.includes('rmSync('), false, 'remote-source.mjs must use removeLinkOrDir instead of raw rmSync');
  });
});
