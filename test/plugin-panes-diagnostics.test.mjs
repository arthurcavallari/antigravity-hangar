import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { buildAgyUiJs } from 'antigravity-sidecar-kit';
import { checkCommandExists, inspectInstalledPluginHealth, isAuthorizedSidecarRequest } from '../lib/plugin-diagnostics.mjs';
import { fetchHangarState } from '../lib/state-orchestrator.mjs';

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui');

describe('Hangar navigate messages, popped terminal focus, and plugin diagnostics', () => {
  it('handleHangarNavigateMessage accepts composite IDs, avoids toggling open storeView closed, and popped terminal rename targets focusedTerminalId (HUB-06, HUB-07, HUB-09, XREPO-04)', () => {
    let extBtnClicks = 0;
    let scrolledCard = null;
    const window = { location: { origin: 'http://127.0.0.1:51000' }, addEventListener() {} };
    const cardSel = '.agy-card[data-plugin-dir="android-cli-plugin/device-hub"], .agy-card[data-plugin-id="android-cli-plugin/device-hub"], .agy-card[data-sidecar-id="android-cli-plugin/device-hub"], .agy-card[data-pkg-id="android-cli-plugin/device-hub"]';
    const cards = { [cardSel]: { scrollIntoView: () => (scrolledCard = 'android-cli-plugin/device-hub') } };
    const storeView = { classList: { contains: () => false } };
    const document = {
      getElementById: (id) => {
        if (id === 'store-view') return storeView;
        if (id === 'extensions-toggle-btn') return { click: () => (extBtnClicks += 1), classList: { contains: () => false } };
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
    assert.equal(extBtnClicks, 0);
    assert.equal(scrolledCard, 'android-cli-plugin/device-hub');

    ns.getPoppedTerminalIds = () => new Set(['term-root']);
    ns.readTabGroups = () => [{ groupId: 'g1', paneIds: ['term-root', 'term-split-2'], focusedPaneId: 'term-split-2' }];
    ns.getActiveGroupId = () => 'g1';
    ns.readCustomTermTitles = () => ({ 'term-split-2': 'Focused Split Title' });
    const part = ns.partitionSplitTabs([], {}, [{ terminalId: 'term-root', title: 'pwsh' }, { terminalId: 'term-split-2', title: 'pwsh' }]);
    const poppedTab = part.workspaceTabs.find((t) => t.sidecarId === 'terminal__term-root');
    assert.ok(poppedTab);
    assert.equal(poppedTab.focusedTerminalId, 'term-split-2');
    assert.equal(poppedTab.displayName, 'Focused Split Title');

    const tmp = mkdtempSync(join(tmpdir(), 'hangar-diag-meta-'));
    try {
      const pDir = join(tmp, 'ext-plugin');
      mkdirSync(join(pDir, 'bin'), { recursive: true });
      writeFileSync(join(pDir, 'bin', 'runner.mjs'), '// runner', 'utf8');
      writeFileSync(join(pDir, '.mcp.json'), JSON.stringify({
        $schema: 'https://modelcontextprotocol.io/schema.json', version: '1.0',
        localRunner: { command: '${extensionPath}${/}bin/runner.mjs', args: ['--ws', '${workspaceFolder}'] },
      }), 'utf8');
      const health = inspectInstalledPluginHealth(tmp, {});
      assert.equal(health.length, 1);
      assert.equal(health[0].healthy, true);
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
      writeFileSync(join(pDir, 'mcp_config.json'), JSON.stringify({
        mcpServers: { 'missing-cli': { command: 'definitely-not-installed-binary-xyz', env: { REQUIRED_TOKEN: '${REQUIRED_TOKEN}' } } },
      }), 'utf8');
      const state = await fetchHangarState({
        configPath: join(tmp, 'hangar.json'), sidecarsDir: join(tmp, 'sidecars'), pluginsDir,
        rpcFn: async (method) => (method === 'GetAllPlugins' ? { plugins: [{ name: 'broken-plugin', path: pDir }] } : { sidecars: [], trajectorySummaries: {} }),
      });
      assert.equal(state.plugins.length, 1);
      assert.equal(state.plugins[0].diagnostics?.healthy, false);
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
    const targetCard = {
      dataset: { pluginDir: 'science-dir', pluginId: 'science', sidecarId: 'science/viewer' },
      classList: { add: (c) => cardClasses.add(c), remove: (c) => cardClasses.delete(c), contains: (c) => cardClasses.has(c) },
      scrollIntoView: () => {
        scrolledId = 'science/viewer';
      },
    };
    const window = { location: { origin: 'http://127.0.0.1:51000' }, addEventListener() {} };
    const makeEl = (tag) => {
      const classes = new Set();
      const listeners = new Map();
      const children = [];
      const el = {
        tagName: tag.toUpperCase(), type: '', className: '', dataset: {}, style: {}, children,
        append: (...nodes) => children.push(...nodes),
        appendChild: (n) => {
          children.push(n);
          return n;
        },
        insertBefore: (n) => {
          if (!children.includes(n)) children.push(n);
          return n;
        },
        remove: () => {}, scrollIntoView: () => {}, setAttribute() {},
        addEventListener: (ev, fn) => {
          if (!listeners.has(ev)) listeners.set(ev, []);
          listeners.get(ev).push(fn);
        },
        click: () => {
          for (const fn of listeners.get('click') || []) fn({ detail: 0, stopPropagation() {}, preventDefault() {}, target: el });
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
      getElementById: (id) => (id === 'store-view' ? { classList: { contains: (c) => storeClasses.has(c), remove: (c) => storeClasses.delete(c) } } : null),
      querySelector: (sel) => {
        if (sel === '.agy-tab[data-sidecar-id="__extensions__"]') return extTabBtn;
        if (sel.includes('science/viewer') || sel.includes('science')) return storeClasses.has('hidden') ? null : targetCard;
        return null;
      },
      querySelectorAll: () => [],
    };
    const ctx = vm.createContext({ window: Object.assign(window, { document }), document, URL, URLSearchParams, CSS: { escape: (s) => s } });
    vm.runInContext(buildAgyUiJs('all'), ctx, { filename: 'ui.js' });
    for (const rel of ['core.js', 'components/tab-bar.js', 'components/plugin-panes.js']) {
      vm.runInContext(readFileSync(join(UI_DIR, rel), 'utf8'), ctx, { filename: rel });
    }
    const ns = window.Hangar;
    const stripEl = makeEl('div');
    stripEl.querySelector = () => null;
    stripEl.querySelectorAll = (sel) => (sel === '.agy-tab[data-sidecar-id]' ? stripEl.children.filter((c) => c.dataset?.sidecarId) : []);
    ns.renderTabBar({
      tabStripEl: stripEl, sidecars: [], terminals: [], layout: { pinnedTopSidecarId: 'context-monitor', splitViewEnabled: false },
      onSelectTopSplitTab: (id) => {
        selectedTopTab = id;
        if (id === '__extensions__') storeClasses.delete('hidden');
      },
    });
    extTabBtn = stripEl.children.find((c) => c.dataset?.sidecarId === '__extensions__');
    assert.ok(extTabBtn);
    const handled = ns.handleHangarNavigateMessage({
      origin: 'http://127.0.0.1:52320',
      data: { type: 'hangar-navigate', tab: 'plugins', pluginId: 'science', targetId: 'science/viewer' },
    });
    assert.equal(handled, true);
    assert.equal(selectedTopTab, '__extensions__');
    assert.equal(storeClasses.has('hidden'), false);
    assert.equal(scrolledId, 'science/viewer');
    assert.equal(cardClasses.has('agy-card-highlight'), true);
  });

  it('HGR-AUD-06: plugin-diagnostics handles ${VAR:-default} fallbacks, empty env keys, multi-token commands, and nested hooks.hooks groups', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'hangar-diag-edge-'));
    try {
      const pDir = join(tmp, 'edge-plugin');
      mkdirSync(join(pDir, 'bin'), { recursive: true });
      const ext = process.platform === 'win32' ? '.cmd' : '';
      writeFileSync(join(pDir, 'bin', `my-runner${ext}`), 'echo ok', 'utf8');
      writeFileSync(join(pDir, 'mcp_config.json'), JSON.stringify({
        mcpServers: {
          'edge-srv': {
            command: '"${PLUGIN_ROOT}/bin/my-runner" --stdio',
            args: ['--region', '${AWS_REGION:-us-east-1}', '--empty-default', '${EMPTY_DEF:-}'],
            env: { EMPTY_REQUIRED_SECRET: '', SET_SECRET: 'configured-value' },
          },
        },
      }), 'utf8');
      writeFileSync(join(pDir, 'hooks.json'), JSON.stringify({
        hooks: { 'security-group': { PreToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: 'node ./guard.mjs' }] }] } },
      }), 'utf8');
      assert.equal(checkCommandExists('node --version', {}, pDir), true);
      const res = inspectInstalledPluginHealth(tmp, {});
      assert.equal(res.length, 1);
      const srv = res[0].mcpServers[0];
      assert.equal(srv.commandExists, true);
      assert.equal(srv.missingEnvVars.includes('AWS_REGION'), false);
      assert.equal(srv.missingEnvVars.includes('EMPTY_DEF'), true);
      assert.equal(srv.missingEnvVars.includes('EMPTY_REQUIRED_SECRET'), true);
      assert.equal(res[0].hooks.length, 1);
      assert.equal(res[0].hooks[0].event, 'PreToolUse');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
