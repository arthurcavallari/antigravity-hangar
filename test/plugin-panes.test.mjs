import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { assertValidSidecarId, discoverPluginSidecarEntries } from '../lib/config-store.mjs';
import { checkCommandExists, inspectInstalledPluginHealth, isAuthorizedSidecarRequest } from '../lib/plugin-diagnostics.mjs';
import { enrichSidecarList, fetchHangarState, manageChildSidecar } from '../lib/state-orchestrator.mjs';

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui');

function loadPluginPanes() {
  const window = {};
  const ctx = vm.createContext({ window, document: {} });
  for (const rel of ['core.js', 'components/plugin-panes.js']) {
    vm.runInContext(readFileSync(join(UI_DIR, rel), 'utf8'), ctx, { filename: rel });
  }
  return window.Hangar;
}

function fakeEl() {
  const classes = new Set(['hidden']);
  return {
    dataset: {},
    innerHTML: '',
    textContent: '',
    disabled: false,
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
  };
}

function fakeCard() {
  const els = { btn: fakeEl(), consentBar: fakeEl(), consentText: fakeEl(), errorEl: fakeEl(), resets: [] };
  els.reset = (label) => els.resets.push(label);
  return { card: {}, els };
}

const PKG = {
  id: 'review-port',
  kind: 'plugin',
  latestVersion: '1.2.0',
  port: { from: 'claude' },
  release: { gitRepo: 'https://github.com/acme/plugins', ref: 'v1.2.0', path: 'plugins/review' },
};

