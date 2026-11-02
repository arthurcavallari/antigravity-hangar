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

function fakeElement() {
  return {
    classList: fakeClassList(),
    dataset: {},
    style: { setProperty() {} },
    appendChild() {},
    querySelector: () => null,
  };
}

function loadDeck() {
  const frames = [];
  const document = {
    createElement() {
      const listeners = {};
      const frame = {
        ...fakeElement(),
        posted: [],
        addEventListener: (type, fn) => (listeners[type] = fn),
        load: () => listeners.load?.(),
        remove() {},
      };
      frame.contentWindow = { postMessage: (data) => frame.posted.push(data) };
      frames.push(frame);
      return frame;
    },
  };
  const window = { addEventListener() {}, innerHeight: 800 };
  const ctx = vm.createContext({ window, document, URL });
  for (const rel of ['components/tab-bar.js', 'components/iframe-deck.js']) {
    vm.runInContext(readFileSync(join(UI_DIR, rel), 'utf8'), ctx, { filename: rel });
  }
  const els = {
    mainViewport: fakeElement(),
    splitDividerGroup: fakeElement(),
    storeView: fakeElement(),
    emptyTopState: fakeElement(),
    emptyDeckState: fakeElement(),
  };
  return { ns: window.Hangar, frames, els };
}

