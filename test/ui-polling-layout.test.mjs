import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

function fakeClassList() {
  const set = new Set();
  return {
    has: (c) => set.has(c),
    toggle: (c, on) => (on ? set.add(c) : set.delete(c)),
    add: (c) => set.add(c),
    remove: (c) => set.delete(c),
  };
}

describe('Hangar workspace layout scoping, hidden cadence, and AgyUI integration', () => {
  it('Hangar polls at the hidden cadence while Antigravity hides its view with CSS and propagates host visibility to child iframes', async () => {
    let [now, intervalTick, observer, stateCalls] = [0, null, null, 0];
    const visibilityTransitions = [];
    const window = {
      location: { search: '' },
      addEventListener() {},
      Hangar: {
        partitionSplitTabs: () => ({ workspaceTabs: [], topTabs: [], bottomTabs: [], topSet: new Set() }),
        syncDeckVisibility: () => visibilityTransitions.push(`deck:${window.Hangar.isHostHidden?.()}`),
        syncSideChatVisibility: () => visibilityTransitions.push(`sidechat:${window.Hangar.isHostHidden?.()}`),
        syncTerminalVisibility: () => visibilityTransitions.push(`terminal:${window.Hangar.isHostHidden?.()}`),
        apiCall: async (path) => {
          if (path === '/api/state') stateCalls++;
          return { sidecars: [], layout: {} };
        },
      },
    };
    const document = { hidden: false, documentElement: {}, getElementById: () => null, addEventListener() {} };
    const ctx = vm.createContext({
      window, document, URLSearchParams,
      sessionStorage: { getItem: () => '', setItem() {} },
      console, Date: { now: () => now }, setTimeout,
      setInterval: (fn) => {
        intervalTick ??= fn;
        return 0;
      },
      IntersectionObserver: class {
        constructor(cb) { observer = { cb }; }
        observe(target) { observer.target = target; }
      },
    });
    vm.runInContext(readFileSync(join(UI_DIR, 'app.js'), 'utf8'), ctx, { filename: 'app.js' });
    await flush();
    assert.equal(stateCalls, 1);
    assert.equal(observer.target, document.documentElement);
    assert.equal(window.Hangar.isHostHidden?.(), false);

    observer.cb([{ isIntersecting: false }]);
    assert.equal(window.Hangar.isHostHidden?.(), true);
    assert.deepEqual(visibilityTransitions, ['deck:true', 'sidechat:true', 'terminal:true']);
    for (let i = 0; i < 19; i++) {
      now += 3000;
      intervalTick();
      await flush();
    }
    assert.equal(stateCalls, 1, 'no 3s polls while hidden');
    now += 3000;
    intervalTick();
    await flush();
    assert.equal(stateCalls, 2, 'one poll per minute keeps hibernation working');

    observer.cb([{ isIntersecting: true }]);
    await flush();
    assert.equal(window.Hangar.isHostHidden?.(), false);
    assert.deepEqual(visibilityTransitions, [
      'deck:true', 'sidechat:true', 'terminal:true',
      'deck:false', 'sidechat:false', 'terminal:false',
    ]);
    assert.equal(stateCalls, 3);
    now += 3000;
    intervalTick();
    await flush();
    assert.equal(stateCalls, 4);
  });

  it('scopes the selected tab and workspace layout per project so selecting Extensions in project1 does not select it in project2', async () => {
    const sharedSession = new Map();
    const sessionStorage = {
      getItem: (k) => sharedSession.get(k) || '',
      setItem: (k, v) => sharedSession.set(k, String(v)),
      removeItem: (k) => sharedSession.delete(k),
    };
    let sharedLayout = {
      pinnedTopSidecarId: 'context-monitor',
      topSplitTabIds: ['context-monitor'],
      tabOrder: [],
      splitViewEnabled: false,
    };
    let currentWsPath = 'C:\\Proj\\One';
    let onWorkspaceChange = null;
    let lastTabBarProps = null;

    const window = {
      location: { search: '?conversationId=conv-proj-1' },
      addEventListener() {},
      sidecar: {
        onWorkspaceChange: (cb) => {
          onWorkspaceChange = cb;
        },
      },
      Hangar: {
        EXTENSIONS_TAB_ID: '__extensions__',
        TERMINAL_TAB_ID: '__terminal__',
        SIDECHAT_TAB_ID: '__sidechat__',
        renderTabBar: (props) => {
          lastTabBarProps = props;
        },
        apiCall: async (path, body) => {
          if (path === '/api/state') {
            return {
              activeWorkspace: { workspacePath: currentWsPath, workspaceName: currentWsPath.split('\\').pop() },
              sidecars: [{ sidecarId: 'context-monitor', displayName: 'Context Monitor', matchesWorkspace: true, isRunning: true }],
              terminals: [],
              layout: JSON.parse(JSON.stringify(sharedLayout)),
            };
          }
          if (path === '/api/layout/update') {
            const prevWsLayouts = sharedLayout.workspaceLayouts || {};
            sharedLayout = { ...sharedLayout, ...body };
            if (body.workspaceLayouts) sharedLayout.workspaceLayouts = { ...prevWsLayouts, ...body.workspaceLayouts };
            return { ok: true, layout: sharedLayout };
          }
          return {};
        },
      },
    };
    window.parent = {};
    const document = { hidden: false, getElementById: () => null, addEventListener() {}, querySelectorAll: () => [] };
    const ctx = vm.createContext({
      window, document, URLSearchParams, sessionStorage, console, Date, setTimeout,
      setInterval: () => 0,
    });
    for (const rel of ['core.js', 'components/tab-bar.js', 'components/layout-controller.js']) {
      vm.runInContext(readFileSync(join(UI_DIR, rel), 'utf8'), ctx, { filename: rel });
    }
    window.Hangar.renderTabBar = (props) => {
      lastTabBarProps = props;
    };
    vm.runInContext(readFileSync(join(UI_DIR, 'app.js'), 'utf8'), ctx, { filename: 'app.js' });
    await flush();

    assert.equal(lastTabBarProps.layout.pinnedTopSidecarId, 'context-monitor');
    await lastTabBarProps.onSelectTopSplitTab('__extensions__');
    await flush();
    assert.equal(lastTabBarProps.layout.pinnedTopSidecarId, '__extensions__');
    assert.equal(sharedLayout.workspaceLayouts['c:/proj/one'].pinnedTopSidecarId, '__extensions__');
    assert.equal(sharedSession.get('hangar.activeTabId:c:/proj/one'), '__extensions__');

    currentWsPath = 'C:\\Proj\\Two';
    onWorkspaceChange(['file:///c%3A/Proj/Two']);
    await flush();
    assert.equal(lastTabBarProps.layout.pinnedTopSidecarId, 'context-monitor');

    currentWsPath = 'C:\\Proj\\One';
    onWorkspaceChange(['file:///c%3A/Proj/One']);
    await flush();
    assert.equal(lastTabBarProps.layout.pinnedTopSidecarId, '__extensions__');
  });

  it('isolates terminals and side chats when viewing conversations that do not belong to a project', async () => {
    const sharedSession = new Map();
    const sessionStorage = {
      getItem: (k) => sharedSession.get(k) || '',
      setItem: (k, v) => sharedSession.set(k, String(v)),
      removeItem: (k) => sharedSession.delete(k),
    };
    const sharedLocal = new Map();
    const localStorage = {
      getItem: (k) => sharedLocal.get(k) || null,
      setItem: (k, v) => sharedLocal.set(k, String(v)),
      removeItem: (k) => sharedLocal.delete(k),
    };
    const projSideChatState = {
      isOpen: true,
      isDocked: true,
      activeCascadeId: '11111111-1111-4111-8111-111111111111',
      sideChatCounter: 2,
      threads: [
        { cascadeId: '11111111-1111-4111-8111-111111111111', title: 'Proj 1 Side Chat', parentConversationId: 'conv-proj-1', pinned: false },
        { cascadeId: '22222222-2222-4222-8222-222222222222', title: 'Proj 1 Popped Chat', parentConversationId: 'conv-proj-1', pinned: false },
      ],
      poppedIds: ['22222222-2222-4222-8222-222222222222'],
      groupMap: {},
      activeByInstance: { 'sidechat__22222222-2222-4222-8222-222222222222': '22222222-2222-4222-8222-222222222222' },
    };
    let sharedLayout = {
      pinnedTopSidecarId: '__sidechat__',
      topSplitTabIds: ['context-monitor', '__terminal__', 'terminal__t-proj-popped', '__sidechat__', 'sidechat__22222222-2222-4222-8222-222222222222'],
      tabOrder: ['context-monitor', '__terminal__', 'terminal__t-proj-popped', '__sidechat__', 'sidechat__22222222-2222-4222-8222-222222222222'],
      closedTabIds: [],
      splitViewEnabled: true,
      sideChatState: projSideChatState,
      sideChatStateByWorkspace: {
        'c:/proj/one': projSideChatState,
      },
      workspaceLayouts: {
        'c:/proj/one': {
          pinnedTopSidecarId: '__sidechat__',
          topSplitTabIds: ['context-monitor', '__terminal__', 'terminal__t-proj-popped', '__sidechat__', 'sidechat__22222222-2222-4222-8222-222222222222'],
          tabOrder: ['context-monitor', '__terminal__', 'terminal__t-proj-popped', '__sidechat__', 'sidechat__22222222-2222-4222-8222-222222222222'],
          closedTabIds: [],
          splitViewEnabled: true,
        },
      },
    };
    let currentWsPath = 'C:\\Proj\\One';
    let onWorkspaceChange = null;
    let lastTabBarProps = null;

    const bootWindow = async (conversationId) => {
      const window = {
        location: { search: `?conversationId=${conversationId}` },
        addEventListener() {},
        sidecar: {
          onWorkspaceChange: (cb) => {
            onWorkspaceChange = cb;
          },
        },
        Hangar: {
          apiCall: async (path, body) => {
            if (path === '/api/state') {
              return {
                activeWorkspace: currentWsPath
                  ? { workspacePath: currentWsPath, workspaceName: 'One', source: 'conversation', conversationId }
                  : { workspacePath: '', workspaceName: 'Global', source: 'none', conversationId },
                sidecars: [{ sidecarId: 'context-monitor', displayName: 'Context Monitor', matchesWorkspace: true, isRunning: true }],
                terminals: currentWsPath
                  ? [
                      { terminalId: 't-proj-1', title: 'pwsh', isExternal: false },
                      { terminalId: 't-proj-popped', title: 'pwsh-popped', isExternal: false },
                    ]
                  : [],
                layout: JSON.parse(JSON.stringify(sharedLayout)),
              };
            }
            if (path === '/api/layout/update') {
              const prevWsLayouts = sharedLayout.workspaceLayouts || {};
              const prevScByWs = sharedLayout.sideChatStateByWorkspace || {};
              sharedLayout = { ...sharedLayout, ...body };
              if (body.workspaceLayouts) sharedLayout.workspaceLayouts = { ...prevWsLayouts, ...body.workspaceLayouts };
              if (body.sideChatStateByWorkspace) sharedLayout.sideChatStateByWorkspace = { ...prevScByWs, ...body.sideChatStateByWorkspace };
              return { ok: true, layout: sharedLayout };
            }
            return {};
          },
        },
      };
      window.parent = {};
      const document = { hidden: false, getElementById: () => null, addEventListener() {}, querySelectorAll: () => [] };
      const ctx = vm.createContext({
        window, document, URLSearchParams, sessionStorage, localStorage, console, Date, setTimeout,
        setInterval: () => 0,
      });
      for (const rel of [
        'core.js',
        'components/terminal-groups.js',
        'components/sidechat-store.js',
        'components/tab-bar.js',
        'components/layout-controller.js',
      ]) {
        vm.runInContext(readFileSync(join(UI_DIR, rel), 'utf8'), ctx, { filename: rel });
      }
      window.Hangar.renderTabBar = (props) => {
        lastTabBarProps = props;
      };
      vm.runInContext(readFileSync(join(UI_DIR, 'app.js'), 'utf8'), ctx, { filename: 'app.js' });
      await flush();
      return window;
    };

    // 1. Project window shows its terminals and side chats
    const projWin = await bootWindow('conv-proj-1');
    assert.equal(projWin.Hangar.isMainTerminalOpen(), true);
    assert.equal(projWin.Hangar.getSideChatState().isOpen, true);
    assert.equal(projWin.Hangar.getSideChatState().threads.length, 2);

    // 2. Switching to a projectless conversation in the same window clears project terminals and side chats
    currentWsPath = '';
    onWorkspaceChange([]);
    await flush();
    assert.equal(projWin.Hangar.isMainTerminalOpen(), false);
    assert.equal(projWin.Hangar.getSideChatState().isOpen, false);
    assert.equal(projWin.Hangar.getSideChatState().threads.length, 0);
    assert.equal(projWin.Hangar.getSideChatState().poppedIds.length, 0);
    assert.equal(lastTabBarProps.hasActiveWorkspace, false);
    assert.equal(lastTabBarProps.layout.pinnedTopSidecarId, 'context-monitor');

    // 3. Opening a fresh projectless conversation does not inherit any project's terminals or side chats
    const noProjWin = await bootWindow('conv-no-proj-2');
    assert.equal(noProjWin.Hangar.isMainTerminalOpen(), false);
    assert.equal(noProjWin.Hangar.getSideChatState().isOpen, false);
    assert.equal(noProjWin.Hangar.getSideChatState().threads.length, 0);
    assert.equal(noProjWin.Hangar.getSideChatState().poppedIds.length, 0);
    const part = noProjWin.Hangar.partitionSplitTabs(
      lastTabBarProps.sidecars,
      lastTabBarProps.layout,
      lastTabBarProps.terminals
    );
    assert.deepEqual(
      Array.from(part.workspaceTabs, (t) => t.sidecarId),
      ['context-monitor', '__extensions__']
    );
  });

  it('preserves exact SVG icons, host theme precedence, and container-scoped toasts when AgyUI is loaded', async () => {
    const { buildAgyUiJs } = await import('antigravity-sidecar-kit');
    const inlineProps = new Map();
    const docBodyChildren = [];
    const customContainerChildren = [];
    const documentElement = {
      dataset: {},
      style: {
        setProperty: (k, v) => inlineProps.set(k, v),
        removeProperty: (k) => inlineProps.delete(k),
      },
    };
    const makeEl = (tag) => {
      const attrs = new Map();
      return {
        tagName: tag.toUpperCase(),
        className: '',
        textContent: '',
        dataset: {},
        style: {},
        classList: fakeClassList(),
        children: [],
        setAttribute(k, v) {
          attrs.set(k, String(v));
        },
        getAttribute(k) {
          return attrs.get(k) ?? null;
        },
        appendChild(c) {
          this.children.push(c);
          return c;
        },
        remove() {},
        querySelector: () => null,
        addEventListener() {},
      };
    };
    const document = {
      documentElement,
      head: { appendChild() {} },
      body: { style: {}, classList: fakeClassList(), appendChild: (c) => docBodyChildren.push(c) },
      getElementById: () => null,
      createElement: (tag) => makeEl(tag),
    };
    const window = { document, addEventListener() {}, innerHeight: 800, Hangar: {} };
    const ctx = vm.createContext({ window, document, URL, setTimeout: () => 0, clearTimeout: () => {} });
    vm.runInContext(buildAgyUiJs('all'), ctx, { filename: 'ui.js' });
    for (const rel of ['core.js', 'components/tab-bar.js', 'components/iframe-deck.js']) {
      vm.runInContext(readFileSync(join(UI_DIR, rel), 'utf8'), ctx, { filename: rel });
    }

    const splitVertSvg = window.Hangar.iconSvg('splitscreen_vertical_add', 15);
    const codeBlocksSvg = window.Hangar.iconSvg('code_blocks', 15);
    assert.notEqual(splitVertSvg, codeBlocksSvg);
    assert.match(splitVertSvg, /M180-160q-24\.75 0-42\.37-17\.63Q120-195\.25 120-220v-520/);
    assert.match(window.Hangar.iconSvg('play_arrow', 15), /M340-236\.16V-723\.84L723\.07-480L340-236\.16Z/);
    assert.match(window.Hangar.iconSvg('keep', 16), /M620-471\.54L691\.54-400v60H510v220L480-90/);
    assert.match(window.Hangar.iconSvg('globe', 16), /M480-80q-82 0-155-31\.5t-127\.5-86/);
    assert.match(window.Hangar.iconSvg('pause', 16), /M530-220V-740H740v520H530Zm-310,0V-740H430v520H220Z/);

    window.Hangar.applyThemePayload(
      {
        themeType: 'light',
        cssVariables: {
          '--background': '#fafafa',
          '--foreground': '#111111',
          '--agy-canvas': '#181818',
          '--agy-ink-soft': 'rgba(17, 17, 17, 0.6)',
        },
      },
      true
    );
    assert.equal(document.body.classList.has('theme-light'), true);
    assert.equal(inlineProps.get('--background'), '#fafafa');
    assert.equal(inlineProps.has('--agy-canvas'), false);
    assert.equal(inlineProps.has('--agy-ink-soft'), false);

    window.Hangar.applyThemePayload(
      {
        themeType: 'dark',
        cssVariables: { '--background': '#181818', '--foreground': '#ffffff', '--agy-canvas': '#181818' },
      },
      false
    );
    assert.equal(document.body.classList.has('theme-light'), true);
    assert.equal(inlineProps.get('--background'), '#fafafa');

    const hostContainer = {
      querySelector: () => null,
      appendChild: (c) => customContainerChildren.push(c),
    };
    window.AgyUI.showToast('Sent to Side Chat', { container: hostContainer });
    assert.equal(customContainerChildren.length, 1);
    assert.equal(docBodyChildren.length, 0);

    const splitBtnEl = makeEl('button');
    window.Hangar.renderTabBar({
      tabStripEl: null,
      splitBtnEl,
      sidecars: [],
      terminals: [],
      layout: { splitViewEnabled: true },
    });
    assert.equal(splitBtnEl.classList.has('active'), true);
    assert.equal(splitBtnEl.getAttribute('aria-pressed'), 'true');

    window.Hangar.renderTabBar({
      tabStripEl: null,
      splitBtnEl,
      sidecars: [],
      terminals: [],
      layout: { splitViewEnabled: false },
    });
    assert.equal(splitBtnEl.classList.has('active'), false);
    assert.equal(splitBtnEl.getAttribute('aria-pressed'), 'false');

    const mainViewport = makeEl('div');
    const storeView = makeEl('div');
    window.Hangar.reconcileIframeDeck({
      state: {
        sidecars: [
          {
            sidecarId: 'context-monitor',
            displayName: 'Context Monitor',
            matchesWorkspace: true,
            isRunning: true,
            iframeUrl: 'http://127.0.0.1:4100/?conversationId=c1',
          },
        ],
        terminals: [],
        layout: {
          pinnedTopSidecarId: 'context-monitor',
          topSplitTabIds: ['context-monitor'],
          tabOrder: ['context-monitor'],
          splitViewEnabled: false,
        },
      },
      els: { mainViewport, storeView },
    });
    assert.equal(mainViewport.children.length, 1);
    assert.equal(mainViewport.children[0].title, 'Context Monitor Sidecar');
    assert.equal(mainViewport.children[0].getAttribute('title'), 'Context Monitor Sidecar');

    const termPaneSrc = readFileSync(join(UI_DIR, 'components/terminal-pane.js'), 'utf8');
    assert.match(termPaneSrc, /const frameTitle = `Interactive Terminal \(\$\{cleanTitle\}\)`/);
    const sidechatPaneSrc = readFileSync(join(UI_DIR, 'components/sidechat-pane.js'), 'utf8');
    assert.match(sidechatPaneSrc, /title:\s*'Docked Side Chat'/);

    let enableClickHandler = null;
    const enableBtnStub = {
      disabled: false,
      addEventListener(type, fn) {
        if (type === 'click') enableClickHandler = fn;
      },
    };
    const emptyTopState = makeEl('div');
    emptyTopState.querySelector = (sel) => (sel === '[data-role="enable-sidecar"]' ? enableBtnStub : null);
    let manageCalls = [];
    let refreshed = 0;
    window.Hangar.apiCall = async (path, body) => {
      manageCalls.push({ path, body });
      return { ok: true };
    };
    window.Hangar.reconcileIframeDeck({
      state: {
        sidecars: [
          {
            sidecarId: 'context-monitor',
            displayName: 'Context Monitor',
            matchesWorkspace: true,
            isRunning: false,
          },
        ],
        terminals: [],
        layout: {
          pinnedTopSidecarId: 'context-monitor',
          topSplitTabIds: ['context-monitor'],
          tabOrder: ['context-monitor'],
          splitViewEnabled: false,
        },
      },
      els: { mainViewport, storeView, emptyTopState },
      onRefreshState: async () => {
        refreshed++;
      },
    });
    assert.match(emptyTopState.innerHTML, /data-role="enable-sidecar"/);
    assert.match(emptyTopState.innerHTML, /Enable Sidecar/);
    assert.equal(typeof enableClickHandler, 'function');
    await enableClickHandler();
    assert.deepEqual(JSON.parse(JSON.stringify(manageCalls)), [
      {
        path: '/api/sidecar/manage',
        body: { sidecarId: 'context-monitor', action: 'SIDECAR_ACTION_ENABLE' },
      },
    ]);
    assert.equal(refreshed, 1);

    const extTabSrc = readFileSync(join(UI_DIR, 'components/extensions-tab.js'), 'utf8');
    assert.match(extTabSrc, /aria-label="Auto-Sleep idle timeout presets"/);
    assert.match(extTabSrc, /data-role="auto-update-on" data-value="on"/);
    assert.match(extTabSrc, /shell\.querySelectorAll\?\.\('agy-toggle-group'\)\?\.forEach\?\.\(\(g\) => g\.sync\?\.\(\)\)/);
    assert.match(extTabSrc, /aria-label="Custom idle timeout in minutes \(1 to 240\)"/);
    assert.match(extTabSrc, /checkBtn\.classList\?\.add\?\.\('spinning'\)/);
    assert.match(extTabSrc, /checkBtn\.classList\?\.remove\?\.\('spinning'\)/);
    assert.match(extTabSrc, /const raw = Number\.parseInt\(ttlInput\?\.value, 10\)/);
    assert.match(extTabSrc, /if \(!Number\.isFinite\(raw\) \|\| raw < 1\)/);
    const instPaneSrc = readFileSync(join(UI_DIR, 'components/installed-pane.js'), 'utf8');
    assert.match(instPaneSrc, /aria-label="Add workspace path or glob"/);
    assert.match(instPaneSrc, /q\('proc-btn'\)\.setAttribute\?\.\('aria-label', `Enable or disable \$\{scLabel\}`\)/);
    assert.match(instPaneSrc, /q\('restart-btn'\)\.setAttribute\?\.\('aria-label', `Restart \$\{scLabel\}`\)/);
    assert.match(instPaneSrc, /q\('uninstall-btn'\)\.setAttribute\?\.\('aria-label', `Uninstall \$\{scLabel\}`\)/);
    assert.match(instPaneSrc, /role="group" aria-label="Workspace Scope"/);
    assert.match(instPaneSrc, /globalBtn\.setAttribute\?\.\('aria-pressed', String\(isGlobal\)\)/);
    assert.match(instPaneSrc, /addWsBtn\.setAttribute\?\.\('aria-pressed', String\(alreadyHasCurrent\)\)/);
    assert.match(instPaneSrc, /async function runCardAction\(card, action, triggerBtn = null, spin = false\)/);
    assert.match(instPaneSrc, /runCardAction\(card, \(\) => onManageSidecar\(card\._sc\.sidecarId, 'SIDECAR_ACTION_RESTART'\), restartBtn, true\)/);
    assert.match(instPaneSrc, /data-role="uninstall-confirm-btn" class="agy-btn agy-btn-danger"/);
    assert.match(instPaneSrc, /uninstallCancelBtn\?\.focus\?\.\(\)/);
    assert.match(instPaneSrc, /uninstallBtn\?\.focus\?\.\(\)/);
    const pluginPaneSrc = readFileSync(join(UI_DIR, 'components/plugin-panes.js'), 'utf8');
    assert.match(pluginPaneSrc, /uninstallBtn\.setAttribute\?\.\('aria-label', `Uninstall \$\{p\.name\}`\)/);
    assert.match(pluginPaneSrc, /data-role="uninstall-confirm-btn" class="agy-btn agy-btn-danger"/);
    assert.match(pluginPaneSrc, /uninstallCancelBtn\?\.focus\?\.\(\)/);
    assert.match(pluginPaneSrc, /uninstallBtn\?\.focus\?\.\(\)/);
    const mktPaneSrc = readFileSync(join(UI_DIR, 'components/marketplace-panes.js'), 'utf8');
    assert.match(mktPaneSrc, /aria-label="Search sidecars and plugins"/);
    assert.match(mktPaneSrc, /aria-label="Filter by category"/);
    assert.match(mktPaneSrc, /aria-label="Sideload workspace scope"/);
    assert.match(mktPaneSrc, /aria-label="Local sidecar directory path"/);
    assert.match(mktPaneSrc, /aria-label="GitHub repository URL or owner\/repo"/);
    assert.match(mktPaneSrc, /emptyEl\.className = 'agy-empty-state'/);
    assert.match(mktPaneSrc, /emptyEl\.setAttribute\('role', 'status'\)/);
    assert.match(mktPaneSrc, /emptyEl\.dataset\.role = 'discover-empty'/);
    assert.match(mktPaneSrc, /data-role="sideload-banner" class="agy-banner hidden" role="status" aria-live="polite"/);
    assert.match(mktPaneSrc, /const actionBtns = \[validateBtn, linkBtn, ghInstallBtn, ghConfirmBtn\]/);
    assert.match(mktPaneSrc, /localInput\.addEventListener\('keydown'/);
    assert.match(mktPaneSrc, /ghInput\.addEventListener\('keydown'/);
    const compCssSrc = readFileSync(join(UI_DIR, 'components.css'), 'utf8');
    assert.match(compCssSrc, /\.ws-rule-remove\s*\{[\s\S]*?width:\s*24px;\s*height:\s*24px;/);
    assert.match(compCssSrc, /\.term-pane-close\s*\{[\s\S]*?width:\s*20px;\s*height:\s*20px;/);
    assert.match(compCssSrc, /\.term-pane-dot\.active\s*\{[\s\S]*?background:\s*var\(--status-ok-dot,\s*var\(--agy-ok\)\);/);
    assert.doesNotMatch(compCssSrc, /\.term-quote-composer\[data-slot="top"\]/);
    assert.match(sidechatPaneSrc, /threadSelect\.setAttribute\?\.\('aria-label', 'Select Side Chat thread'\)/);
    assert.match(sidechatPaneSrc, /input\.setAttribute\?\.\('aria-label', 'Note for Main Chat'\)/);
    assert.match(sidechatPaneSrc, /mainToggleBtn\.setAttribute\?\.\('aria-expanded', String\(nextShow\)\)/);
    assert.match(sidechatPaneSrc, /newThreadBtn\.setAttribute\?\.\('aria-label', 'New Side Chat'\)/);
    assert.match(sidechatPaneSrc, /deleteBtn\.setAttribute\?\.\('aria-label', 'Delete Side Chat'\)/);
    assert.match(sidechatPaneSrc, /overviewBtn\.setAttribute\?\.\('aria-pressed', String\(Boolean\(box\._overviewOpen\)\)\)/);
    assert.match(sidechatPaneSrc, /popoutBtn\.setAttribute\?\.\('aria-pressed', String\(Boolean\(curRootId\)\)\)/);
    assert.match(sidechatPaneSrc, /closeBtn\.setAttribute\?\.\('aria-label', 'Close Side Chat'\)/);
  });

  it('cycles top or bottom split tab strip on Ctrl+Tab / Ctrl+Shift+Tab and forwards shortcuts from jetbox-bootstrap', async () => {
    const { buildAgyUiJs } = await import('antigravity-sidecar-kit');
    let boundResolver = null;
    let boundOpts = null;
    const winListeners = {};
    const docListeners = {};
    const topStrip = { id: 'tab-strip' };
    const bottomStrip = { id: 'bottom-tab-strip' };
    const bottomFrameWin = {};
    const bottomFrame = {
      tagName: 'IFRAME',
      nodeType: 1,
      contentWindow: bottomFrameWin,
      classList: { contains: (c) => c === 'child-sidecar-frame' },
      closest: (sel) => (sel.includes('.slot-bottom') ? {} : null),
      blurCalled: false,
      blur() {
        this.blurCalled = true;
      },
    };
    const document = {
      hidden: false,
      activeElement: bottomFrame,
      documentElement: {},
      getElementById: (id) => (id === 'tab-strip' ? topStrip : id === 'bottom-tab-strip' ? bottomStrip : null),
      addEventListener(ev, fn) {
        (docListeners[ev] = docListeners[ev] || []).push(fn);
      },
      querySelectorAll: (sel) => (sel === 'iframe' ? [bottomFrame] : []),
    };
    let winFocused = false;
    const window = {
      location: { search: '?conversationId=conv-cycle', origin: 'http://127.0.0.1:51000' },
      document,
      parent: {},
      focus() {
        winFocused = true;
      },
      addEventListener(ev, fn) {
        (winListeners[ev] = winListeners[ev] || []).push(fn);
      },
      AgyUI: {
        bindGlobalTabCycleKeydown(resolver, opts) {
          boundResolver = resolver;
          boundOpts = opts;
        },
      },
      Hangar: {
        apiCall: async (path) => {
          if (path === '/api/state') {
            return {
              activeWorkspace: { workspacePath: 'C:\\Proj\\One', workspaceName: 'One' },
              sidecars: [{ sidecarId: 'context-monitor', displayName: 'Context Monitor', matchesWorkspace: true, isRunning: true }],
              terminals: [],
              layout: {
                pinnedTopSidecarId: 'context-monitor',
                topSplitTabIds: ['context-monitor'],
                tabOrder: ['context-monitor', '__extensions__'],
                splitViewEnabled: true,
                workspaceLayouts: {
                  'c:/proj/one': {
                    pinnedTopSidecarId: 'context-monitor',
                    topSplitTabIds: ['context-monitor'],
                    tabOrder: ['context-monitor', '__extensions__'],
                    splitViewEnabled: true,
                  },
                },
              },
            };
          }
          return {};
        },
      },
    };
    const sessionStorage = { getItem: () => '', setItem() {}, removeItem() {} };
    const ctx = vm.createContext({
      window,
      document,
      URLSearchParams,
      sessionStorage,
      console,
      Date,
      setTimeout,
      setInterval: () => 0,
    });
    for (const rel of ['core.js', 'components/tab-bar.js', 'components/layout-controller.js']) {
      vm.runInContext(readFileSync(join(UI_DIR, rel), 'utf8'), ctx, { filename: rel });
    }
    window.Hangar.renderTabBar = () => {};
    vm.runInContext(readFileSync(join(UI_DIR, 'app.js'), 'utf8'), ctx, { filename: 'app.js' });
    await flush();

    assert.equal(typeof boundResolver, 'function');
    assert.equal(boundResolver(bottomFrameWin), bottomStrip, 'Forwarded shortcut from bottom iframe resolves bottomTabStrip');
    const topEl = { nodeType: 1, closest: (sel) => (sel.includes('#chrome-bar') ? {} : null) };
    for (const fn of docListeners.pointerdown || []) fn({ target: topEl });
    document.activeElement = topEl;
    assert.equal(boundResolver(null), topStrip, 'Pointer/focus in top chrome resolves top tabStrip');

    document.activeElement = bottomFrame;
    boundOpts.onCycle();
    assert.equal(bottomFrame.blurCalled, true, 'Hidden iframe is blurred on tab cycle');
    assert.equal(winFocused, true, 'Hangar window reclaims focus on tab cycle');

    // Verify jetbox-bootstrap.js intercepts Ctrl+Tab and Ctrl+Shift+. in capture phase and posts agy:shortcut-forwarded
    const jbKeyListeners = [];
    const jbMessages = [];
    const jbWin = {
      __HANGAR_JETBOX_PARAMS__: { mode: 'chat', cascadeId: 'chat-123', safeTheme: 'dark' },
      location: { origin: 'http://127.0.0.1:51000', pathname: '/c/chat-123' },
      navigator: { userAgent: 'Windows' },
      parent: {
        postMessage(msg, targetOrigin) {
          jbMessages.push({ msg, targetOrigin });
        },
      },
      fetch: async () => ({ ok: true, json: async () => ({}) }),
      addEventListener(ev, fn, useCapture) {
        if (ev === 'keydown' && useCapture === true) jbKeyListeners.push(fn);
      },
    };
    const jbDoc = {
      hidden: false,
      documentElement: { setAttribute() {}, removeAttribute() {}, style: { setProperty() {} } },
      addEventListener() {},
      removeEventListener() {},
    };
    const jbCtx = vm.createContext({
      window: jbWin,
      document: jbDoc,
      navigator: jbWin.navigator,
      URL,
      TextEncoder,
      TextDecoder,
      DataView,
      Uint8Array,
      ReadableStream,
      setTimeout: () => 0,
      clearTimeout: () => {},
    });
    vm.runInContext(readFileSync(join(UI_DIR, 'jetbox/jetbox-bootstrap.js'), 'utf8'), jbCtx, {
      filename: 'jetbox-bootstrap.js',
    });

    let stoppedImmediate = false;
    let prevented = false;
    const keyEv = {
      key: 'Tab',
      ctrlKey: true,
      shiftKey: false,
      repeat: false,
      preventDefault() {
        prevented = true;
      },
      stopPropagation() {},
      stopImmediatePropagation() {
        stoppedImmediate = true;
      },
    };
    for (const fn of jbKeyListeners) {
      fn(keyEv);
      if (stoppedImmediate) break;
    }
    assert.equal(prevented, true);
    assert.equal(stoppedImmediate, true);
    assert.deepEqual(JSON.parse(JSON.stringify(jbMessages)), [
      {
        msg: {
          type: 'agy:shortcut-forwarded',
          payload: { dir: 1, repeat: false, mode: 'chat', terminalId: '', cascadeId: 'chat-123' },
        },
        targetOrigin: '*',
      },
    ]);
    assert.ok(buildAgyUiJs('tabs').includes('bindGlobalTabCycleKeydown'));
    assert.ok(readFileSync(join(UI_DIR, 'index.html'), 'utf8').includes('aria-label="Resize top and bottom split panes"'));
  });

  it('unhides Terminal from the overflow (...) menu and seeds native Onyx High Contrast & userSettings in jetbox-bootstrap', async () => {
    const { parseHTML } = await import('linkedom');
    const { buildAgyUiJs } = await import('antigravity-sidecar-kit/ui');
    const indexHtml = readFileSync(join(UI_DIR, 'index.html'), 'utf8');
    const { window, document, CustomEvent, HTMLElement, DocumentFragment, Node } = parseHTML(indexHtml);
    window.CSS = { escape: (s) => String(s) };
    window.requestAnimationFrame = (fn) => { fn(); return 1; };
    const ctx = vm.createContext({
      window, document, CustomEvent, HTMLElement, DocumentFragment, Node,
      CSS: window.CSS, URLSearchParams, console, Date, setTimeout, clearTimeout,
      requestAnimationFrame: window.requestAnimationFrame,
    });
    vm.runInContext(buildAgyUiJs('all'), ctx, { filename: 'ui.js' });
    for (const rel of ['core.js', 'components/terminal-groups.js', 'components/sidechat-store.js', 'components/tab-bar.js', 'components/layout-controller.js']) {
      vm.runInContext(readFileSync(join(UI_DIR, rel), 'utf8'), ctx, { filename: rel });
    }

    const savedLayouts = [];
    const createdTerminals = [];
    const state = {
      workspaceUris: ['file:///c%3A/Proj/One'],
      activeWorkspace: { workspacePath: 'C:\\Proj\\One', workspaceName: 'One' },
      sidecars: [{ sidecarId: 'context-monitor', displayName: 'Context Monitor', matchesWorkspace: true, isRunning: true }],
      terminals: [{ terminalId: 'term-1', title: 'pwsh.exe', isExternal: false }],
      layout: {
        pinnedTopSidecarId: 'context-monitor',
        topSplitTabIds: ['context-monitor', '__terminal__'],
        tabOrder: ['context-monitor', '__terminal__'],
        closedTabIds: ['__terminal__'],
        pinnedTabIds: ['context-monitor'],
        splitViewEnabled: false,
        terminalDisplayMode: 'tab',
        extensionsDisplayMode: 'button',
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
    };
    window.Hangar.setMainTerminalOpen(false);
    window.Hangar.apiCall = async (path, body) => {
      if (path === '/api/layout/update') {
        savedLayouts.push(body);
        return { ok: true, layout: { ...state.layout, ...body } };
      }
      if (path === '/api/terminal/create') {
        createdTerminals.push(body);
        return { ok: true, terminal: { terminalId: 'term-new', title: 'pwsh' } };
      }
      return {};
    };
    let renderCount = 0;
    const renderAll = () => {
      renderCount++;
      window.Hangar.renderTabBar({
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
        onContextAction: (payload) => ctrl.handleTabContextAction(payload),
      });
    };
    const ctrl = window.Hangar.createLayoutController({
      state,
      els,
      hangarConversationId: 'conv-1',
      bumpLayoutSeq: () => 1,
      getRenderedLists: () => ({ singleIds: ['context-monitor'], topIds: ['context-monitor'], bottomIds: [] }),
      renderAll,
      refreshHangarState: async () => {},
    });
    renderAll();

    assert.equal(els.topOverflowBtn.classList.contains('hidden'), false, 'Overflow (...) button is visible when Terminal is hidden');
    assert.match(els.topOverflowBtn.textContent, /1/);
    els.topOverflowBtn.click();
    const hiddenRow = els.tabOverflowPopover.querySelector('.agy-tab-overflow-item.is-hidden-tab');
    assert.ok(hiddenRow, 'Hidden Terminal row is rendered in tabOverflowPopover');
    assert.equal(hiddenRow.getAttribute('title'), 'Show Terminal');
    assert.equal(hiddenRow.querySelector('.agy-tab-overflow-item-title')?.textContent, 'Terminal');
    assert.equal(hiddenRow.querySelector('.agy-tab-overflow-restore')?.textContent, 'Show');

    hiddenRow.click();
    await flush();
    assert.equal(state.layout.closedTabIds.includes('__terminal__'), false, 'Terminal removed from closedTabIds');
    assert.equal(window.Hangar.isMainTerminalOpen(), true, 'Main terminal reopened');
    assert.equal(state.layout.pinnedTopSidecarId, '__terminal__', 'Terminal tab activated upon Show');
    assert.equal(savedLayouts.length >= 1, true);

    // Verify jetbox-bootstrap seeds hostStorage, userSettings, and enable-new-themes Mendel flag
    const msgListeners = [];
    const jbWin = {
      __HANGAR_JETBOX_PARAMS__: {
        mode: 'chat',
        cascadeId: 'chat-123',
        safeTheme: 'dark',
        hostStorage: { 'jetski.contrast': '2', 'theme-preset-dark': 'Default Dark', 'jetski.typeface': 'inter' },
        userSettings: { autoExecutionPolicy: 3, nonWorkspaceFileAccessPolicy: 2 },
      },
      location: { origin: 'http://127.0.0.1:51000', pathname: '/c/chat-123' },
      navigator: { userAgent: 'Windows' },
      parent: { postMessage() {} },
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ flags: [{ keyString: 'some-flag', disabled: false }] }),
        text: async () => JSON.stringify({ flags: [{ keyString: 'some-flag', disabled: false }] }),
      }),
      addEventListener: (type, fn) => {
        if (type === 'message') msgListeners.push(fn);
      },
    };
    const bodyAttrs = new Map([['data-agy-theme', 'onyx-dark'], ['data-agy-font', 'inter']]);
    const rootStyles = new Map([['--secondary-foreground', '#EAEBF1']]);
    const jbDoc = {
      hidden: false,
      body: {
        hasAttribute: (k) => bodyAttrs.has(k),
        style: { fontFamily: 'system-ui' },
      },
      documentElement: {
        style: {
          getPropertyValue: (k) => rootStyles.get(k) || '',
          setProperty: (k, v) => rootStyles.set(k, v),
        },
      },
      addEventListener() {},
      removeEventListener() {},
    };
    const jbCtx = vm.createContext({
      window: jbWin, document: jbDoc, navigator: jbWin.navigator,
      URL, TextEncoder, TextDecoder, DataView, Uint8Array, ReadableStream, Response,
      setTimeout: () => 0, clearTimeout: () => {},
    });
    vm.runInContext(readFileSync(join(UI_DIR, 'jetbox/jetbox-bootstrap.js'), 'utf8'), jbCtx, { filename: 'jetbox-bootstrap.js' });

    assert.equal(jbWin.localStorage.getItem('jetski.contrast'), '2');
    assert.equal(jbWin.localStorage.getItem('theme-preset-dark'), 'Default Dark');
    assert.equal(jbWin.localStorage.getItem('jetski.typeface'), 'inter');

    // Protected root CSS properties when data-agy-theme / data-agy-font are active on body
    for (const fn of msgListeners) {
      fn({
        source: jbWin.parent,
        origin: 'http://127.0.0.1:51000',
        data: { type: 'theme-change', payload: { cssVariables: { '--secondary-foreground': '#8e9199' } } },
        stopImmediatePropagation() {},
      });
    }
    assert.equal(rootStyles.get('--secondary-foreground'), '#EAEBF1');
    assert.equal(jbDoc.body.style.fontFamily, '');
  });
});
