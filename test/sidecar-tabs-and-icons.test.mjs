import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { buildAgyUiJs } from 'antigravity-sidecar-kit/ui';
import {
  loadHangarConfig,
  readJsonSafe,
  updateHangarLayout,
  updateSidecarRule,
  writeJsonNoBom,
} from '../lib/config-store.mjs';
import { HibernationManager } from '../lib/hibernation-manager.mjs';
import { detectWorkspaceSuggestions } from '../lib/registry-catalog.mjs';
import { enrichSidecarList, serveSidecarIcon } from '../lib/state-orchestrator.mjs';

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

describe('Backend: per-workspace openTabIds, permission sync, savedGlobs, and sidecar icons', () => {
  it('computes isOpenInWorkspace from workspaceLayouts.openTabIds, closedTabIds, and glob rules', () => {
    const hangarConfig = {
      layout: {
        workspaceLayouts: {
          'c:/projects/alpha-backend': {
            workspacePath: 'C:/Projects/alpha-backend',
            openTabIds: ['sqlite-studio'],
            closedTabIds: ['context-monitor'],
            pinnedTabIds: [],
          },
          'c:/projects/beta-ui': {
            workspacePath: 'C:/Projects/beta-ui',
            openTabIds: [],
            closedTabIds: [],
            pinnedTabIds: [],
          },
        },
      },
      sidecars: {
        'context-monitor': { scope: 'global', workspaces: ['*'], autoHibernate: false },
        'docker-ops': { scope: 'project', workspaces: ['*backend*'], autoHibernate: true },
        'sqlite-studio': { scope: 'project', workspaces: [], autoHibernate: true },
      },
    };
    const rawSidecars = [
      { sidecarId: 'context-monitor', status: 'SIDECAR_STATUS_RUNNING', config: { displayName: 'Context Monitor', hasWebUi: true } },
      { sidecarId: 'docker-ops', status: 'SIDECAR_STATUS_RUNNING', config: { displayName: 'Docker Ops', hasWebUi: true } },
      { sidecarId: 'sqlite-studio', status: 'SIDECAR_STATUS_STOPPED', config: { displayName: 'SQLite Studio', hasWebUi: true } },
    ];

    const alpha = enrichSidecarList(rawSidecars, hangarConfig, {
      activeWorkspacePath: 'C:/Projects/alpha-backend',
      sidecarsDir: join(tmpdir(), 'nonexistent-sidecars'),
    });
    const byIdAlpha = new Map(alpha.map((s) => [s.sidecarId, s]));
    assert.equal(byIdAlpha.get('sqlite-studio').matchesWorkspace, false);
    assert.equal(byIdAlpha.get('sqlite-studio').isOpenInWorkspace, true);
    assert.equal(byIdAlpha.get('sqlite-studio').statusBadge, 'STOPPED');
    assert.equal(byIdAlpha.get('docker-ops').matchesWorkspace, true);
    assert.equal(byIdAlpha.get('docker-ops').isOpenInWorkspace, true);
    assert.equal(byIdAlpha.get('context-monitor').matchesWorkspace, true);
    assert.equal(byIdAlpha.get('context-monitor').isOpenInWorkspace, false);

    const beta = enrichSidecarList(rawSidecars, hangarConfig, {
      activeWorkspacePath: 'C:/Projects/beta-ui',
      sidecarsDir: join(tmpdir(), 'nonexistent-sidecars'),
    });
    const byIdBeta = new Map(beta.map((s) => [s.sidecarId, s]));
    assert.equal(byIdBeta.get('sqlite-studio').isOpenInWorkspace, false);
    assert.equal(byIdBeta.get('sqlite-studio').statusBadge, 'HIBERNATED');
    assert.equal(byIdBeta.get('docker-ops').isOpenInWorkspace, false);
    assert.equal(byIdBeta.get('context-monitor').isOpenInWorkspace, true);
  });

  it('wakes and idle-sleeps autoHibernate sidecars based on isOpenInWorkspace even when workspaces rule is empty', async () => {
    const hib = new HibernationManager();
    const actions = [];
    const t0 = 1_700_000_000_000;

    // Open via openTabIds in project A -> wakes stopped sidecar
    await hib.reconcile(
      [
        {
          sidecarId: 'sqlite-studio',
          status: 'SIDECAR_STATUS_STOPPED',
          autoHibernate: true,
          matchesWorkspace: false,
          isOpenInWorkspace: true,
        },
      ],
      {
        hibernateAfterIdleMinutes: 10,
        nowMs: t0,
        manageSidecarFn: async (action, id) => actions.push({ action, id }),
      }
    );
    assert.deepEqual(actions, [{ action: 'SIDECAR_ACTION_ENABLE', id: 'sqlite-studio' }]);

    // Switch to project B (isOpenInWorkspace: false) -> sleeps after TTL
    actions.length = 0;
    await hib.reconcile(
      [
        {
          sidecarId: 'sqlite-studio',
          status: 'SIDECAR_STATUS_RUNNING',
          autoHibernate: true,
          matchesWorkspace: false,
          isOpenInWorkspace: false,
        },
      ],
      {
        hibernateAfterIdleMinutes: 10,
        nowMs: t0 + 11 * 60 * 1000,
        manageSidecarFn: async (action, id) => actions.push({ action, id }),
      }
    );
    assert.deepEqual(actions, [{ action: 'SIDECAR_ACTION_DISABLE', id: 'sqlite-studio' }]);
  });

  it('grants workspace_uris when opened via workspaceLayouts.openTabIds and revokes when closed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hangar-open-perms-'));
    try {
      const cfgPath = join(dir, 'hangar.json');
      const sidecarsDir = join(dir, 'sidecars');
      const manifestPath = join(sidecarsDir, 'notes', 'sidecar.json');
      mkdirSync(join(sidecarsDir, 'notes'), { recursive: true });
      writeJsonNoBom(manifestPath, {
        command: 'node',
        agent_permissions: { workspace_uris: ['file:///author/keep'], allows_user_interactions: true },
      });

      updateHangarLayout(
        {
          workspaceLayouts: {
            'c:/projects/app-one': {
              workspacePath: 'C:/Projects/App-One',
              openTabIds: ['notes'],
            },
          },
        },
        cfgPath,
        { sidecarsDir }
      );
      const grantedUris = readJsonSafe(manifestPath, {}).agent_permissions.workspace_uris;
      assert.equal(grantedUris.includes('file:///author/keep'), true);
      assert.equal(grantedUris.some((u) => u.endsWith('/Projects/App-One')), true);

      // Closing the tab revokes the dynamically granted workspace URI while preserving author URIs
      updateHangarLayout(
        {
          workspaceLayouts: {
            'c:/projects/app-one': {
              workspacePath: 'C:/Projects/App-One',
              openTabIds: [],
            },
          },
        },
        cfgPath,
        { sidecarsDir }
      );
      assert.deepEqual(readJsonSafe(manifestPath, {}).agent_permissions.workspace_uris, ['file:///author/keep']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves savedGlobs when toggling sidecar rule between project and global', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hangar-saved-globs-'));
    try {
      const cfgPath = join(dir, 'hangar.json');
      updateSidecarRule(
        'docker-ops',
        { scope: 'project', workspaces: ['*backend*', '*api*'] },
        { configPath: cfgPath, sidecarsDir: dir }
      );
      const globalRule = updateSidecarRule(
        'docker-ops',
        { scope: 'global', workspaces: ['*'] },
        { configPath: cfgPath, sidecarsDir: dir }
      );
      assert.deepEqual(globalRule.workspaces, ['*']);
      assert.deepEqual(globalRule.savedGlobs, ['*backend*', '*api*']);

      const restored = updateSidecarRule(
        'docker-ops',
        { scope: 'project', restoreSavedGlobs: true },
        { configPath: cfgPath, sidecarsDir: dir }
      );
      assert.equal(restored.scope, 'project');
      assert.deepEqual(restored.workspaces, ['*backend*', '*api*']);
      assert.equal(loadHangarConfig(cfgPath).sidecars['docker-ops'].scope, 'project');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('discovers sidecar icons (including plugin.json logo like swarm/swarm_board) and serves them safely via serveSidecarIcon', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hangar-icons-'));
    try {
      const pluginsDir = join(dir, 'plugins');
      const builtinPluginsDir = join(dir, 'builtin', 'plugins');
      const sidecarsDir = join(dir, 'sidecars');

      // 1. Built-in swarm plugin with relative assets/logo.svg
      const swarmRoot = join(builtinPluginsDir, 'swarm');
      mkdirSync(join(swarmRoot, 'assets'), { recursive: true });
      mkdirSync(join(swarmRoot, 'sidecars', 'swarm_board'), { recursive: true });
      const swarmSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect width="20" height="20" fill="#f8e081"/></svg>';
      writeFileSync(join(swarmRoot, 'plugin.json'), JSON.stringify({ name: 'swarm', logo: 'assets/logo.svg' }), 'utf8');
      writeFileSync(join(swarmRoot, 'assets', 'logo.svg'), swarmSvg, 'utf8');
      writeFileSync(join(swarmRoot, 'sidecars', 'swarm_board', 'sidecar.json'), JSON.stringify({ display_name: 'Swarm', has_web_ui: true }), 'utf8');

      // 2. Plugin sidecar with remote https:// logo
      const bioRoot = join(pluginsDir, 'structural-biology');
      mkdirSync(join(bioRoot, 'sidecars', 'viewer'), { recursive: true });
      writeFileSync(
        join(bioRoot, 'plugin.json'),
        JSON.stringify({ name: 'structural-biology', logo: 'https://www.gstatic.com/antigravity/science/logo.svg' }),
        'utf8'
      );
      writeFileSync(join(bioRoot, 'sidecars', 'viewer', 'sidecar.json'), JSON.stringify({ display_name: 'Viewer', has_web_ui: true }), 'utf8');

      // 3. Standalone sidecar with traversal attempt in logo (must be rejected!)
      const evilDir = join(sidecarsDir, 'evil-sc');
      mkdirSync(evilDir, { recursive: true });
      writeFileSync(join(dir, 'secret.svg'), '<svg/>', 'utf8');
      writeFileSync(join(evilDir, 'sidecar.json'), JSON.stringify({ display_name: 'Evil', has_web_ui: true, logo: '../../secret.svg' }), 'utf8');

      // 4. Standalone sidecar with valid assets/logo.svg
      const notesDir = join(sidecarsDir, 'notes');
      mkdirSync(join(notesDir, 'assets'), { recursive: true });
      const notesSvg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="5"/></svg>';
      writeFileSync(join(notesDir, 'sidecar.json'), JSON.stringify({ display_name: 'Notes', has_web_ui: true }), 'utf8');
      writeFileSync(join(notesDir, 'assets', 'logo.svg'), notesSvg, 'utf8');

      const enriched = enrichSidecarList(
        [
          {
            sidecarId: 'swarm/swarm_board',
            parentPluginId: 'swarm',
            pluginPath: swarmRoot,
            status: 'SIDECAR_STATUS_RUNNING',
            config: { display_name: 'Swarm', has_web_ui: true },
          },
          {
            sidecarId: 'evil-sc',
            status: 'SIDECAR_STATUS_RUNNING',
            config: { display_name: 'Evil', has_web_ui: true, logo: '../../secret.svg' },
          },
          {
            sidecarId: 'notes',
            status: 'SIDECAR_STATUS_RUNNING',
            config: { display_name: 'Notes', has_web_ui: true },
          },
        ],
        { layout: {}, sidecars: {} },
        { sidecarsDir, pluginsDir, builtinPluginsDir }
      );

      const byId = new Map(enriched.map((s) => [s.sidecarId, s]));
      assert.equal(byId.get('swarm/swarm_board').iconUrl, '/api/sidecar/icon?id=swarm%2Fswarm_board');
      assert.equal(byId.get('structural-biology/viewer').iconUrl, 'https://www.gstatic.com/antigravity/science/logo.svg');
      assert.equal(byId.get('evil-sc').iconUrl, '');
      assert.equal(byId.get('notes').iconUrl, '/api/sidecar/icon?id=notes');

      const swarmRes = await serveSidecarIcon('swarm/swarm_board', { sidecarsDir, pluginsDir, builtinPluginsDir });
      assert.equal(swarmRes.status, 200);
      assert.equal(swarmRes.contentType, 'image/svg+xml');
      assert.equal(Buffer.from(swarmRes.body).toString('utf8'), swarmSvg);
      assert.match(String(swarmRes.headers?.['Content-Security-Policy'] || ''), /default-src 'none'/);

      const notesRes = await serveSidecarIcon('notes', { sidecarsDir, pluginsDir, builtinPluginsDir });
      assert.equal(notesRes.status, 200);
      assert.equal(Buffer.from(notesRes.body).toString('utf8'), notesSvg);

      const evilRes = await serveSidecarIcon('evil-sc', { sidecarsDir, pluginsDir, builtinPluginsDir });
      assert.equal(evilRes.status, 404);

      const badIdRes = await serveSidecarIcon('../escape', { sidecarsDir, pluginsDir, builtinPluginsDir });
      assert.equal(badIdRes.status, 400);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('suggests installed workspace-trigger sidecars when closed in the active workspace and hides suggestion once open', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hangar-sug-open-'));
    try {
      writeFileSync(join(dir, 'Dockerfile'), 'FROM node:20\n', 'utf8');
      const closedSug = detectWorkspaceSuggestions({
        activeWorkspacePath: dir,
        sidecars: [
          {
            sidecarId: 'docker-ops',
            displayName: 'Docker Ops',
            isRunning: true,
            matchesWorkspace: false,
            isOpenInWorkspace: false,
          },
        ],
        registryPackages: [],
      });
      assert.equal(closedSug.length, 1);
      assert.equal(closedSug[0].sidecarId, 'docker-ops');

      const openSug = detectWorkspaceSuggestions({
        activeWorkspacePath: dir,
        sidecars: [
          {
            sidecarId: 'docker-ops',
            displayName: 'Docker Ops',
            isRunning: true,
            matchesWorkspace: false,
            isOpenInWorkspace: true,
          },
        ],
        registryPackages: [],
      });
      assert.equal(openSug.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Frontend: direct tab open/close, + launcher menu, custom sidecar icons, and simplified cards', () => {
  it('opens an unscoped sidecar from the + menu, mounts its iframe, renders custom tab icons, and closes via × cleanly', async () => {
    const indexHtml = readFileSync(join(UI_DIR, 'index.html'), 'utf8');
    const { window, document, CustomEvent, HTMLElement, DocumentFragment, Node } = parseHTML(indexHtml);
    window.CSS = { escape: (s) => String(s) };
    window.location = { search: '?token=tok-abc-123' };
    const ctx = vm.createContext({
      window, document, CustomEvent, HTMLElement, DocumentFragment, Node,
      CSS: window.CSS, URL, URLSearchParams, console, Date, setTimeout, clearTimeout,
    });
    vm.runInContext(buildAgyUiJs('all'), ctx, { filename: 'ui.js' });
    for (const rel of [
      'core.js',
      'components/terminal-groups.js',
      'components/sidechat-store.js',
      'components/tab-bar.js',
      'components/iframe-deck.js',
      'components/layout-controller.js',
    ]) {
      vm.runInContext(readFileSync(join(UI_DIR, rel), 'utf8'), ctx, { filename: rel });
    }

    const ns = window.Hangar;
    const apiCalls = [];
    const state = {
      activeWorkspace: { workspacePath: 'C:/Projects/App', workspaceName: 'App' },
      sidecars: [
        {
          sidecarId: 'swarm/swarm_board',
          displayName: 'Swarm',
          iconUrl: '/api/sidecar/icon?id=swarm%2Fswarm_board',
          statusBadge: 'RUNNING',
          isRunning: true,
          scope: 'global',
          workspaces: ['*'],
          matchesWorkspace: true,
          iframeUrl: 'http://127.0.0.1:51010/',
        },
        {
          sidecarId: 'sqlite-studio',
          displayName: 'SQLite Studio',
          iconUrl: '',
          statusBadge: 'STOPPED',
          isRunning: false,
          scope: 'project',
          workspaces: [],
          matchesWorkspace: false,
          iframeUrl: '',
        },
      ],
      terminals: [],
      layout: {
        pinnedTopSidecarId: 'swarm/swarm_board',
        topSplitTabIds: ['swarm/swarm_board'],
        openTabIds: [],
        closedTabIds: [],
        pinnedTabIds: [],
        tabOrder: [],
        splitViewEnabled: false,
      },
    };
    const els = {
      tabStrip: document.getElementById('tab-strip'),
      topOverflowBtn: document.getElementById('top-overflow-btn'),
      bottomTabBar: document.getElementById('bottom-tab-bar'),
      bottomTabStrip: document.getElementById('bottom-tab-strip'),
      bottomOverflowBtn: document.getElementById('bottom-overflow-btn'),
      tabOverflowPopover: document.getElementById('tab-overflow-popover'),
      terminalToggleBtn: document.getElementById('terminal-toggle-btn'),
      extensionsToggleBtn: document.getElementById('extensions-toggle-btn'),
      splitToggleBtn: document.getElementById('split-toggle-btn'),
      splitDividerGroup: document.getElementById('split-divider-group'),
      mainViewport: document.getElementById('main-viewport'),
      emptyTopState: document.getElementById('empty-top-state'),
      emptyDeckState: document.getElementById('empty-deck-state'),
      storeView: document.getElementById('store-view'),
    };
    window.Hangar.setMainTerminalOpen(false);
    ns.apiCall = async (path, body) => {
      apiCalls.push({ path, body });
      if (path === '/api/sidecar/manage' && body.sidecarId === 'sqlite-studio') {
        state.sidecars[1].isRunning = true;
        state.sidecars[1].statusBadge = 'RUNNING';
        state.sidecars[1].iframeUrl = 'http://127.0.0.1:51020/';
      }
      return { ok: true, layout: state.layout };
    };

    const renderedLists = { singleIds: [], topIds: [], bottomIds: [] };
    let ctrl;
    const renderAll = () => {
      const part = ns.partitionSplitTabs(state.sidecars, state.layout, state.terminals);
      renderedLists.singleIds = part.workspaceTabs.map((t) => t.sidecarId);
      ns.reconcileIframeDeck({ state, els, onRefreshState: async () => renderAll() });
      ns.renderTabBar({
        tabStripEl: els.tabStrip,
        topOverflowBtnEl: els.topOverflowBtn,
        bottomTabBarEl: els.bottomTabBar,
        bottomTabStripEl: els.bottomTabStrip,
        bottomOverflowBtnEl: els.bottomOverflowBtn,
        tabOverflowPopoverEl: els.tabOverflowPopover,
        terminalBtnEl: els.terminalToggleBtn,
        extensionsBtnEl: els.extensionsToggleBtn,
        splitBtnEl: els.splitToggleBtn,
        sidecars: state.sidecars,
        terminals: state.terminals,
        layout: state.layout,
        hasActiveWorkspace: true,
        onSelectTopSplitTab: (id) => {
          state.layout.pinnedTopSidecarId = id;
          renderAll();
        },
        onContextAction: (p) => ctrl.handleTabContextAction(p),
      });
    };
    ctrl = ns.createLayoutController({
      state,
      els,
      hangarConversationId: 'conv-1',
      bumpLayoutSeq: () => {},
      getRenderedLists: () => renderedLists,
      renderAll,
      refreshHangarState: async () => renderAll(),
    });
    renderAll();

    // 1. Swarm tab renders custom <img> logo with UI token appended, and is closable via ×
    const swarmTab = els.tabStrip.querySelector('.agy-tab[data-sidecar-id="swarm/swarm_board"]');
    assert.ok(swarmTab, 'Swarm tab is rendered');
    const firstLogoImg = swarmTab.querySelector('img.hangar-tab-logo');
    assert.ok(firstLogoImg, 'Swarm tab renders custom <img> logo');
    assert.equal(firstLogoImg.getAttribute('src'), '/api/sidecar/icon?id=swarm%2Fswarm_board&token=tok-abc-123');
    const swarmCloseWrap = swarmTab.querySelector('[data-role="tab-close-wrap"]');
    assert.equal(swarmCloseWrap.classList.contains('hidden'), false, 'Sidecar tab has visible close button slot');

    // Re-rendering reuses the exact same <img> DOM node (zero flicker on 3s polls)
    renderAll();
    assert.equal(swarmTab.querySelector('img.hangar-tab-logo'), firstLogoImg);

    // 2. Clicking '+' button lists installed sidecars (Swarm checked, SQLite Studio unchecked)
    const addBtn = els.tabStrip.querySelector('[data-role="hub-add-tab"]');
    assert.ok(addBtn);
    assert.equal(addBtn.title, 'Open Tab');
    assert.equal(addBtn.getAttribute('aria-label'), 'Open Tab');
    addBtn.click();
    const menuEl = document.querySelector('.agy-context-menu');
    assert.ok(menuEl, '+ button opens context menu');
    const sqliteMenuBtn = menuEl.querySelector('[data-menu-id="open-sidecar:sqlite-studio"]');
    const swarmMenuBtn = menuEl.querySelector('[data-menu-id="open-sidecar:swarm/swarm_board"]');
    assert.ok(sqliteMenuBtn, '+ menu lists unscoped SQLite Studio sidecar');
    assert.ok(swarmMenuBtn.querySelector('img.hangar-tab-logo'), '+ menu renders Swarm custom logo');

    const toPlain = (v) => JSON.parse(JSON.stringify(v));

    // 3. Clicking SQLite Studio in '+' menu opens it in openTabIds, enables its process, and mounts its iframe
    sqliteMenuBtn.click();
    await flush();
    assert.deepEqual(toPlain(state.layout.openTabIds), ['sqlite-studio']);
    assert.equal(state.layout.pinnedTopSidecarId, 'sqlite-studio');
    assert.equal(
      apiCalls.some((c) => c.path === '/api/sidecar/manage' && c.body.sidecarId === 'sqlite-studio' && c.body.action === 'SIDECAR_ACTION_ENABLE'),
      true,
    );
    const lastLayoutSave = apiCalls.findLast((c) => c.path === '/api/layout/update');
    assert.equal(lastLayoutSave.body.workspaceLayouts['c:/projects/app'].workspacePath, 'C:/Projects/App');
    assert.deepEqual(toPlain(lastLayoutSave.body.workspaceLayouts['c:/projects/app'].openTabIds), ['sqlite-studio']);
    assert.ok(els.mainViewport.querySelector('iframe.child-sidecar-frame[data-sidecar-id="sqlite-studio"]'));

    // 4. Closing ad-hoc SQLite Studio via × removes it from openTabIds without polluting closedTabIds ("Hidden Tabs")
    const sqliteTab = els.tabStrip.querySelector('.agy-tab[data-sidecar-id="sqlite-studio"]');
    sqliteTab.querySelector('[data-role="tab-close"]').click();
    await flush();
    assert.deepEqual(toPlain(state.layout.openTabIds), []);
    assert.equal(state.layout.closedTabIds.includes('sqlite-studio'), false);
    assert.equal(els.mainViewport.querySelector('iframe.child-sidecar-frame[data-sidecar-id="sqlite-studio"]'), null);

    // 4b. Closing a rule-matched/global tab adds it to closedTabIds for this workspace, and reopening via openSidecar restores it
    swarmTab.querySelector('[data-role="tab-close"]').click();
    await flush();
    assert.deepEqual(toPlain(state.layout.closedTabIds), ['swarm/swarm_board']);
    await ctrl.openSidecar('swarm/swarm_board');
    assert.deepEqual(toPlain(state.layout.closedTabIds), []);

    // 5. Toggling Global OFF on Swarm keeps Swarm open in the current workspace's openTabIds and sends restoreSavedGlobs
    await ctrl.handleTabContextAction({ action: 'toggle-global', sidecarId: 'swarm/swarm_board' });
    await flush();
    assert.equal(state.layout.openTabIds.includes('swarm/swarm_board'), true);
    const ruleUpdate = apiCalls.findLast((c) => c.path === '/api/rules/update');
    assert.deepEqual(toPlain(ruleUpdate.body), {
      sidecarId: 'swarm/swarm_board',
      scope: 'project',
      restoreSavedGlobs: true,
    });
  });

  it('renders All Workspaces, Auto-Sleep, and Auto-open globs on Installed cards without Open/Focus/Close buttons, and removes Sideload scope picker', async () => {
    const { window, document, CustomEvent, HTMLElement, DocumentFragment, Node } = parseHTML(
      '<!DOCTYPE html><html><body></body></html>'
    );
    window.CSS = { escape: (s) => String(s) };
    const ctx = vm.createContext({ window, document, CustomEvent, HTMLElement, DocumentFragment, Node, CSS: window.CSS });
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

    const storeViewEl = document.createElement('section');
    document.body.appendChild(storeViewEl);
    const openedIds = [];
    const globalToggles = [];
    const savedGlobs = [];
    const linkedPayloads = [];

    window.Hangar.renderExtensionsTab({
      storeViewEl,
      sidecars: [
        {
          sidecarId: 'docker-ops',
          displayName: 'Docker Ops',
          iconUrl: 'https://example.com/docker.svg',
          statusBadge: 'STOPPED',
          isRunning: false,
          isErrored: false,
          scope: 'project',
          workspaces: ['*backend*'],
          autoHibernate: true,
          autoHibernateLocked: false,
          matchesWorkspace: false,
          isOpenInWorkspace: false,
          installedVersion: '1.1.0',
          source: 'local',
        },
        {
          sidecarId: 'context-monitor',
          displayName: 'Context Monitor',
          statusBadge: 'RUNNING',
          isRunning: true,
          isErrored: false,
          scope: 'global',
          workspaces: ['*'],
          autoHibernate: false,
          autoHibernateLocked: false,
          matchesWorkspace: true,
          isOpenInWorkspace: true,
          installedVersion: '1.4.0',
          source: 'local',
        },
      ],
      layout: { openTabIds: [], closedTabIds: [], pinnedTabIds: [] },
      activeWorkspace: { workspaceName: 'Portal', workspacePath: 'C:/Projects/Portal' },
      onOpenSidecar: async (id) => openedIds.push(id),
      onToggleGlobalSidecar: async (sc) => globalToggles.push(sc.sidecarId),
      onSaveWorkspaces: async (sc, next) => savedGlobs.push([sc.sidecarId, next]),
      onLinkLocal: async (payload) => {
        linkedPayloads.push(payload);
        return { ok: true, sidecarId: 'custom-dev' };
      },
    });

    const dockerCard = storeViewEl.querySelector('.agy-card[data-sidecar-id="docker-ops"]');
    const cmCard = storeViewEl.querySelector('.agy-card[data-sidecar-id="context-monitor"]');
    assert.ok(dockerCard.querySelector('img.hangar-card-logo'));
    assert.equal(Boolean(dockerCard.querySelector('[data-role="open-tab-btn"]')), false);
    assert.equal(Boolean(dockerCard.querySelector('[data-role="close-tab-btn"]')), false);
    assert.equal(Boolean(cmCard.querySelector('[data-role="open-tab-btn"]')), false);
    assert.equal(Boolean(cmCard.querySelector('[data-role="close-tab-btn"]')), false);

    // All Workspaces toggle
    const globalBtn = dockerCard.querySelector('[data-role="global-btn"]');
    assert.equal(globalBtn.getAttribute('aria-pressed'), 'false');
    assert.equal(cmCard.querySelector('[data-role="global-btn"]').getAttribute('aria-pressed'), 'true');
    globalBtn.click();
    await flush();
    assert.deepEqual(globalToggles, ['docker-ops']);

    // Collapsible Auto-open globs disclosure
    const globsToggle = dockerCard.querySelector('[data-role="globs-toggle"]');
    const globsDrawer = dockerCard.querySelector('[data-role="globs-drawer"]');
    assert.equal(globsToggle.getAttribute('aria-expanded'), 'false');
    assert.equal(globsDrawer.classList.contains('hidden'), true);
    globsToggle.click();
    assert.equal(globsToggle.getAttribute('aria-expanded'), 'true');
    assert.equal(globsDrawer.classList.contains('hidden'), false);
    const globInput = dockerCard.querySelector('.ws-input');
    globInput.value = '*api*';
    dockerCard.querySelector('[data-role="add-rule-btn"]').click();
    await flush();
    assert.deepEqual(JSON.parse(JSON.stringify(savedGlobs)), [['docker-ops', ['*backend*', '*api*']]]);

    // Sideload links directly with workspaces: [] and opens the linked sidecar in the current workspace
    storeViewEl.querySelector('[data-subtab="sideload"]').click();
    const sideloadPane = storeViewEl.querySelector('[data-role="pane-sideload"]');
    assert.equal(sideloadPane.querySelector('[aria-label="Sideload workspace scope"]'), null);
    const localInput = sideloadPane.querySelector('[data-role="local-path-input"]');
    localInput.value = 'C:/Projects/custom-dev';
    sideloadPane.querySelector('[data-role="link-btn"]').click();
    await flush();
    assert.deepEqual(JSON.parse(JSON.stringify(linkedPayloads)), [{ folderPath: 'C:/Projects/custom-dev', scope: 'project', workspaces: [] }]);
    assert.deepEqual(openedIds, ['custom-dev']);
  });
});