describe('Hangar UI polling load', () => {
  it('iframe deck tells child frames when they are shown or hidden', () => {
    const { ns, frames, els } = loadDeck();
    const sidecar = (id, port) => ({
      sidecarId: id,
      matchesWorkspace: true,
      isRunning: true,
      iframeUrl: `http://127.0.0.1:${port}/`,
    });
    const state = {
      sidecars: [sidecar('context-monitor', 51001), sidecar('other', 51002)],
      layout: { pinnedTopSidecarId: 'context-monitor', splitViewEnabled: false },
    };
    const visibility = (frame) =>
      frame.posted.filter((m) => m.type === 'sidecar-visibility').map((m) => m.payload.visible);

    ns.reconcileIframeDeck({ state, els });
    const [cm, other] = frames;
    assert.equal(ns.VISIBILITY_MESSAGE_TYPE, 'sidecar-visibility');
    assert.deepEqual(visibility(cm), [true]);
    assert.deepEqual(visibility(other), [false]);

    // Messages sent before load reach the blank document, so load re-sends the current state
    cm.load();
    other.load();
    assert.deepEqual(visibility(cm), [true, true]);
    assert.deepEqual(visibility(other), [false, false]);

    // Re-rendering without a change sends nothing; switching tabs flips both
    ns.reconcileIframeDeck({ state, els });
    assert.equal(visibility(cm).length, 2);
    state.layout = { ...state.layout, pinnedTopSidecarId: 'other' };
    ns.reconcileIframeDeck({ state, els });
    assert.deepEqual(visibility(cm), [true, true, false]);
    assert.deepEqual(visibility(other), [false, false, true]);
    assert.ok(other.classList.has('visible') && !cm.classList.has('visible'));

    // When Hangar's guess changes (a Hangar opened without a conversation), a mounted child is told
    // instead of being reloaded
    state.sidecars[0].iframeUrl = 'http://127.0.0.1:51001/?conversationId=conv-next';
    ns.reconcileIframeDeck({ state, els });
    const convMsgs = () =>
      cm.posted.filter((m) => m.type === 'conversation-change').map((m) => m.payload.conversationId);
    assert.deepEqual(convMsgs(), ['conv-next']);
    assert.equal(frames.length, 2);

    // When extensionsDisplayMode / terminalDisplayMode is 'button', tabs adjust accordingly
    const tabMode = ns.partitionSplitTabs(state.sidecars, { pinnedTopSidecarId: '__extensions__', extensionsDisplayMode: 'tab', terminalDisplayMode: 'tab' });
    assert.equal(tabMode.workspaceTabs.some((t) => t.sidecarId === '__extensions__'), true);
    assert.equal(tabMode.workspaceTabs.some((t) => t.sidecarId === '__terminal__'), true);
    const btnMode = ns.partitionSplitTabs(state.sidecars, { pinnedTopSidecarId: '__extensions__', extensionsDisplayMode: 'button', terminalDisplayMode: 'button' });
    assert.equal(btnMode.workspaceTabs.some((t) => t.sidecarId === '__extensions__'), false);
    assert.equal(btnMode.workspaceTabs.some((t) => t.sidecarId === '__terminal__'), false);
    assert.equal(btnMode.activeSingleId, '__extensions__');
    const termBtnActive = ns.partitionSplitTabs(state.sidecars, { pinnedTopSidecarId: '__terminal__', terminalDisplayMode: 'button' });
    assert.equal(termBtnActive.activeSingleId, '__terminal__');

    // When terminalDisplayMode is 'button' and Split View is active, reconcileIframeDeck preserves bottomActiveTabId === '__terminal__'
    const splitBtnState = {
      sidecars: [sidecar('context-monitor', 51001)],
      layout: { pinnedTopSidecarId: 'context-monitor', topSplitTabIds: ['context-monitor'], splitViewEnabled: true, terminalDisplayMode: 'button' },
      bottomActiveTabId: '__terminal__',
    };
    ns.reconcileIframeDeck({ state: splitBtnState, els });
    assert.equal(splitBtnState.bottomActiveTabId, '__terminal__');
  });

  it('asks for no conversation when Antigravity frames it without an id, and guesses only in a plain tab', async () => {
    const firstConversationId = async (search, framed) => {
      const requests = [];
      const window = {
        location: { search },
        addEventListener() {},
        Hangar: {
          partitionSplitTabs: () => ({ workspaceTabs: [], topTabs: [], bottomTabs: [], topSet: new Set() }),
          apiCall: (path, body) => {
            if (path === '/api/state') requests.push(body);
            return new Promise(() => {});
          },
        },
      };
      window.parent = framed ? {} : window;
      const ctx = vm.createContext({
        window,
        document: { hidden: false, getElementById: () => null, addEventListener() {} },
        URLSearchParams,
        sessionStorage: { getItem: () => '', setItem() {} },
        console,
        setTimeout,
        setInterval: () => 0,
      });
      vm.runInContext(readFileSync(join(UI_DIR, 'app.js'), 'utf8'), ctx, { filename: 'app.js' });
      await flush();
      return requests[0]?.conversationId;
    };
    // Antigravity's new-conversation screen opens sidecar frames with no conversationId
    assert.equal(await firstConversationId('', true), '_new');
    assert.equal(await firstConversationId('?conversationId=conv-1', true), 'conv-1');
    assert.equal(await firstConversationId('', false), '');
  });

  it('refreshHangarState keeps one /api/state request in flight and re-runs once for callers', async () => {
    let now = 0;
    let intervalTick = null;
    let onWorkspaceChange = null;
    const requests = [];
    const window = {
      location: { search: '' },
      addEventListener() {},
      sidecar: { onWorkspaceChange: (cb) => (onWorkspaceChange = cb) },
      Hangar: {
        partitionSplitTabs: () => ({ workspaceTabs: [], topTabs: [], bottomTabs: [], topSet: new Set() }),
        apiCall: (path, body) => {
          if (path !== '/api/state') return Promise.resolve({});
          return new Promise((resolve) => requests.push({ body, resolve: () => resolve({ sidecars: [], layout: {} }) }));
        },
      },
    };
    const document = { hidden: false, getElementById: () => null, addEventListener() {} };
    const ctx = vm.createContext({
      window,
      document,
      URLSearchParams,
      sessionStorage: { getItem: () => '', setItem() {} },
      console,
      Date: { now: () => now },
      setTimeout,
      // The 3s state poll is the first interval app.js registers
      setInterval: (fn) => {
        intervalTick ??= fn;
        return 0;
      },
    });
    vm.runInContext(readFileSync(join(UI_DIR, 'app.js'), 'utf8'), ctx, { filename: 'app.js' });
    const inFlight = () => requests.filter((r) => !r.done);
    const answer = async () => {
      const [r] = inFlight();
      r.done = true;
      r.resolve();
      await flush();
    };
    await flush();
    assert.equal(inFlight().length, 1, 'initial refresh');

    // Poll ticks while that request hangs do not stack more requests
    for (let i = 0; i < 5; i++) {
      now += 3000;
      intervalTick();
    }
    await flush();
    assert.equal(requests.length, 1);

    // A workspace change mid-request gets exactly one fresh request once the current one ends
    onWorkspaceChange(['file:///c%3A/proj']);
    await answer();
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].body.workspaceUris, ['file:///c%3A/proj']);
    await answer();
    assert.equal(inFlight().length, 0);

    // Polling resumes afterwards
    now += 3000;
    intervalTick();
    await flush();
    assert.equal(requests.length, 3);
  });

  it('Hangar polls at the hidden cadence while Antigravity hides its view with CSS', async () => {
    let now = 0;
    let intervalTick = null;
    let observer = null;
    let stateCalls = 0;
    const window = {
      location: { search: '' },
      addEventListener() {},
      Hangar: {
        partitionSplitTabs: () => ({ workspaceTabs: [], topTabs: [], bottomTabs: [], topSet: new Set() }),
        apiCall: async (path) => {
          if (path === '/api/state') stateCalls++;
          return { sidecars: [], layout: {} };
        },
      },
    };
    const document = { hidden: false, documentElement: {}, getElementById: () => null, addEventListener() {} };
    const ctx = vm.createContext({
      window,
      document,
      URLSearchParams,
      sessionStorage: { getItem: () => '', setItem() {} },
      console,
      Date: { now: () => now },
      setTimeout,
      setInterval: (fn) => {
        intervalTick ??= fn;
        return 0;
      },
      IntersectionObserver: class {
        constructor(cb) {
          observer = { cb };
        }
        observe(target) {
          observer.target = target;
        }
      },
    });
    vm.runInContext(readFileSync(join(UI_DIR, 'app.js'), 'utf8'), ctx, { filename: 'app.js' });
    await flush();
    assert.equal(stateCalls, 1);
    assert.equal(observer.target, document.documentElement);

    observer.cb([{ isIntersecting: false }]);
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

    // Shown again: refresh at once, then back to the 3s cadence
    observer.cb([{ isIntersecting: true }]);
    await flush();
    assert.equal(stateCalls, 3);
    now += 3000;
    intervalTick();
    await flush();
    assert.equal(stateCalls, 4);
  });

  it('renders Auto-Sleep, active workspace, and workspace suggestions inside Extensions tab without top-left popover', async () => {
    const indexHtml = readFileSync(join(UI_DIR, 'index.html'), 'utf8');
    assert.equal(indexHtml.includes('workspace-pill'), false);
    assert.equal(indexHtml.includes('project-popover'), false);

    function makeNode(tag = 'div', attrs = {}) {
      const classes = new Set((attrs.class || '').split(/\s+/).filter(Boolean));
      const listeners = {};
      const node = {
        tagName: tag.toUpperCase(),
        dataset: { ...(attrs.dataset || {}) },
        attributes: { ...attrs },
        children: [],
        className: attrs.class || '',
        disabled: Boolean(attrs.disabled),
        title: attrs.title || '',
        value: '',
        textContent: '',
        _innerHTML: '',
        classList: {
          add: (c) => classes.add(c),
          remove: (c) => classes.delete(c),
          toggle: (c, on) => {
            const next = on === undefined ? !classes.has(c) : Boolean(on);
            if (next) classes.add(c);
            else classes.delete(c);
            return next;
          },
          contains: (c) => classes.has(c),
        },
        setAttribute(k, v) {
          this.attributes[k] = String(v);
        },
        get firstElementChild() {
          return this.children[0] || makeNode('svg');
        },
        appendChild(child) {
          this.children.push(child);
          return child;
        },
        append(...items) {
          this.children.push(...items);
        },
        remove() {},
        addEventListener: (type, fn) => (listeners[type] = fn),
        click: () => listeners.click?.({ preventDefault() {} }),
        get innerHTML() {
          return this._innerHTML;
        },
        set innerHTML(html) {
          this._innerHTML = String(html);
          this.children = [];
          const stack = [this];
          const re = /<\/([a-z0-9-]+)>|<([a-z0-9-]+)([^>]*?)(\/?)>/gi;
          let m;
          while ((m = re.exec(this._innerHTML))) {
            if (m[1]) {
              if (stack.length > 1) stack.pop();
              continue;
            }
            const tagName = m[2];
            const attrStr = m[3];
            const selfClose = Boolean(m[4]) || tagName === 'input' || tagName === 'path';
            const parsedAttrs = {};
            const dataset = {};
            const attrRe = /([a-z0-9-]+)="([^"]*)"/gi;
            let am;
            while ((am = attrRe.exec(attrStr))) {
              parsedAttrs[am[1]] = am[2];
              if (am[1].startsWith('data-')) {
                const camel = am[1].slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
                dataset[camel] = am[2];
              }
            }
            const child = makeNode(tagName, { ...parsedAttrs, dataset });
            stack[stack.length - 1].children.push(child);
            if (!selfClose) stack.push(child);
          }
        },
        querySelectorAll(sel) {
          const all = [];
          const visit = (n) => {
            for (const c of n.children || []) {
              if (matches(c, sel)) all.push(c);
              visit(c);
            }
          };
          visit(this);
          return all;
        },
        querySelector(sel) {
          return this.querySelectorAll(sel)[0] || null;
        },
      };
      return node;
    }

    function matches(el, sel) {
      if (sel.startsWith('[data-role="')) {
        const role = sel.slice(12, -2);
        return el.dataset?.role === role;
      }
      if (sel === '[data-subtab]') return el.dataset?.subtab !== undefined;
      if (sel.startsWith('.agy-card[data-sidecar-id="')) {
        const id = sel.slice(sel.indexOf('"') + 1, -2);
        return el.dataset?.sidecarId === id;
      }
      if (sel === '.agy-card') return (el.className || '').split(/\s+/).some((c) => c === 'agy-card');
      if (sel === '.ws-input') return (el.className || '').split(/\s+/).includes('ws-input');
      return false;
    }

    const window = {};
    const document = { createElement: (tag) => makeNode(tag) };
    const CSS = { escape: (s) => String(s) };
    const ctx = vm.createContext({ window, document, CSS });
    for (const rel of ['core.js', 'components/extensions-tab.js']) {
      vm.runInContext(readFileSync(join(UI_DIR, rel), 'utf8'), ctx, { filename: rel });
    }

    const storeViewEl = makeNode('section');
    const toggledHib = [];
    const savedWorkspaces = [];
    const appliedSuggestions = [];
    const sidecars = [
      {
        sidecarId: 'context-monitor',
        displayName: 'Context Monitor',
        statusBadge: 'RUNNING',
        isRunning: true,
        isErrored: false,
        scope: 'project',
        workspaces: ['C:/Proj/App'],
        autoHibernate: true,
        autoHibernateLocked: false,
        installedVersion: '1.3.0',
        source: 'local',
      },
      {
        sidecarId: 'my-plugin/pane',
        displayName: 'Plugin Pane',
        statusBadge: 'RUNNING',
        isRunning: true,
        isErrored: false,
        scope: 'project',
        workspaces: [],
        autoHibernate: false,
        autoHibernateLocked: true,
        installedVersion: '1.0.0',
        source: 'plugin:my-plugin',
      },
    ];

    window.Hangar.renderExtensionsTab({
      storeViewEl,
      sidecars,
      hangar: { installedVersion: '1.2.5', latestVersion: '1.2.5', updateAvailable: false },
      suggestions: [{ sidecarId: 'docker-ui', name: 'Docker UI', reason: 'Detected docker-compose.yml', actionType: 'install' }],
      activeWorkspace: { workspaceName: 'App', workspacePath: 'C:/Proj/App' },
      onToggleAutoHibernate: async (sc) => toggledHib.push(sc.sidecarId),
      onSaveWorkspaces: async (sc, next) => savedWorkspaces.push([sc.sidecarId, next]),
      onApplySuggestion: async (sug) => appliedSuggestions.push(sug.sidecarId),
    });

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
    const cmHibBtn = cmCard.querySelector('[data-role="hibernate-btn"]');
    assert.equal(cmHibBtn.disabled, false);
    assert.equal(cmHibBtn.attributes['aria-pressed'], 'true');
    cmHibBtn.click();
    await flush();
    assert.deepEqual(toggledHib, ['context-monitor']);

    // Clicking the active workspace button on the card toggles the current workspace off
    const cmWsBtn = cmCard.querySelector('[data-role="add-ws-btn"]');
    assert.equal(cmWsBtn.disabled, false);
    assert.equal(cmWsBtn.classList.contains('active'), true);
    cmWsBtn.click();
    await flush();
    assert.deepEqual(JSON.parse(JSON.stringify(savedWorkspaces)), [['context-monitor', []]]);

    // Plugin sidecar has Auto-Sleep locked and disabled
    const pluginCard = storeViewEl.querySelector('.agy-card[data-sidecar-id="my-plugin/pane"]');
    const pluginHibBtn = pluginCard.querySelector('[data-role="hibernate-btn"]');
    assert.equal(pluginHibBtn.disabled, true);
    pluginHibBtn.click();
    await flush();
    assert.deepEqual(toggledHib, ['context-monitor']);

    // Clicking the gear button toggles the Settings pane and updates settings
    const settingsPatches = [];
    let currentEngine = 'jetbox';
    window.Hangar.readEngineMode = () => currentEngine;
    window.Hangar.saveEngineMode = (m) => { currentEngine = m; };
    window.Hangar.renderExtensionsTab({
      storeViewEl,
      sidecars,
      layout: { hibernateAfterIdleMinutes: 10 },
      onUpdateSettings: async (patch) => settingsPatches.push(patch),
    });

    const settingsBtn = storeViewEl.querySelector('[data-role="settings-btn"]');
    const settingsPane = storeViewEl.querySelector('[data-role="pane-settings"]');
    assert.equal(settingsBtn.attributes['aria-pressed'], 'false');
    assert.equal(settingsPane.classList.contains('hidden'), true);

    settingsBtn.click();
    assert.equal(settingsBtn.attributes['aria-pressed'], 'true');
    assert.equal(settingsPane.classList.contains('hidden'), false);
    assert.equal(storeViewEl.querySelector('[data-role="pane-installed"]').classList.contains('hidden'), true);

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

    assert.deepEqual(JSON.parse(JSON.stringify(settingsPatches)), [
      { autoUpdate: true },
      { hibernateAfterIdleMinutes: 30 },
      { extensionsDisplayMode: 'button' },
      { terminalDisplayMode: 'button' },
    ]);

    // Clicking the gear button again returns to Installed
    settingsBtn.click();
    assert.equal(settingsBtn.attributes['aria-pressed'], 'false');
    assert.equal(settingsPane.classList.contains('hidden'), true);
    assert.equal(storeViewEl.querySelector('[data-role="pane-installed"]').classList.contains('hidden'), false);
  });

  it('scopes the selected tab and workspace layout per project so selecting Extensions in project1 does not select it in project2', async () => {
    const sharedSession = new Map();
    const sessionStorage = {
      getItem: (k) => sharedSession.get(k) || '',
      setItem: (k, v) => sharedSession.set(k, String(v)),
      removeItem: (k) => sharedSession.delete(k),
    };
    let sharedLayout = { pinnedTopSidecarId: 'context-monitor', topSplitTabIds: ['context-monitor'], tabOrder: [], splitViewEnabled: false };
    let currentWsPath = 'C:\\Proj\\One';
    let onWorkspaceChange = null;
    let lastTabBarProps = null;

    const window = {
      location: { search: '?conversationId=conv-proj-1' },
      addEventListener() {},
      sidecar: { onWorkspaceChange: (cb) => { onWorkspaceChange = cb; } },
      Hangar: {
        EXTENSIONS_TAB_ID: '__extensions__',
        TERMINAL_TAB_ID: '__terminal__',
        SIDECHAT_TAB_ID: '__sidechat__',
        renderTabBar: (props) => { lastTabBarProps = props; },
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
      window,
      document,
      URLSearchParams,
      sessionStorage,
      console,
      Date,
      setTimeout,
      setInterval: () => 0,
    });
    vm.runInContext(readFileSync(join(UI_DIR, 'components/tab-bar.js'), 'utf8'), ctx, { filename: 'tab-bar.js' });
    window.Hangar.renderTabBar = (props) => { lastTabBarProps = props; };
    vm.runInContext(readFileSync(join(UI_DIR, 'app.js'), 'utf8'), ctx, { filename: 'app.js' });
    await flush();

    // Project 1 starts on context-monitor, then user clicks Extensions
    assert.equal(lastTabBarProps.layout.pinnedTopSidecarId, 'context-monitor');
    await lastTabBarProps.onSelectTopSplitTab('__extensions__');
    await flush();
    assert.equal(lastTabBarProps.layout.pinnedTopSidecarId, '__extensions__');
    assert.equal(sharedLayout.workspaceLayouts['c:/proj/one'].pinnedTopSidecarId, '__extensions__');
    assert.equal(sharedSession.get('hangar.activeTabId:c:/proj/one'), '__extensions__');

    // Switching to Project 2 must NOT inherit Project 1's selected Extensions tab
    currentWsPath = 'C:\\Proj\\Two';
    onWorkspaceChange(['file:///c%3A/Proj/Two']);
    await flush();
    assert.equal(lastTabBarProps.layout.pinnedTopSidecarId, 'context-monitor');

    // Switching back to Project 1 restores Project 1's selected Extensions tab
    currentWsPath = 'C:\\Proj\\One';
    onWorkspaceChange(['file:///c%3A/Proj/One']);
    await flush();
    assert.equal(lastTabBarProps.layout.pinnedTopSidecarId, '__extensions__');
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
      const el = {
        tagName: tag.toUpperCase(),
        className: '',
        textContent: '',
        dataset: {},
        style: {},
        classList: fakeClassList(),
        children: [],
        appendChild(c) { this.children.push(c); return c; },
        remove() {},
        querySelector: () => null,
        addEventListener() {},
      };
      return el;
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

    // 1. splitscreen_vertical_add, play_arrow, keep, globe, and pause must match HEAD:ui/core.js PATHS
    const splitVertSvg = window.Hangar.iconSvg('splitscreen_vertical_add', 15);
    const codeBlocksSvg = window.Hangar.iconSvg('code_blocks', 15);
    assert.notEqual(splitVertSvg, codeBlocksSvg);
    assert.match(splitVertSvg, /M180-160q-24\.75 0-42\.37-17\.63Q120-195\.25 120-220v-520/);
    assert.match(window.Hangar.iconSvg('play_arrow', 15), /M340-236\.16V-723\.84L723\.07-480L340-236\.16Z/);
    assert.match(window.Hangar.iconSvg('keep', 16), /M620-471\.54L691\.54-400v60H510v220L480-90/);
    assert.match(window.Hangar.iconSvg('globe', 16), /M480-80q-82 0-155-31\.5t-127\.5-86/);
    assert.match(window.Hangar.iconSvg('pause', 16), /M530-220V-740H740v520H530Zm-310,0V-740H430v520H220Z/);

    // 2. Live host postMessage theme must not be clobbered by subsequent /api/state poll
    // and must not write static --agy-canvas inline when --background is present
    window.Hangar.applyThemePayload({
      themeType: 'light',
      cssVariables: {
        '--background': '#fafafa',
        '--foreground': '#111111',
        '--agy-canvas': '#181818',
        '--agy-ink-soft': 'rgba(17, 17, 17, 0.6)',
      },
    }, true);
    assert.equal(document.body.classList.has('theme-light'), true);
    assert.equal(inlineProps.get('--background'), '#fafafa');
    assert.equal(inlineProps.has('--agy-canvas'), false);
    assert.equal(inlineProps.has('--agy-ink-soft'), false);

    window.Hangar.applyThemePayload({
      themeType: 'dark',
      cssVariables: {
        '--background': '#181818',
        '--foreground': '#ffffff',
        '--agy-canvas': '#181818',
      },
    }, false);
    assert.equal(document.body.classList.has('theme-light'), true);
    assert.equal(inlineProps.get('--background'), '#fafafa');

    // 3. AgyUI.showToast respects opts.container
    const hostContainer = {
      querySelector: () => null,
      appendChild: (c) => customContainerChildren.push(c),
    };
    window.AgyUI.showToast('Sent to Side Chat', { container: hostContainer });
    assert.equal(customContainerChildren.length, 1);
    assert.equal(docBodyChildren.length, 0);
  });

  it('opens Terminal in the opposite Top/Bottom Split Pane and auto-enables Split View when triggered from Side Chat', async () => {
    const sharedSession = new Map();
    const sessionStorage = {
      getItem: (k) => sharedSession.get(k) || '',
      setItem: (k, v) => sharedSession.set(k, String(v)),
      removeItem: (k) => sharedSession.delete(k),
    };
    let sharedLayout = { pinnedTopSidecarId: '__sidechat__', topSplitTabIds: ['__sidechat__'], closedTabIds: ['__terminal__'], tabOrder: [], splitViewEnabled: false };
    let liveTerminals = [];
    let mainTermOpen = false;
    let sideChatDockCb = null;
    let lastTabBarProps = null;
    let lastTermSlotsProps = null;
    let lastSideChatSlotProps = null;
    const layoutUpdates = [];

    const window = {
      location: { search: '?conversationId=conv-split-term' },
      addEventListener() {},
      Hangar: {
        EXTENSIONS_TAB_ID: '__extensions__',
        TERMINAL_TAB_ID: '__terminal__',
        SIDECHAT_TAB_ID: '__sidechat__',
        SIDECHAT_TAB_PREFIX: 'sidechat__',
        isMainTerminalOpen: () => mainTermOpen,
        setMainTerminalOpen: (v) => { mainTermOpen = Boolean(v); },
        getInstanceTerminals: (terms) => terms || [],
        getSideChatState: () => ({ isOpen: true, isDocked: true, threads: [{ cascadeId: 'sc-1', title: 'Side Chat #1' }] }),
        serializeSideChatState: () => ({ isOpen: true, isDocked: true, threads: [{ cascadeId: 'sc-1', title: 'Side Chat #1' }] }),
        serializeTerminalState: () => ({ mainTerminalOpen: mainTermOpen }),
        setSideChatDockCallback: (cb) => { sideChatDockCb = cb; },
        renderTerminalSlots: (props) => { lastTermSlotsProps = props; },
        renderSideChatSlot: (props) => { lastSideChatSlotProps = props; },
        apiCall: async (path, body) => {
          if (path === '/api/state') {
            return {
              activeWorkspace: { workspacePath: 'C:\\Proj\\One', workspaceName: 'One' },
              sidecars: [{ sidecarId: 'context-monitor', displayName: 'Context Monitor', matchesWorkspace: true, isRunning: true }],
              terminals: [...liveTerminals],
              layout: JSON.parse(JSON.stringify(sharedLayout)),
            };
          }
          if (path === '/api/terminal/create') {
            const created = { terminalId: 'term-created-1', title: 'pwsh' };
            liveTerminals = [...liveTerminals, created];
            return created;
          }
          if (path === '/api/layout/update') {
            layoutUpdates.push(body);
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
      window,
      document,
      URLSearchParams,
      sessionStorage,
      console,
      Date,
      setTimeout,
      setInterval: () => 0,
    });
    vm.runInContext(readFileSync(join(UI_DIR, 'components/tab-bar.js'), 'utf8'), ctx, { filename: 'tab-bar.js' });
    window.Hangar.renderTabBar = (props) => { lastTabBarProps = props; };
    vm.runInContext(readFileSync(join(UI_DIR, 'app.js'), 'utf8'), ctx, { filename: 'app.js' });
    await flush();

    // Case 1: Side Chat in Single View (top pane) with no existing terminals -> creates terminal, enables Split View, keeps Side Chat in top pane, opens Terminal in bottom pane
    assert.equal(lastTabBarProps.layout.splitViewEnabled, false);
    await sideChatDockCb({ openTerminal: true, pane: 'top', sourceTabId: '__sidechat__' });
    await flush();
    assert.equal(mainTermOpen, true);
    assert.equal(liveTerminals.length, 1);
    assert.equal(lastTabBarProps.layout.splitViewEnabled, true);
    assert.equal(lastTabBarProps.layout.pinnedTopSidecarId, '__sidechat__');
    assert.ok(lastTabBarProps.layout.topSplitTabIds.includes('__sidechat__'));
    assert.equal(lastTabBarProps.layout.topSplitTabIds.includes('__terminal__'), false);
    assert.equal(lastTabBarProps.layout.closedTabIds.includes('__terminal__'), false);
    assert.equal(lastTabBarProps.bottomActiveTabId, '__terminal__');
    assert.equal(lastTermSlotsProps.topSlotId, '__sidechat__');
    assert.equal(lastTermSlotsProps.bottomSlotId, '__terminal__');
    assert.equal(lastSideChatSlotProps.topSlotId, '__sidechat__');
    assert.equal(lastSideChatSlotProps.bottomSlotId, '__terminal__');

    // Case 2: Side Chat in Bottom Pane with existing terminal -> keeps Side Chat in bottom pane and activates Terminal in top pane
    await sideChatDockCb({ openTerminal: true, pane: 'bottom', sourceTabId: '__sidechat__' });
    await flush();
    assert.equal(liveTerminals.length, 1);
    assert.equal(lastTabBarProps.layout.splitViewEnabled, true);
    assert.equal(lastTabBarProps.layout.pinnedTopSidecarId, '__terminal__');
    assert.ok(lastTabBarProps.layout.topSplitTabIds.includes('__terminal__'));
    assert.equal(lastTabBarProps.layout.topSplitTabIds.includes('__sidechat__'), false);
    assert.equal(lastTabBarProps.bottomActiveTabId, '__sidechat__');
    assert.equal(lastTermSlotsProps.topSlotId, '__terminal__');
    assert.equal(lastTermSlotsProps.bottomSlotId, '__sidechat__');
    assert.equal(lastSideChatSlotProps.topSlotId, '__terminal__');
    assert.equal(lastSideChatSlotProps.bottomSlotId, '__sidechat__');
    assert.equal(layoutUpdates.at(-1).splitViewEnabled, true);
  });

  it('prevents an in-flight /api/state poll during /api/terminal/create from clobbering the new terminal or split layout', async () => {
    const sharedSession = new Map();
    const sessionStorage = {
      getItem: (k) => sharedSession.get(k) || '',
      setItem: (k, v) => sharedSession.set(k, String(v)),
      removeItem: (k) => sharedSession.delete(k),
    };
    let sharedLayout = { pinnedTopSidecarId: '__sidechat__', topSplitTabIds: ['__sidechat__'], closedTabIds: [], tabOrder: [], splitViewEnabled: false };
    let mainTermOpen = false;
    let sideChatDockCb = null;
    let lastTabBarProps = null;
    let intervalTick = null;
    let now = 0;
    let pendingCreateResolve = null;
    let pendingStateResolve = null;

    const window = {
      location: { search: '?conversationId=conv-race-term' },
      addEventListener() {},
      Hangar: {
        EXTENSIONS_TAB_ID: '__extensions__',
        TERMINAL_TAB_ID: '__terminal__',
        SIDECHAT_TAB_ID: '__sidechat__',
        SIDECHAT_TAB_PREFIX: 'sidechat__',
        isMainTerminalOpen: () => mainTermOpen,
        setMainTerminalOpen: (v) => { mainTermOpen = Boolean(v); },
        getInstanceTerminals: (terms) => terms || [],
        hydrateTerminalStateFromLayout: (layout, terms) => {
          const closed = new Set(layout?.closedTabIds || []);
          mainTermOpen = !closed.has('__terminal__') && (terms || []).length > 0;
        },
        getSideChatState: () => ({ isOpen: true, isDocked: true, threads: [{ cascadeId: 'sc-1', title: 'Side Chat #1' }] }),
        serializeSideChatState: () => ({ isOpen: true, isDocked: true, threads: [{ cascadeId: 'sc-1', title: 'Side Chat #1' }] }),
        serializeTerminalState: () => ({ mainTerminalOpen: mainTermOpen }),
        setSideChatDockCallback: (cb) => { sideChatDockCb = cb; },
        apiCall: (path, body) => {
          if (path === '/api/state') {
            const snapLayout = JSON.parse(JSON.stringify(sharedLayout));
            if (pendingCreateResolve && !pendingStateResolve) {
              return new Promise((r) => {
                pendingStateResolve = () => r({
                  activeWorkspace: { workspacePath: 'C:\\Proj\\One', workspaceName: 'One' },
                  sidecars: [{ sidecarId: 'context-monitor', displayName: 'Context Monitor', matchesWorkspace: true, isRunning: true }],
                  terminals: [],
                  layout: snapLayout,
                });
              });
            }
            return Promise.resolve({
              activeWorkspace: { workspacePath: 'C:\\Proj\\One', workspaceName: 'One' },
              sidecars: [{ sidecarId: 'context-monitor', displayName: 'Context Monitor', matchesWorkspace: true, isRunning: true }],
              terminals: [],
              layout: snapLayout,
            });
          }
          if (path === '/api/terminal/create') {
            return new Promise((r) => { pendingCreateResolve = r; });
          }
          if (path === '/api/layout/update') {
            const prevWsLayouts = sharedLayout.workspaceLayouts || {};
            sharedLayout = { ...sharedLayout, ...body };
            if (body.workspaceLayouts) sharedLayout.workspaceLayouts = { ...prevWsLayouts, ...body.workspaceLayouts };
            return Promise.resolve({ ok: true, layout: sharedLayout });
          }
          return Promise.resolve({});
        },
      },
    };
    window.parent = {};
    const document = { hidden: false, getElementById: () => null, addEventListener() {}, querySelectorAll: () => [] };
    const ctx = vm.createContext({
      window,
      document,
      URLSearchParams,
      sessionStorage,
      console,
      Date: { now: () => now },
      setTimeout,
      setInterval: (fn) => {
        intervalTick ??= fn;
        return 0;
      },
    });
    vm.runInContext(readFileSync(join(UI_DIR, 'components/tab-bar.js'), 'utf8'), ctx, { filename: 'tab-bar.js' });
    window.Hangar.renderTabBar = (props) => { lastTabBarProps = props; };
    vm.runInContext(readFileSync(join(UI_DIR, 'app.js'), 'utf8'), ctx, { filename: 'app.js' });
    await flush();

    // Start openTerminal -> pauses at /api/terminal/create
    const openProm = sideChatDockCb({ openTerminal: true, pane: 'top', sourceTabId: '__sidechat__' });
    await flush();
    assert.ok(pendingCreateResolve);

    // A 3s /api/state poll starts while /api/terminal/create is still in flight
    now += 3000;
    intervalTick();
    await flush();
    assert.ok(pendingStateResolve);

    // /api/terminal/create resolves first, updating layoutSeq and state.terminals
    pendingCreateResolve({ terminalId: 'term-race-1', title: 'pwsh' });
    await openProm;
    await flush();
    assert.equal(lastTabBarProps.layout.splitViewEnabled, true);
    assert.equal(lastTabBarProps.bottomActiveTabId, '__terminal__');

    // Now the stale /api/state poll (with terminals: [] and splitViewEnabled: false) resolves
    pendingStateResolve();
    await flush();
    assert.equal(mainTermOpen, true);
    assert.equal(lastTabBarProps.layout.splitViewEnabled, true);
    assert.equal(lastTabBarProps.layout.pinnedTopSidecarId, '__sidechat__');
    assert.equal(lastTabBarProps.bottomActiveTabId, '__terminal__');
    assert.deepEqual(Array.from(lastTabBarProps.terminals, (t) => t.terminalId), ['term-race-1']);
  });
});

