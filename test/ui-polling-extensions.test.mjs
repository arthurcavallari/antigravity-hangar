import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { buildAgyUiJs } from 'antigravity-sidecar-kit/ui';

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

describe('Hangar Extensions tab and Settings pane', () => {
  it('renders Auto-Sleep, active workspace, and workspace suggestions inside Extensions tab without top-left popover', async () => {
    const indexHtml = readFileSync(join(UI_DIR, 'index.html'), 'utf8');
    assert.equal(indexHtml.includes('workspace-pill'), false);
    assert.equal(indexHtml.includes('project-popover'), false);

    const { window, document, CustomEvent, HTMLElement, DocumentFragment, Node } = parseHTML('<!DOCTYPE html><html><body></body></html>');
    const CSS = { escape: (s) => String(s) };
    window.CSS = CSS;
    const ctx = vm.createContext({ window, document, CustomEvent, HTMLElement, DocumentFragment, Node, CSS });
    vm.runInContext(buildAgyUiJs('all'), ctx, { filename: 'ui.js' });
    for (const rel of ['core.js', 'components/plugin-panes.js', 'components/marketplace-panes.js', 'components/installed-pane.js', 'components/extensions-tab.js']) {
      vm.runInContext(readFileSync(join(UI_DIR, rel), 'utf8'), ctx, { filename: rel });
    }

    const storeViewEl = document.createElement('section');
    document.body.appendChild(storeViewEl);
    const toggledHib = [];
    const savedWorkspaces = [];
    const appliedSuggestions = [];
    const sidecars = [
      {
        sidecarId: 'context-monitor', displayName: 'Context & Budget Monitor', statusBadge: 'RUNNING',
        isRunning: true, isErrored: false, scope: 'project', workspaces: ['C:/Proj/App'],
        autoHibernate: true, autoHibernateLocked: false, installedVersion: '1.3.0', source: 'local',
      },
      {
        sidecarId: 'my-plugin/pane', displayName: 'Plugin Pane', statusBadge: 'RUNNING',
        isRunning: true, isErrored: false, scope: 'project', workspaces: [],
        autoHibernate: false, autoHibernateLocked: true, installedVersion: '1.0.0', source: 'plugin:my-plugin',
      },
    ];

    window.Hangar.renderExtensionsTab({
      storeViewEl,
      sidecars,
      hangar: {
        installedVersion: '1.2.5',
        latestVersion: '1.2.5',
        updateAvailable: false,
        funding: 'https://github.com/sponsors/arthurcavallari',
      },
      registryPackages: [
        {
          id: 'context-monitor',
          name: 'Context & Quota Monitor',
          latestVersion: '1.4.0',
          capabilityTier: 'TIER_1_TELEMETRY',
          author: { name: 'Arthur Cavallari', verified: true },
          funding: 'https://github.com/sponsors/arthurcavallari',
          categories: ['telemetry'],
          license: 'MIT',
          homepage: 'https://github.com/arthurcavallari/antigravity-context-monitor',
        },
        {
          id: 'unfunded-pkg',
          name: 'Unfunded Sidecar',
          latestVersion: '1.0.0',
          capabilityTier: 'TIER_1_TELEMETRY',
          funding: 'javascript:alert(1)',
          homepage: 'javascript:alert(1)',
          categories: ['devops'],
        },
      ],
      suggestions: [{ sidecarId: 'docker-ui', name: 'Docker UI', reason: 'Detected docker-compose.yml', actionType: 'install' }],
      activeWorkspace: { workspaceName: 'App', workspacePath: 'C:/Proj/App' },
      onToggleAutoHibernate: async (sc) => toggledHib.push(sc.sidecarId),
      onSaveWorkspaces: async (sc, next) => savedWorkspaces.push([sc.sidecarId, next]),
      onApplySuggestion: async (sug) => appliedSuggestions.push(sug.sidecarId),
    });

    assert.equal(storeViewEl.innerHTML.includes('&lt;svg'), false);
    assert.equal(storeViewEl.innerHTML.includes('&amp;amp;'), false);
    assert.ok(storeViewEl.querySelectorAll('svg').length >= 4);
    const headerSponsor = storeViewEl.querySelector('[data-role="sponsor-header-link"]');
    assert.ok(headerSponsor);
    assert.equal(headerSponsor.getAttribute('href'), 'https://github.com/sponsors/arthurcavallari');
    assert.equal(headerSponsor.getAttribute('target'), '_blank');
    assert.equal(storeViewEl.querySelectorAll('[data-subtab]').length, 3);
    storeViewEl.querySelector('[data-subtab="discover"]').click();
    assert.equal(storeViewEl.querySelectorAll('[data-cat]').length, 5);
    const cmDiscover = storeViewEl.querySelector('.agy-card[data-pkg-id="context-monitor"]');
    assert.equal(cmDiscover.querySelector('[data-role="pkg-license"]').textContent, 'MIT');
    const cmHomepage = cmDiscover.querySelector('[data-role="pkg-homepage"]');
    assert.equal(cmHomepage.getAttribute('href'), 'https://github.com/arthurcavallari/antigravity-context-monitor');
    assert.equal(cmHomepage.getAttribute('target'), '_blank');
    assert.equal(cmHomepage.getAttribute('rel'), 'noopener noreferrer');
    const unfundedDiscover = storeViewEl.querySelector('.agy-card[data-pkg-id="unfunded-pkg"]');
    assert.equal(unfundedDiscover.querySelector('[data-role="pkg-homepage"]'), null);
    assert.equal(unfundedDiscover.querySelector('[data-role="pkg-license"]'), null);
    const fundedCardSponsor = storeViewEl.querySelector('.agy-card[data-pkg-id="context-monitor"] [data-role="pkg-sponsor-link"]');
    assert.equal(fundedCardSponsor.classList.contains('hidden'), false);
    assert.equal(fundedCardSponsor.getAttribute('href'), 'https://github.com/sponsors/arthurcavallari');
    assert.equal(fundedCardSponsor.title, 'Sponsor Arthur Cavallari');
    const unfundedCardSponsor = storeViewEl.querySelector('.agy-card[data-pkg-id="unfunded-pkg"] [data-role="pkg-sponsor-link"]');
    assert.equal(unfundedCardSponsor.classList.contains('hidden'), true);
    storeViewEl.querySelector('[data-subtab="installed"]').click();

    const verPill = storeViewEl.querySelector('[data-role="hangar-ver-pill"]');
    assert.equal(verPill.classList.contains('hidden'), false);
    assert.equal(verPill.textContent, 'Hangar v1.2.5');
    assert.equal(verPill.title, 'Installed Antigravity Hangar version: v1.2.5');

    const wsPill = storeViewEl.querySelector('[data-role="active-ws-pill"]');
    assert.equal(wsPill.title, 'Active Workspace: C:/Proj/App');
    assert.match(wsPill.innerHTML, /App/);

    const sugBox = storeViewEl.querySelector('[data-role="workspace-suggestions"]');
    assert.equal(sugBox.classList.contains('hidden'), false);
    const sugBtn = sugBox.children[1].children[1];
    sugBtn.click();
    assert.deepEqual(appliedSuggestions, ['docker-ui']);

    const cmCard = storeViewEl.querySelector('.agy-card[data-sidecar-id="context-monitor"]');
    assert.equal(cmCard.querySelector('[data-role="title"]').textContent, 'Context & Budget Monitor');
    const cmGlobsToggle = cmCard.querySelector('[data-role="globs-toggle"]');
    const cmGlobsDrawer = cmCard.querySelector('[data-role="globs-drawer"]');
    assert.equal(cmGlobsToggle.getAttribute('aria-expanded'), 'false');
    assert.equal(cmGlobsDrawer.classList.contains('hidden'), true);
    cmGlobsToggle.click();
    assert.equal(cmGlobsToggle.getAttribute('aria-expanded'), 'true');
    assert.equal(cmGlobsDrawer.classList.contains('hidden'), false);
    assert.equal(cmCard.classList.contains('is-scope-open'), true);

    const cmProcBtn = cmCard.querySelector('[data-role="proc-btn"]');
    assert.equal(cmProcBtn.classList.contains('on'), true);
    assert.equal(cmProcBtn.getAttribute('aria-checked'), 'true');
    assert.ok(cmProcBtn.querySelector('.agy-switch-thumb'));
    const cmHibBtn = cmCard.querySelector('[data-role="hibernate-btn"]');
    assert.equal(cmHibBtn.disabled, false);
    assert.equal(cmHibBtn.getAttribute('aria-pressed'), 'true');
    cmHibBtn.click();
    await flush();
    assert.deepEqual(toggledHib, ['context-monitor']);

    cmCard.querySelector('.ws-rule-remove').click();
    await flush();
    assert.deepEqual(JSON.parse(JSON.stringify(savedWorkspaces)), [['context-monitor', []]]);

    const pluginCard = storeViewEl.querySelector('.agy-card[data-sidecar-id="my-plugin/pane"]');
    assert.equal(pluginCard.querySelector('[data-role="globs-drawer"]').classList.contains('hidden'), true);
    const pluginHibBtn = pluginCard.querySelector('[data-role="hibernate-btn"]');
    assert.equal(pluginHibBtn.disabled, true);
    pluginHibBtn.click();
    await flush();
    assert.deepEqual(toggledHib, ['context-monitor']);

    const settingsPatches = [];
    let currentEngine = 'jetbox';
    window.Hangar.readEngineMode = () => currentEngine;
    window.Hangar.saveEngineMode = (m) => {
      currentEngine = m;
    };
    window.Hangar.renderExtensionsTab({
      storeViewEl,
      sidecars: [
        ...sidecars,
        {
          sidecarId: 'swarm/swarm_board', displayName: 'Swarm', statusBadge: 'RUNNING',
          isRunning: true, isErrored: false, builtin: true, webPort: 54979,
          workspaces: ['*'], autoHibernate: false, autoHibernateLocked: true,
        },
      ],
      plugins: [
        { name: 'cloudflare', displayName: 'Cloudflare', dir: 'cloudflare', pluginId: '', installedVersion: '1.0.4', counts: { skills: 22, mcpServers: 1 } },
        { name: 'adversarial-engineering', displayName: '', dir: 'adversarial-engineering', pluginId: '', installedVersion: '', counts: { rules: 1 } },
        { name: 'agy-plugin-porter', displayName: '', dir: 'agy-plugin-porter', pluginId: 'agy-plugin-porter', installedVersion: '0.3.1', capabilityTier: 'TIER_3_AGENT_CONTROL', counts: { skills: 1, mcpServers: 1 } },
      ],
      layout: { hibernateAfterIdleMinutes: 10 },
      onUpdateSettings: async (patch) => settingsPatches.push(patch),
    });
    assert.equal(cmGlobsDrawer.classList.contains('hidden'), false);
    assert.equal(pluginCard.querySelector('[data-role="globs-drawer"]').classList.contains('hidden'), true);
    const swarmCard = storeViewEl.querySelector('.agy-card[data-sidecar-id="swarm/swarm_board"]');
    assert.equal(swarmCard.querySelector('[data-role="builtin-badge"]').classList.contains('hidden'), false);
    assert.equal(swarmCard.querySelector('[data-role="meta-sub"]').textContent, 'swarm/swarm_board • :54979');
    const cfCard = storeViewEl.querySelector('.agy-card[data-plugin-dir="cloudflare"]');
    assert.equal(cfCard.querySelector('[data-role="title"]').textContent, 'Cloudflare');
    assert.equal(cfCard.dataset.pluginName, 'cloudflare');
    assert.equal(cfCard.querySelector('[data-role="meta"]').textContent, 'cloudflare • v1.0.4 • 22 skills, 1 MCP server');
    assert.equal(cfCard.querySelector('[data-role="badges"]').textContent, '');
    const advCard = storeViewEl.querySelector('.agy-card[data-plugin-dir="adversarial-engineering"]');
    assert.equal(advCard.querySelector('[data-role="title"]').textContent, 'adversarial-engineering');
    assert.equal(advCard.querySelector('[data-role="meta"]').textContent, '1 rule');
    const porterCard = storeViewEl.querySelector('.agy-card[data-plugin-dir="agy-plugin-porter"]');
    assert.equal(porterCard.querySelector('[data-role="meta"]').textContent, 'v0.3.1 • hangar • 1 skill, 1 MCP server');
    assert.equal(porterCard.querySelector('[data-role="badges"]').innerHTML.includes('>Plugin<'), false);
    assert.match(porterCard.querySelector('[data-role="badges"]').textContent, /Tier 3/);

    const settingsBtn = storeViewEl.querySelector('[data-role="settings-btn"]');
    const settingsPane = storeViewEl.querySelector('[data-role="pane-settings"]');
    assert.equal(settingsBtn.getAttribute('aria-pressed'), 'false');
    assert.equal(settingsPane.classList.contains('hidden'), true);

    settingsBtn.click();
    assert.equal(settingsBtn.getAttribute('aria-pressed'), 'true');
    assert.equal(settingsPane.classList.contains('hidden'), false);
    assert.equal(storeViewEl.querySelector('[data-role="pane-installed"]').classList.contains('hidden'), true);
    const settingsSponsor = settingsPane.querySelector('[data-role="settings-sponsor-link"]');
    assert.ok(settingsSponsor);
    assert.equal(settingsSponsor.getAttribute('href'), 'https://github.com/sponsors/arthurcavallari');
    assert.equal(settingsSponsor.getAttribute('target'), '_blank');

    assert.equal(settingsPane.querySelector('[data-role="auto-update-off"]').classList.contains('active'), true);
    assert.equal(settingsPane.querySelector('[data-role="auto-update-on"]').classList.contains('active'), false);
    settingsPane.querySelector('[data-role="auto-update-on"]').click();
    await flush();
    settingsPane.querySelector('[data-role="ttl-30"]').click();
    await flush();
    settingsPane.querySelector('[data-role="ext-mode-button"]').click();
    await flush();
    settingsPane.querySelector('[data-role="term-mode-button"]').click();
    await flush();
    settingsPane.querySelector('[data-role="engine-direct"]').click();
    assert.equal(currentEngine, 'direct');

    // Verify defaults and toggles for Hangar Terminals in Antigravity and Side Questions settings
    assert.equal(settingsPane.querySelector('[data-role="hangar-terms-hide"]').classList.contains('active'), true);
    assert.equal(settingsPane.querySelector('[data-role="hangar-terms-show"]').classList.contains('active'), false);
    assert.equal(settingsPane.querySelector('[data-role="ext-sq-show"]').classList.contains('active'), true);
    assert.equal(settingsPane.querySelector('[data-role="ext-sq-hide"]').classList.contains('active'), false);
    assert.equal(settingsPane.querySelector('[data-role="hangar-sq-show"]').classList.contains('active'), true);
    assert.equal(settingsPane.querySelector('[data-role="hangar-sq-hide"]').classList.contains('active'), false);

    settingsPane.querySelector('[data-role="hangar-terms-show"]').click();
    await flush();
    settingsPane.querySelector('[data-role="ext-sq-hide"]').click();
    await flush();
    settingsPane.querySelector('[data-role="hangar-sq-hide"]').click();
    await flush();

    assert.deepEqual(JSON.parse(JSON.stringify(settingsPatches)), [
      { autoUpdate: true },
      { hibernateAfterIdleMinutes: 30 },
      { extensionsDisplayMode: 'button' },
      { terminalDisplayMode: 'button' },
      { hideHangarTerminals: false },
      { showExternalSideQuestions: false },
      { hideHangarSideQuestions: true },
    ]);

    settingsBtn.click();
    assert.equal(settingsBtn.getAttribute('aria-pressed'), 'false');
    assert.equal(settingsPane.classList.contains('hidden'), true);
    assert.equal(storeViewEl.querySelector('[data-role="pane-installed"]').classList.contains('hidden'), false);

    // Self-update button stays in "Restarting Hangar…" disabled state while LS restart is in flight,
    // and triggers window.location.reload() when updateAvailable clears
    let selfUpdateCalls = 0;
    let reloaded = 0;
    window.location = { reload: () => { reloaded++; } };
    const hangarState = {
      installedVersion: '1.2.5',
      latestVersion: '1.4.0',
      updateAvailable: true,
      gitRepo: 'https://github.com/arthurcavallari/antigravity-hangar',
      tarballUrl: 'https://registry.npmjs.org/antigravity-hangar/-/antigravity-hangar-1.4.0.tgz',
    };
    window.Hangar.renderExtensionsTab({
      storeViewEl,
      sidecars,
      hangar: hangarState,
      onSelfUpdate: async () => {
        selfUpdateCalls++;
      },
    });
    const selfUpBtn = storeViewEl.querySelector('[data-role="hangar-self-update-btn"]');
    assert.equal(storeViewEl.querySelector('[data-role="hangar-update-banner"]').classList.contains('hidden'), false);
    selfUpBtn.click();
    await flush();
    assert.equal(selfUpdateCalls, 1);
    assert.equal(selfUpBtn.disabled, true);
    assert.match(selfUpBtn.textContent, /Restarting Hangar/);
    assert.equal(reloaded, 0);

    // When onSelfUpdate clears updateAvailable on the same origin, reload() is called
    selfUpBtn.disabled = false;
    window.Hangar.renderExtensionsTab({
      storeViewEl,
      sidecars,
      hangar: hangarState,
      onSelfUpdate: async () => {
        selfUpdateCalls++;
        hangarState.updateAvailable = false;
      },
    });
    selfUpBtn.click();
    await flush();
    assert.equal(selfUpdateCalls, 2);
    assert.equal(reloaded, 1);

    // Toggling settings when Extensions is in the bottom split pane must not clobber pinnedTopSidecarId
    const splitSaved = [];
    const splitState = {
      layout: {
        splitViewEnabled: true,
        pinnedTopSidecarId: '__sidechat__',
        showExternalSideQuestions: true,
      },
      bottomActiveTabId: window.Hangar.EXTENSIONS_TAB_ID,
    };
    const extActions = window.Hangar.createExtensionsActions({
      state: splitState,
      apiCall: async () => ({}),
      bumpLayoutSeq: () => {},
      saveLayoutUpdate: async (patch) => splitSaved.push(patch),
      reopenClosed: async () => {},
      refreshRegistry: async () => {},
      refreshHangarState: async () => {},
      renderAll: () => {},
    });
    await extActions.onUpdateSettings({ showExternalSideQuestions: false });
    assert.equal(splitState.layout.pinnedTopSidecarId, '__sidechat__');
    assert.deepEqual(splitSaved, [{ showExternalSideQuestions: false }]);
  });

  it('exposes getExtensionsSubTab and notifies onSubTabChange across installed, discover, sideload, and settings', () => {
    const { window, document, CustomEvent, HTMLElement, DocumentFragment, Node } = parseHTML(
      '<!DOCTYPE html><html><body></body></html>',
    );
    const CSS = { escape: (s) => String(s) };
    window.CSS = CSS;
    const ctx = vm.createContext({ window, document, CustomEvent, HTMLElement, DocumentFragment, Node, CSS });
    vm.runInContext(buildAgyUiJs('all'), ctx, { filename: 'ui.js' });
    for (const rel of [
      'core.js',
      'components/plugin-panes.js',
      'components/marketplace-panes.js',
      'components/installed-pane.js',
      'components/extensions-tab.js',
    ]) {
      vm.runInContext(readFileSync(join(UI_DIR, rel), 'utf8'), ctx, { filename: rel });
    }

    const ns = window.Hangar;
    assert.equal(typeof ns.getExtensionsSubTab, 'function');
    assert.equal(ns.getExtensionsSubTab(), 'installed');
    ns.setExtensionsSubTab('discover');
    assert.equal(ns.getExtensionsSubTab(), 'discover');
    ns.setExtensionsSubTab('installed');

    const storeViewEl = document.createElement('section');
    document.body.appendChild(storeViewEl);
    const seenSubTabs = [];
    ns.renderExtensionsTab({
      storeViewEl,
      sidecars: [],
      registryPackages: [],
      onSubTabChange: (sub) => seenSubTabs.push(sub),
    });

    storeViewEl.querySelector('[data-subtab="discover"]').click();
    assert.equal(ns.getExtensionsSubTab(), 'discover');
    storeViewEl.querySelector('[data-subtab="sideload"]').click();
    assert.equal(ns.getExtensionsSubTab(), 'sideload');
    storeViewEl.querySelector('[data-role="settings-btn"]').click();
    assert.equal(ns.getExtensionsSubTab(), 'settings');
    storeViewEl.querySelector('[data-role="settings-btn"]').click();
    assert.equal(ns.getExtensionsSubTab(), 'installed');

    assert.deepEqual(seenSubTabs, ['discover', 'sideload', 'settings', 'installed']);
  });

  it('orders featured and verified first-party extensions at the top of Discover across category filters and live re-renders', async () => {
    const indexHtml = readFileSync(join(UI_DIR, 'index.html'), 'utf8');
    const { window, document, CustomEvent, HTMLElement, DocumentFragment, Node } = parseHTML(indexHtml);
    const CSS = { escape: (s) => String(s) };
    window.CSS = CSS;
    const unorderedPackages = [
      {
        id: 'anthropic-feature-dev',
        name: 'Feature Dev',
        kind: 'plugin',
        port: { from: 'claude' },
        author: { name: 'Anthropic', verified: false },
        categories: ['productivity'],
        capabilityTier: 'TIER_3_AGENT_CONTROL',
        latestVersion: '1.0.1',
      },
      {
        id: 'tob-sharp-edges',
        name: 'Sharp Edges',
        kind: 'plugin',
        port: { from: 'claude' },
        author: { name: 'Trail of Bits', verified: false },
        categories: ['security'],
        capabilityTier: 'TIER_3_AGENT_CONTROL',
        latestVersion: '1.1.3',
      },
      {
        id: 'agy-plugin-porter',
        name: 'Plugin Porter',
        kind: 'plugin',
        author: { name: 'Arthur Cavallari', verified: true },
        categories: ['productivity'],
        capabilityTier: 'TIER_3_AGENT_CONTROL',
        latestVersion: '0.4.0',
      },
      {
        id: 'notes',
        name: 'Notes',
        author: { name: 'Arthur Cavallari', verified: true },
        categories: ['productivity'],
        capabilityTier: 'TIER_3_AGENT_CONTROL',
        latestVersion: '1.0.0',
      },
      {
        id: 'context-monitor',
        name: 'Context & Quota Monitor',
        author: { name: 'Arthur Cavallari', verified: true },
        categories: ['telemetry', 'productivity'],
        capabilityTier: 'TIER_1_TELEMETRY',
        latestVersion: '1.7.0',
      },
    ];
    let featuredIdsFromApi = ['context-monitor', 'notes'];
    window.fetch = async (url) => {
      if (String(url).includes('/api/store/registry')) {
        return {
          ok: true,
          json: async () => ({
            featuredIds: featuredIdsFromApi,
            packages: unorderedPackages,
            hangar: { installedVersion: '1.6.0', latestVersion: '1.6.0', updateAvailable: false },
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          bootId: 'boot-1',
          activeWorkspace: { workspaceName: 'App', workspacePath: 'C:/Proj/App' },
          layout: {
            pinnedTopSidecarId: '__extensions__',
            openTabIds: ['__extensions__'],
            splitViewEnabled: false,
          },
          sidecars: [],
          plugins: [],
          terminals: [],
        }),
      };
    };

    const timers = [];
    const ctx = vm.createContext({
      window,
      document,
      CustomEvent,
      HTMLElement,
      DocumentFragment,
      Node,
      CSS,
      URLSearchParams,
      console,
      fetch: window.fetch,
      setTimeout: (fn, ms) => {
        const id = setTimeout(fn, ms);
        timers.push(() => clearTimeout(id));
        return id;
      },
      clearTimeout,
      setInterval: (fn, ms) => {
        const id = setInterval(fn, ms);
        timers.push(() => clearInterval(id));
        return id;
      },
      clearInterval,
    });
    try {
      vm.runInContext(buildAgyUiJs('all'), ctx, { filename: 'ui.js' });
      const { UI_SCRIPTS } = await import('../lib/constants.mjs');
      for (const rel of UI_SCRIPTS) {
        vm.runInContext(readFileSync(join(UI_DIR, rel), 'utf8'), ctx, { filename: rel });
      }
      await flush();

      const ns = window.Hangar;
      assert.equal(typeof ns.sortDiscoverPackages, 'function');

      const storeViewEl = document.getElementById('store-view');
      storeViewEl.querySelector('[data-subtab="discover"]').click();
      await flush();

      const cardIds = () =>
        Array.from(storeViewEl.querySelectorAll('[data-role="discover-list"] .agy-card')).map((el) => el.dataset.pkgId);

      assert.deepEqual(cardIds(), [
        'context-monitor',
        'notes',
        'agy-plugin-porter',
        'anthropic-feature-dev',
        'tob-sharp-edges',
      ]);

      // Category filter preserves featured -> verified -> community priority
      storeViewEl.querySelector('[data-cat="productivity"]').click();
      assert.deepEqual(cardIds(), [
        'context-monitor',
        'notes',
        'agy-plugin-porter',
        'anthropic-feature-dev',
      ]);

      storeViewEl.querySelector('[data-cat="all"]').click();
      assert.deepEqual(
        Array.from(ns.sortDiscoverPackages(unorderedPackages, ['notes']), (p) => p.id),
        ['notes', 'agy-plugin-porter', 'context-monitor', 'anthropic-feature-dev', 'tob-sharp-edges'],
      );
      featuredIdsFromApi = ['notes', 'context-monitor'];
      storeViewEl.querySelector('[data-role="settings-btn"]').click();
      storeViewEl.querySelector('[data-role="check-updates-btn"]').click();
      await flush();
      storeViewEl.querySelector('[data-subtab="discover"]').click();

      assert.deepEqual(cardIds(), [
        'notes',
        'context-monitor',
        'agy-plugin-porter',
        'anthropic-feature-dev',
        'tob-sharp-edges',
      ]);
    } finally {
      for (const stop of timers) stop();
    }
  });
});