describe('Hangar plugin panes', () => {
  it('shows what will and won\'t port before consent, escaping everything the upstream controls', () => {
    const ns = loadPluginPanes();
    const html = ns.pluginConsentHtml({
      scannedTier: 'TIER_2_LOCAL_TOOLING',
      report: {
        ecosystems: ['claude'],
        ported: ['skill:<b>review</b>'],
        unported: [{ item: 'hook:<img src=x onerror=alert(1)>', reason: 'no "UserPromptSubmit" event' }],
        flags: [{ kind: 'pipe-to-shell', severity: 'high', file: 'hooks/<x>.sh', line: 3 }],
        warnings: [],
        tierReasons: ['hooks: PreToolUse'],
      },
    });
    assert.match(html, /Tier 2 · Local CLI/);
    assert.match(html, /1 ported • 1 not ported • 1 audit finding</);
    assert.match(html, /<details class="port-report" open>/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.equal(html.includes('<img'), false);
    assert.equal(html.includes('<b>review'), false);
    assert.match(html, /hooks\/&lt;x&gt;\.sh:3/);
    assert.match(html, /lists a new plugin as soon as it is installed/);
    assert.equal(html.includes('loads new plugins when it starts'), false);
  });

  it('labels plugins, and ports with where they came from', () => {
    const ns = loadPluginPanes();
    assert.match(ns.pluginBadgesHtml({ port: { from: 'claude' } }), /Ported from Claude Code/);
    assert.match(ns.pluginBadgesHtml({ portedFrom: ['roo', 'cursor'] }), /Ported from Roo Code \+ Cursor/);
    assert.match(ns.pluginBadgesHtml({ port: { from: 'auto' } }), /Ported from another tool/);
    const native = ns.pluginBadgesHtml({ portedFrom: [] });
    assert.match(native, />Plugin</);
    assert.equal(native.includes('Ported'), false);
  });

  it('previews, then installs with exactly the tier and findings the user saw, asking again if they changed', async () => {
    const ns = loadPluginPanes();
    const { card, els } = fakeCard();
    const calls = [];
    const responses = [
      { scannedTier: 'TIER_2_LOCAL_TOOLING', flagsDigest: 'aaaa', report: { ecosystems: ['claude'], ported: ['skill:x'] } },
      { needsConsent: true, scannedTier: 'TIER_3_AGENT_CONTROL', flagsDigest: 'bbbb', report: { ecosystems: ['claude'] } },
      { ok: true, restartRequired: true },
    ];
    const ctx = {
      onPreviewPlugin: async (payload) => (calls.push(['preview', payload]), responses.shift()),
      onInstallPlugin: async (payload) => (calls.push(['install', payload]), responses.shift()),
      onSwitchTab: (tab) => calls.push(['tab', tab]),
    };

    await ns.previewPluginInstall(card, els, ctx, PKG);
    // The payload is built in the UI's vm realm, so compare it as plain JSON
    assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), ['preview', {
      pluginId: 'review-port', gitRepo: 'https://github.com/acme/plugins', tarballUrl: '', sha256: '',
      ref: 'v1.2.0', path: 'plugins/review', port: { from: 'claude' }, version: '1.2.0',
    }]);
    assert.equal(els.consentBar.classList.contains('hidden'), false);
    assert.match(els.consentText.innerHTML, /Port report/);

    await ns.confirmPluginInstall(card, els, ctx, PKG);
    assert.equal(calls[1][1].acceptedTier, 'TIER_2_LOCAL_TOOLING');
    assert.equal(calls[1][1].acceptedFlags, 'aaaa');
    assert.match(els.consentText.innerHTML, /Tier 3/, 'a changed scan is shown again before anything installs');
    assert.equal(els.consentBar.classList.contains('hidden'), false);

    await ns.confirmPluginInstall(card, els, ctx, PKG);
    assert.equal(calls[2][1].acceptedTier, 'TIER_3_AGENT_CONTROL');
    assert.equal(calls[2][1].acceptedFlags, 'bbbb');
    assert.deepEqual(calls[3], ['tab', 'installed']);
    assert.deepEqual(els.resets, ['Install', 'Install', 'Install']);
  });

  it('shows a failed preview on the card and offers a retry', async () => {
    const ns = loadPluginPanes();
    const { card, els } = fakeCard();
    await ns.previewPluginInstall(card, els, { onPreviewPlugin: async () => { throw new Error('agy not found'); } }, PKG);
    assert.equal(els.errorEl.textContent, 'agy not found');
    assert.equal(els.errorEl.classList.contains('hidden'), false);
    assert.deepEqual(els.resets, ['Retry Install']);
    // Without a preview there's nothing the user agreed to, so Confirm does nothing
    let installed = false;
    await ns.confirmPluginInstall(card, els, { onInstallPlugin: async () => { installed = true; } }, PKG);
    assert.equal(installed, false);
  });

  it('discoverPluginSidecarEntries finds multiple sidecars under sidecars/<subId>/sidecar.json, root sidecar.json, and plugin.json#sidecars', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'hangar-multi-sidecar-'));
    try {
      // 1. Multi-sidecar under sidecars/<subId>/sidecar.json (android-cli-plugin layout)
      const androidDir = join(tmp, 'android-cli-plugin');
      mkdirSync(join(androidDir, 'sidecars', 'compose-preview'), { recursive: true });
      mkdirSync(join(androidDir, 'sidecars', 'device-hub'), { recursive: true });
      writeFileSync(
        join(androidDir, 'plugin.json'),
        JSON.stringify({ name: 'android-cli-plugin', displayName: 'Android CLI' }),
        'utf8'
      );
      writeFileSync(
        join(androidDir, 'sidecars', 'compose-preview', 'sidecar.json'),
        JSON.stringify({ display_name: 'Android Compose Preview', has_web_ui: true }),
        'utf8'
      );
      writeFileSync(
        join(androidDir, 'sidecars', 'device-hub', 'sidecar.json'),
        JSON.stringify({ display_name: 'Android Device Hub', has_web_ui: true }),
        'utf8'
      );

      const androidEntries = discoverPluginSidecarEntries(androidDir, 'android-cli-plugin');
      assert.equal(androidEntries.length, 2);
      assert.deepEqual(
        androidEntries.map((e) => e.id).sort(),
        ['android-cli-plugin/compose-preview', 'android-cli-plugin/device-hub']
      );
      assert.ok(androidEntries.every((e) => e.parentPluginId === 'android-cli-plugin'));
      assert.ok(androidEntries.every((e) => e.sidecarDir && typeof e.config === 'object'));

      // 2. Relative paths in plugin.json#sidecars (including ./skills/<subId>/sidecar layout)
      const manifestListedDir = join(tmp, 'custom-multi');
      mkdirSync(join(manifestListedDir, 'skills', 'alpha', 'sidecar'), { recursive: true });
      mkdirSync(join(manifestListedDir, 'panes', 'beta'), { recursive: true });
      writeFileSync(
        join(manifestListedDir, 'plugin.json'),
        JSON.stringify({
          name: 'custom-multi',
          sidecars: ['./skills/alpha/sidecar', './panes/beta'],
        }),
        'utf8'
      );
      writeFileSync(
        join(manifestListedDir, 'skills', 'alpha', 'sidecar', 'sidecar.json'),
        JSON.stringify({ displayName: 'Alpha Pane', hasWebUi: true }),
        'utf8'
      );
      writeFileSync(
        join(manifestListedDir, 'panes', 'beta', 'sidecar.json'),
        JSON.stringify({ displayName: 'Beta Pane', hasWebUi: true }),
        'utf8'
      );

      const listedEntries = discoverPluginSidecarEntries(manifestListedDir, 'custom-multi');
      assert.equal(listedEntries.length, 2);
      assert.deepEqual(
        listedEntries.map((e) => e.id).sort(),
        ['custom-multi/alpha', 'custom-multi/beta']
      );
      assert.ok(listedEntries.every((e) => e.parentPluginId === 'custom-multi'));

      // 3. Single root sidecar.json gets id: <pluginId> and parentPluginId: <pluginId>
      const singleRootDir = join(tmp, 'single-root');
      mkdirSync(singleRootDir, { recursive: true });
      writeFileSync(
        join(singleRootDir, 'sidecar.json'),
        JSON.stringify({ displayName: 'Single Root Sidecar', hasWebUi: true }),
        'utf8'
      );
      const singleEntries = discoverPluginSidecarEntries(singleRootDir, 'single-root');
      assert.equal(singleEntries.length, 1);
      assert.equal(singleEntries[0].id, 'single-root');
      assert.equal(singleEntries[0].parentPluginId, 'single-root');
      assert.equal(singleEntries[0].sidecarDir, singleRootDir);
      assert.equal(singleEntries[0].config.displayName, 'Single Root Sidecar');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('state-orchestrator discovers all sub-sidecars from multi-sidecar plugins and syncs JetboxWriteState via parentPluginId', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'hangar-orch-multi-'));
    try {
      const pluginsDir = join(tmp, 'plugins');
      const androidDir = join(pluginsDir, 'android-cli-plugin');
      const cfgPath = join(tmp, 'hangar.json');
      mkdirSync(join(androidDir, 'sidecars', 'compose-preview'), { recursive: true });
      mkdirSync(join(androidDir, 'sidecars', 'device-hub'), { recursive: true });
      writeFileSync(
        join(androidDir, 'plugin.json'),
        JSON.stringify({ name: 'android-cli-plugin', displayName: 'Android CLI' }),
        'utf8'
      );
      writeFileSync(
        join(androidDir, 'sidecars', 'compose-preview', 'sidecar.json'),
        JSON.stringify({ display_name: 'Android Compose Preview', has_web_ui: true }),
        'utf8'
      );
      writeFileSync(
        join(androidDir, 'sidecars', 'device-hub', 'sidecar.json'),
        JSON.stringify({ display_name: 'Android Device Hub', has_web_ui: true }),
        'utf8'
      );

      const enriched = enrichSidecarList([], {}, {
        pluginsDir,
        sidecarsDir: join(tmp, 'sidecars'),
      });
      assert.deepEqual(
        enriched.map((s) => s.sidecarId).sort(),
        ['android-cli-plugin/compose-preview', 'android-cli-plugin/device-hub']
      );
      assert.ok(enriched.every((s) => s.parentPluginId === 'android-cli-plugin'));

      const rpcCalls = [];
      const rpcFn = async (method, payload) => {
        rpcCalls.push([method, payload]);
        if (method === 'GetAllPlugins') {
          return { plugins: [{ name: 'android-cli-plugin', path: androidDir }] };
        }
        return { sidecars: [], trajectorySummaries: {} };
      };

      const state = await fetchHangarState({
        configPath: cfgPath,
        sidecarsDir: join(tmp, 'sidecars'),
        pluginsDir,
        rpcFn,
      });
      assert.deepEqual(
        state.sidecars.map((s) => s.sidecarId).sort(),
        ['android-cli-plugin/compose-preview', 'android-cli-plugin/device-hub']
      );

      rpcCalls.length = 0;
      const entries = discoverPluginSidecarEntries(androidDir, 'android-cli-plugin');
      await manageChildSidecar('android-cli-plugin/compose-preview', 'SIDECAR_ACTION_DISABLE', {
        rpcFn,
        configPath: cfgPath,
        rawSidecars: entries,
        pollMs: 1,
        maxWaitMs: 10,
      });

      assert.deepEqual(rpcCalls, [
        ['JetboxWriteState', { userConfig: { plugins: { 'android-cli-plugin': { enabled: false } } } }],
        ['ManageSidecar', { action: 'SIDECAR_ACTION_DISABLE', sidecarId: 'android-cli-plugin/compose-preview' }],
      ]);

      // HUB-04: manageChildSidecar discovers a single-root plugin sidecar via pluginsDir even without rawSidecars
      const singleDir = join(pluginsDir, 'single-plugin');
      mkdirSync(singleDir, { recursive: true });
      writeFileSync(join(singleDir, 'plugin.json'), JSON.stringify({ name: 'single-plugin' }), 'utf8');
      writeFileSync(join(singleDir, 'sidecar.json'), JSON.stringify({ displayName: 'Single', hasWebUi: true }), 'utf8');
      rpcCalls.length = 0;
      await manageChildSidecar('single-plugin', 'SIDECAR_ACTION_DISABLE', {
        rpcFn,
        configPath: cfgPath,
        pluginsDir,
        pollMs: 1,
        maxWaitMs: 10,
      });
      assert.deepEqual(rpcCalls, [
        ['GetSidecars', {}],
        ['JetboxWriteState', { userConfig: { plugins: { 'single-plugin': { enabled: false } } } }],
        ['ManageSidecar', { action: 'SIDECAR_ACTION_DISABLE', sidecarId: 'single-plugin' }],
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('sanitizes invalid subSlugs, deduplicates colliding sidecar IDs, and blocks symlink escapes in discoverPluginSidecarEntries (HUB-05)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'hangar-discover-sec-'));
    try {
      const outsideDir = join(tmp, 'outside-secret');
      mkdirSync(outsideDir, { recursive: true });
      writeFileSync(join(outsideDir, 'sidecar.json'), JSON.stringify({ displayName: 'Escaped' }), 'utf8');

      const pluginDir = join(tmp, 'my-plugin');
      mkdirSync(join(pluginDir, 'sidecars', '_leading-underscore'), { recursive: true });
      mkdirSync(join(pluginDir, 'sidecars', 'viewer'), { recursive: true });
      mkdirSync(join(pluginDir, 'panes', 'viewer'), { recursive: true });
      writeFileSync(
        join(pluginDir, 'plugin.json'),
        JSON.stringify({ name: 'my-plugin', sidecars: ['./panes/viewer'] }),
        'utf8'
      );
      writeFileSync(
        join(pluginDir, 'sidecars', '_leading-underscore', 'sidecar.json'),
        JSON.stringify({ displayName: 'Underscore' }),
        'utf8'
      );
      writeFileSync(
        join(pluginDir, 'sidecars', 'viewer', 'sidecar.json'),
        JSON.stringify({ displayName: 'Viewer 1' }),
        'utf8'
      );
      writeFileSync(
        join(pluginDir, 'panes', 'viewer', 'sidecar.json'),
        JSON.stringify({ displayName: 'Viewer 2' }),
        'utf8'
      );
      symlinkSync(
        outsideDir,
        join(pluginDir, 'sidecars', 'escaped'),
        process.platform === 'win32' ? 'junction' : 'dir'
      );

      const entries = discoverPluginSidecarEntries(pluginDir, 'my-plugin');
      const ids = entries.map((e) => e.id);
      assert.deepEqual(ids, ['my-plugin/leading-underscore', 'my-plugin/viewer', 'my-plugin/viewer-2']);
      for (const id of ids) {
        assert.doesNotThrow(() => assertValidSidecarId(id));
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('handleHangarNavigateMessage accepts composite IDs, avoids toggling open storeView closed, and popped terminal rename targets focusedTerminalId (HUB-06, HUB-07, HUB-09, XREPO-04)', () => {
    let extBtnClicks = 0;
    let scrolledCard = null;
    const window = { location: { origin: 'http://127.0.0.1:51000' }, addEventListener() {} };
    const cards = {
      '.agy-card[data-plugin-dir="android-cli-plugin/device-hub"], .agy-card[data-plugin-id="android-cli-plugin/device-hub"], .agy-card[data-sidecar-id="android-cli-plugin/device-hub"], .agy-card[data-pkg-id="android-cli-plugin/device-hub"]': {
        scrollIntoView: () => { scrolledCard = 'android-cli-plugin/device-hub'; },
      },
    };
    const storeView = { classList: { contains: (c) => c !== 'hidden' ? false : false } };
    const document = {
      getElementById: (id) => {
        if (id === 'store-view') return storeView;
        if (id === 'extensions-toggle-btn') return { click: () => { extBtnClicks += 1; }, classList: { contains: () => false } };
        return null;
      },
      querySelector: (sel) => cards[sel] || null,
    };
    const ctx = vm.createContext({ window, document, URL });
    for (const rel of ['core.js', 'components/tab-bar.js']) {
      vm.runInContext(readFileSync(join(UI_DIR, rel), 'utf8'), ctx, { filename: rel });
    }
    const ns = window.Hangar;

    const handled = ns.handleHangarNavigateMessage({
      origin: 'http://127.0.0.1:51000',
      data: { type: 'hangar-navigate', sidecarId: 'android-cli-plugin/device-hub', targetTab: 'sidecars' },
    });
    assert.equal(handled, true);
    assert.equal(extBtnClicks, 0, 'must not click #extensions-toggle-btn when #store-view is already visible');
    assert.equal(scrolledCard, 'android-cli-plugin/device-hub');

    // HUB-09: partitionSplitTabs exposes focusedTerminalId on popped terminal tabs
    ns.getPoppedTerminalIds = () => new Set(['term-root']);
    ns.readTabGroups = () => [{ groupId: 'g1', paneIds: ['term-root', 'term-split-2'], focusedPaneId: 'term-split-2' }];
    ns.getActiveGroupId = () => 'g1';
    ns.readCustomTermTitles = () => ({ 'term-split-2': 'Focused Split Title' });
    const part = ns.partitionSplitTabs(
      [],
      {},
      [
        { terminalId: 'term-root', title: 'pwsh' },
        { terminalId: 'term-split-2', title: 'pwsh' },
      ]
    );
    const poppedTab = part.workspaceTabs.find((t) => t.sidecarId === 'terminal__term-root');
    assert.ok(poppedTab);
    assert.equal(poppedTab.focusedTerminalId, 'term-split-2');
    assert.equal(poppedTab.displayName, 'Focused Split Title');

    // HUB-07: inspectInstalledPluginHealth ignores bare .mcp.json $schema/version metadata and expands ${extensionPath}
    const tmp = mkdtempSync(join(tmpdir(), 'hangar-diag-meta-'));
    try {
      const pDir = join(tmp, 'ext-plugin');
      mkdirSync(join(pDir, 'bin'), { recursive: true });
      const binFile = join(pDir, 'bin', 'runner.mjs');
      writeFileSync(binFile, '// runner', 'utf8');
      writeFileSync(
        join(pDir, '.mcp.json'),
        JSON.stringify({
          $schema: 'https://modelcontextprotocol.io/schema.json',
          version: '1.0',
          localRunner: {
            command: '${extensionPath}${/}bin/runner.mjs',
            args: ['--ws', '${workspaceFolder}'],
          },
        }),
        'utf8'
      );
      const health = inspectInstalledPluginHealth(tmp, {});
      assert.equal(health.length, 1);
      assert.equal(health[0].healthy, true);
      assert.equal(health[0].mcpServers.length, 1);
      assert.equal(health[0].mcpServers[0].key, 'localRunner');
      assert.equal(health[0].mcpServers[0].commandExists, true);
      assert.deepEqual(health[0].mcpServers[0].missingEnvVars, []);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('HGR-AUD-01: enforces isAuthorizedSidecarRequest on /api/plugins/diagnostics, attaches diagnostics in /api/state, and sends X-Sidecar-Token in apiCall', async () => {
    const serverSrc = readFileSync(join(UI_DIR, '..', 'server.mjs'), 'utf8');
    assert.match(serverSrc, /isAuthorizedSidecarRequest/);

    const prevToken = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN;
    process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN = 'diag-secret-token-777';
    try {
      assert.equal(isAuthorizedSidecarRequest({ headers: { origin: 'https://evil.example', 'x-sidecar-token': 'diag-secret-token-777' } }), false);
      assert.equal(isAuthorizedSidecarRequest({ headers: { origin: 'http://127.0.0.1:51000' } }), false);
      assert.equal(isAuthorizedSidecarRequest({ headers: { origin: 'http://127.0.0.1:51000', 'x-sidecar-token': 'wrong' } }), false);
      assert.equal(isAuthorizedSidecarRequest({ headers: { origin: 'http://127.0.0.1:51000', 'x-sidecar-token': 'diag-secret-token-777' } }), true);
      assert.equal(isAuthorizedSidecarRequest({ query: { token: 'diag-secret-token-777' } }), true);
    } finally {
      if (prevToken === undefined) delete process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN;
      else process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN = prevToken;
    }

    const tmp = mkdtempSync(join(tmpdir(), 'hangar-diag-state-'));
    try {
      const pluginsDir = join(tmp, 'plugins');
      const pDir = join(pluginsDir, 'broken-plugin');
      mkdirSync(pDir, { recursive: true });
      writeFileSync(join(pDir, 'plugin.json'), JSON.stringify({ name: 'broken-plugin' }), 'utf8');
      writeFileSync(
        join(pDir, 'mcp_config.json'),
        JSON.stringify({
          mcpServers: {
            'missing-cli': {
              command: 'definitely-not-installed-binary-xyz',
              env: { REQUIRED_TOKEN: '${REQUIRED_TOKEN}' },
            },
          },
        }),
        'utf8'
      );

      const state = await fetchHangarState({
        configPath: join(tmp, 'hangar.json'),
        sidecarsDir: join(tmp, 'sidecars'),
        pluginsDir,
        rpcFn: async (method) => {
          if (method === 'GetAllPlugins') {
            return { plugins: [{ name: 'broken-plugin', path: pDir }] };
          }
          return { sidecars: [], trajectorySummaries: {} };
        },
      });
      assert.equal(state.plugins.length, 1);
      assert.ok(state.plugins[0].diagnostics, 'plugin entry in /api/state must include diagnostics');
      assert.equal(state.plugins[0].diagnostics.healthy, false);
      assert.ok(Array.isArray(state.pluginDiagnostics));
      assert.equal(state.pluginDiagnostics.length, 1);

      let fetchHeaders = null;
      const win = {
        location: { search: '?token=url-tok-42', origin: 'http://127.0.0.1:51000' },
        fetch: async (_url, init) => {
          fetchHeaders = init.headers;
          return { ok: true, json: async () => ({ ok: true }) };
        },
        addEventListener() {},
      };
      const vmCtx = vm.createContext({ window: win, document: {}, URL, URLSearchParams });
      vm.runInContext(readFileSync(join(UI_DIR, 'core.js'), 'utf8'), vmCtx, { filename: 'core.js' });
      await win.Hangar.apiCall('/api/state', {});
      assert.equal(fetchHeaders['X-Sidecar-Token'], 'url-tok-42');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('HGR-AUD-02: handleHangarNavigateMessage activates .agy-tab via click listener when #store-view is hidden and highlights target card', () => {
    let selectedTopTab = '';
    let scrolledId = '';
    const cardClasses = new Set();
    const storeClasses = new Set(['hidden']);
    const extTabListeners = new Map();

    const targetCard = {
      dataset: { pluginDir: 'science-dir', pluginId: 'science', sidecarId: 'science/viewer' },
      classList: {
        add: (c) => cardClasses.add(c),
        remove: (c) => cardClasses.delete(c),
        contains: (c) => cardClasses.has(c),
      },
      scrollIntoView: () => { scrolledId = 'science/viewer'; },
    };

    const window = { location: { origin: 'http://127.0.0.1:51000' }, addEventListener() {} };
    const makeEl = (tag) => {
      const classes = new Set();
      const listeners = new Map();
      const children = [];
      const el = {
        tagName: tag.toUpperCase(),
        type: '',
        className: '',
        dataset: {},
        style: {},
        children,
        append: (...nodes) => children.push(...nodes),
        appendChild: (n) => { children.push(n); return n; },
        remove: () => {},
        scrollIntoView: () => {},
        setAttribute() {},
        addEventListener: (ev, fn) => {
          if (!listeners.has(ev)) listeners.set(ev, []);
          listeners.get(ev).push(fn);
          if (el.dataset?.sidecarId === '__extensions__') extTabListeners.set(ev, listeners.get(ev));
        },
        click: () => {
          for (const fn of listeners.get('click') || []) {
            fn({ detail: 0, stopPropagation() {}, preventDefault() {}, target: el });
          }
        },
        querySelector: () => makeEl('span'),
        classList: {
          add: (...cs) => cs.forEach((c) => classes.add(c)),
          remove: (...cs) => cs.forEach((c) => classes.delete(c)),
          toggle: (c, force) => (force ? classes.add(c) : classes.delete(c)),
          contains: (c) => classes.has(c),
        },
      };
      return el;
    };

    let extTabBtn = null;
    const document = {
      createElement: (tag) => makeEl(tag),
      getElementById: (id) => {
        if (id === 'store-view') {
          return {
            classList: {
              contains: (c) => storeClasses.has(c),
              remove: (c) => storeClasses.delete(c),
            },
          };
        }
        return null;
      },
      querySelector: (sel) => {
        if (sel === '.agy-tab[data-sidecar-id="__extensions__"]') return extTabBtn;
        if (sel.includes('science/viewer') || sel.includes('science')) {
          return storeClasses.has('hidden') ? null : targetCard;
        }
        return null;
      },
      querySelectorAll: () => [],
    };

    const ctx = vm.createContext({ window, document, URL, URLSearchParams, CSS: { escape: (s) => s } });
    for (const rel of ['core.js', 'components/tab-bar.js', 'components/plugin-panes.js']) {
      vm.runInContext(readFileSync(join(UI_DIR, rel), 'utf8'), ctx, { filename: rel });
    }
    const ns = window.Hangar;

    // Render top tab bar to construct a real .agy-tab button for __extensions__
    const stripEl = makeEl('div');
    stripEl.querySelector = () => null;
    stripEl.querySelectorAll = (sel) =>
      sel === '.agy-tab[data-sidecar-id]'
        ? stripEl.children.filter((c) => c.dataset?.sidecarId)
        : [];
    stripEl.insertBefore = (node) => { if (!stripEl.children.includes(node)) stripEl.children.push(node); };
    ns.renderTabBar({
      tabStripEl: stripEl,
      sidecars: [],
      terminals: [],
      layout: { pinnedTopSidecarId: 'context-monitor', splitViewEnabled: false },
      onSelectTopSplitTab: (id) => {
        selectedTopTab = id;
        if (id === '__extensions__') storeClasses.delete('hidden');
      },
    });
    extTabBtn = stripEl.children.find((c) => c.dataset?.sidecarId === '__extensions__');
    assert.ok(extTabBtn, '__extensions__ tab button must be created');

    const handled = ns.handleHangarNavigateMessage({
      origin: 'http://127.0.0.1:52320',
      data: {
        type: 'hangar-navigate',
        tab: 'plugins',
        pluginId: 'science',
        targetId: 'science/viewer',
      },
    });
    assert.equal(handled, true);
    assert.equal(selectedTopTab, '__extensions__', 'clicking .agy-tab must activate __extensions__');
    assert.equal(storeClasses.has('hidden'), false, '#store-view must be opened before querying cards');
    assert.equal(scrolledId, 'science/viewer', 'must scroll target card into view');
    assert.equal(cardClasses.has('agy-card-highlight'), true, 'must highlight target card');
  });

  it('HGR-AUD-06: plugin-diagnostics handles ${VAR:-default} fallbacks, empty env keys, multi-token commands, and nested hooks.hooks groups', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'hangar-diag-edge-'));
    try {
      const pDir = join(tmp, 'edge-plugin');
      mkdirSync(join(pDir, 'bin'), { recursive: true });
      const ext = process.platform === 'win32' ? '.cmd' : '';
      writeFileSync(join(pDir, 'bin', `my-runner${ext}`), 'echo ok', 'utf8');

      writeFileSync(
        join(pDir, 'mcp_config.json'),
        JSON.stringify({
          mcpServers: {
            'edge-srv': {
              command: '"${PLUGIN_ROOT}/bin/my-runner" --stdio',
              args: ['--region', '${AWS_REGION:-us-east-1}', '--empty-default', '${EMPTY_DEF:-}'],
              env: {
                EMPTY_REQUIRED_SECRET: '',
                SET_SECRET: 'configured-value',
              },
            },
          },
        }),
        'utf8'
      );
      writeFileSync(
        join(pDir, 'hooks.json'),
        JSON.stringify({
          hooks: {
            'security-group': {
              PreToolUse: [
                {
                  matcher: 'run_command',
                  hooks: [{ type: 'command', command: 'node ./guard.mjs' }],
                },
              ],
            },
          },
        }),
        'utf8'
      );

      assert.equal(checkCommandExists('node --version', {}, pDir), true);
      const res = inspectInstalledPluginHealth(tmp, {});
      assert.equal(res.length, 1);
      const srv = res[0].mcpServers[0];
      assert.equal(srv.commandExists, true, 'must resolve quoted multi-token command and platform ext');
      assert.equal(srv.missingEnvVars.includes('AWS_REGION'), false, '${AWS_REGION:-us-east-1} has non-empty fallback');
      assert.equal(srv.missingEnvVars.includes('EMPTY_DEF'), true, '${EMPTY_DEF:-} has empty fallback and is unset');
      assert.equal(srv.missingEnvVars.includes('EMPTY_REQUIRED_SECRET'), true, 'empty string env value must be flagged when unset in env');
      assert.equal(res[0].hooks.length, 1, 'must extract hooks from nested hooks.hooks named groups');
      assert.equal(res[0].hooks[0].event, 'PreToolUse');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
