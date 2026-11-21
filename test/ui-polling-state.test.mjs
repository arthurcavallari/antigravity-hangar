import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const flush = async () => {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setImmediate(r));
  }
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
        addEventListener: (type, fn) => {
          listeners[type] = fn;
        },
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
  for (const rel of ['core.js', 'components/tab-bar.js', 'components/iframe-deck.js']) {
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

describe('Hangar UI polling load and iframe deck visibility', () => {
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

    cm.load();
    other.load();
    assert.deepEqual(visibility(cm), [true, true]);
    assert.deepEqual(visibility(other), [false, false]);

    ns.reconcileIframeDeck({ state, els });
    assert.equal(visibility(cm).length, 2);
    state.layout = { ...state.layout, pinnedTopSidecarId: 'other' };
    ns.reconcileIframeDeck({ state, els });
    assert.deepEqual(visibility(cm), [true, true, false]);
    assert.deepEqual(visibility(other), [false, false, true]);
    assert.ok(other.classList.has('visible') && !cm.classList.has('visible'));

    state.sidecars[0].iframeUrl = 'http://127.0.0.1:51001/?conversationId=conv-next';
    ns.reconcileIframeDeck({ state, els });
    const convMsgs = () =>
      cm.posted.filter((m) => m.type === 'conversation-change').map((m) => m.payload.conversationId);
    assert.deepEqual(convMsgs(), ['conv-next']);
    assert.equal(frames.length, 2);

    const tabMode = ns.partitionSplitTabs(state.sidecars, {
      pinnedTopSidecarId: '__extensions__',
      extensionsDisplayMode: 'tab',
      terminalDisplayMode: 'tab',
    });
    assert.equal(tabMode.workspaceTabs.some((t) => t.sidecarId === '__extensions__'), true);
    assert.equal(tabMode.workspaceTabs.some((t) => t.sidecarId === '__terminal__'), true);
    const btnMode = ns.partitionSplitTabs(state.sidecars, {
      pinnedTopSidecarId: '__extensions__',
      extensionsDisplayMode: 'button',
      terminalDisplayMode: 'button',
    });
    assert.equal(btnMode.workspaceTabs.some((t) => t.sidecarId === '__extensions__'), false);
    assert.equal(btnMode.workspaceTabs.some((t) => t.sidecarId === '__terminal__'), false);
    assert.equal(btnMode.activeSingleId, '__extensions__');
    const termBtnActive = ns.partitionSplitTabs(state.sidecars, {
      pinnedTopSidecarId: '__terminal__',
      terminalDisplayMode: 'button',
    });
    assert.equal(termBtnActive.activeSingleId, '__terminal__');

    const splitBtnState = {
      sidecars: [sidecar('context-monitor', 51001)],
      layout: {
        pinnedTopSidecarId: 'context-monitor',
        topSplitTabIds: ['context-monitor'],
        splitViewEnabled: true,
        terminalDisplayMode: 'button',
      },
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

    for (let i = 0; i < 5; i++) {
      now += 3000;
      intervalTick();
    }
    await flush();
    assert.equal(requests.length, 1);

    onWorkspaceChange(['file:///c%3A/proj']);
    await answer();
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].body.workspaceUris, ['file:///c%3A/proj']);
    await answer();
    assert.equal(inFlight().length, 0);

    now += 3000;
    intervalTick();
    await flush();
    assert.equal(requests.length, 3);
  });

  it('SH-02: delegates Antigravity 2.31.0+ Permissions-Policy allow attributes on child, terminal, and sidechat iframes', () => {
    const expected =
      'clipboard-read; clipboard-write; microphone; fullscreen; bluetooth; autoplay; publickey-credentials-get *; publickey-credentials-create *';
    const { ns, frames, els } = loadDeck();
    assert.equal(ns.SIDECAR_IFRAME_ALLOW, expected);
    ns.reconcileIframeDeck({
      state: {
        layout: { pinnedTopSidecarId: 'context-monitor', topSplitTabIds: ['context-monitor'] },
        sidecars: [{ sidecarId: 'context-monitor', matchesWorkspace: true, isRunning: true, iframeUrl: 'http://127.0.0.1:51001/' }],
      },
      els,
    });
    assert.equal(frames[0].allow, expected);
    assert.match(readFileSync(join(UI_DIR, 'components/terminal-pane.js'), 'utf8'), /SIDECAR_IFRAME_ALLOW/);
    assert.match(readFileSync(join(UI_DIR, 'components/sidechat-pane.js'), 'utf8'), /SIDECAR_IFRAME_ALLOW/);
  });

  it('SH-03: relays sidecar-key-event, add-artifact-comment, toggle-conversation { split }, and toggle-aux-pane from child and jetbox iframes', () => {
    const parentPosted = [];
    const msgListeners = [];
    const jetboxWin = {};
    const document = {
      createElement() {
        const f = { ...fakeElement(), contentWindow: {} };
        return f;
      },
      querySelectorAll: () => [{ contentWindow: jetboxWin }],
    };
    const window = {
      innerHeight: 800,
      parent: { postMessage: (d) => parentPosted.push(d) },
      addEventListener: (ev, fn) => {
        if (ev === 'message') msgListeners.push(fn);
      },
    };
    const ctx = vm.createContext({ window, document, URL });
    for (const rel of ['core.js', 'components/tab-bar.js', 'components/iframe-deck.js']) {
      vm.runInContext(readFileSync(join(UI_DIR, rel), 'utf8'), ctx, { filename: rel });
    }
    window.Hangar.initPostMessageRelayBridge();
    const childWin = {};
    const els = {
      mainViewport: fakeElement(),
      splitDividerGroup: fakeElement(),
      storeView: fakeElement(),
      emptyTopState: fakeElement(),
      emptyDeckState: fakeElement(),
    };
    document.createElement = () => ({ ...fakeElement(), contentWindow: childWin, addEventListener() {}, remove() {} });
    window.Hangar.reconcileIframeDeck({
      state: {
        layout: { pinnedTopSidecarId: 'cm', topSplitTabIds: ['cm'] },
        sidecars: [{ sidecarId: 'cm', matchesWorkspace: true, isRunning: true, iframeUrl: 'http://127.0.0.1:51001/' }],
      },
      els,
    });

    const emit = (source, data) => msgListeners.forEach((fn) => fn({ source, data }));
    emit(childWin, { type: 'sidecar-key-event', payload: { key: 'b', ctrlKey: true } });
    emit(childWin, { type: 'add-artifact-comment', payload: { filePath: '/plan.md', commentText: 'ok' } });
    emit(childWin, { type: 'request-credential-refresh' });
    emit(jetboxWin, { type: 'sidecar-key-event', payload: { key: 'j', ctrlKey: true } });
    emit(jetboxWin, { type: 'toggle-conversation', payload: { split: true } });
    emit({}, { type: 'sidecar-key-event', payload: { key: 'p', ctrlKey: true } }); // untrusted source ignored

    assert.deepEqual(parentPosted, [
      { type: 'sidecar-key-event', payload: { key: 'b', ctrlKey: true } },
      { type: 'add-artifact-comment', payload: { filePath: '/plan.md', commentText: 'ok' } },
      { type: 'request-credential-refresh' },
      { type: 'sidecar-key-event', payload: { key: 'j', ctrlKey: true } },
      { type: 'toggle-conversation', payload: { split: true } },
    ]);
  });

  it('SH-08: hydrates initial workspaceUris via window.sidecar.getWorkspaceUris() before the first /api/state poll', async () => {
    const requests = [];
    const window = {
      location: { search: '' },
      addEventListener() {},
      sidecar: {
        getWorkspaceUris: async () => ['file:///c%3A/Users/arthu/IdeaProjects/antigravity-sidecar-hub'],
        onWorkspaceChange() {},
      },
      Hangar: {
        partitionSplitTabs: () => ({ workspaceTabs: [], topTabs: [], bottomTabs: [], topSet: new Set() }),
        apiCall: (path, body) => {
          if (path === '/api/state') requests.push(body);
          return new Promise(() => {});
        },
      },
    };
    window.parent = {};
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
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].workspaceUris, ['file:///c%3A/Users/arthu/IdeaProjects/antigravity-sidecar-hub']);
  });

  it('relays new-conversation from child and jetbox iframes to window.parent and drops untrusted sources', () => {
    const parentPosted = [];
    const msgListeners = [];
    const jetboxWin = {};
    const childWin = {};
    const document = {
      createElement: () => ({ ...fakeElement(), contentWindow: childWin, addEventListener() {}, remove() {} }),
      querySelectorAll: () => [{ contentWindow: jetboxWin }],
    };
    const window = {
      innerHeight: 800,
      parent: { postMessage: (d) => parentPosted.push(d) },
      addEventListener: (ev, fn) => {
        if (ev === 'message') msgListeners.push(fn);
      },
    };
    const ctx = vm.createContext({ window, document, URL });
    for (const rel of ['core.js', 'components/tab-bar.js', 'components/iframe-deck.js']) {
      vm.runInContext(readFileSync(join(UI_DIR, rel), 'utf8'), ctx, { filename: rel });
    }
    window.Hangar.initPostMessageRelayBridge();
    window.Hangar.reconcileIframeDeck({
      state: {
        layout: { pinnedTopSidecarId: 'cm', topSplitTabIds: ['cm'] },
        sidecars: [{ sidecarId: 'cm', matchesWorkspace: true, isRunning: true, iframeUrl: 'http://127.0.0.1:51001/' }],
      },
      els: {
        mainViewport: fakeElement(),
        splitDividerGroup: fakeElement(),
        storeView: fakeElement(),
        emptyTopState: fakeElement(),
        emptyDeckState: fakeElement(),
      },
    });

    const emit = (source, data) => msgListeners.forEach((fn) => fn({ source, data }));
    emit(childWin, { type: 'new-conversation' });
    emit(jetboxWin, { type: 'new-conversation' });
    emit({}, { type: 'new-conversation' });
    emit(window.parent, { type: 'new-conversation' });
    emit(null, { type: 'new-conversation' });

    assert.deepEqual(parentPosted, [
      { type: 'new-conversation' },
      { type: 'new-conversation' },
    ]);
  });

  it('syncs ?urlSync=1 initSubpath, outbound tab/subtab pushes, echo-free host-url-change, Alt+Arrow history steps, and keeps sidecar.json AUX_PANE-only', async () => {
    const { parseHTML } = await import('linkedom');
    const { AGY_CLIENT_JS } = await import('antigravity-sidecar-kit/shell');
    const { buildAgyUiJs } = await import('antigravity-sidecar-kit/ui');

    const sidecarJson = JSON.parse(readFileSync(join(UI_DIR, '..', 'sidecar.json'), 'utf8'));
    assert.deepEqual(
      sidecarJson.ui_config?.views?.map((v) => v.entrypoint),
      ['SIDECAR_UI_ENTRYPOINT_AUX_PANE'],
    );

    const mountHangar = async (search) => {
      const indexHtml = readFileSync(join(UI_DIR, 'index.html'), 'utf8');
      const { window, document, CustomEvent, Event, HTMLElement, DocumentFragment, Node } = parseHTML(indexHtml);
      const parentPosted = [];
      const winListeners = new Map();
      const origWinAdd = window.addEventListener?.bind(window);
      const origWinRemove = window.removeEventListener?.bind(window);
      window.addEventListener = (type, fn, opts) => {
        if (!winListeners.has(type)) winListeners.set(type, new Set());
        winListeners.get(type).add(fn);
        origWinAdd?.(type, fn, opts);
      };
      window.removeEventListener = (type, fn, opts) => {
        winListeners.get(type)?.delete(fn);
        origWinRemove?.(type, fn, opts);
      };
      const parentWin = {
        postMessage: (msg) => parentPosted.push(msg),
      };
      Object.defineProperty(window, 'parent', { value: parentWin, configurable: true });
      Object.defineProperty(window, 'location', {
        value: {
          search,
          origin: 'http://127.0.0.1:51000',
          href: `http://127.0.0.1:51000/${search}`,
          protocol: 'http:',
        },
        configurable: true,
      });
      window.innerHeight = 800;
      const CSS = { escape: (s) => String(s) };
      window.CSS = CSS;
      const store = new Map();
      const makeStorage = () => ({
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
      });
      const sessionStorage = makeStorage();
      const localStorage = makeStorage();
      window.sessionStorage = sessionStorage;
      window.localStorage = localStorage;

      const ctx = vm.createContext({
        window,
        document,
        CustomEvent,
        Event,
        HTMLElement,
        DocumentFragment,
        Node,
        CSS,
        URL,
        URLSearchParams,
        sessionStorage,
        localStorage,
        console,
        Date,
        setTimeout,
        clearTimeout,
        setInterval: () => 0,
        clearInterval,
      });

      vm.runInContext(AGY_CLIENT_JS, ctx, { filename: 'shell.js' });
      vm.runInContext(buildAgyUiJs('all'), ctx, { filename: 'ui.js' });
      for (const rel of [
        'core.js',
        'components/tab-bar.js',
        'components/marketplace-panes.js',
        'components/plugin-panes.js',
        'components/installed-pane.js',
        'components/extensions-tab.js',
        'components/iframe-deck.js',
        'components/terminal-groups.js',
        'components/sidechat-store.js',
        'components/layout-controller.js',
      ]) {
        vm.runInContext(readFileSync(join(UI_DIR, rel), 'utf8'), ctx, { filename: rel });
      }

      window.Hangar.apiCall = async (path) => {
        if (path === '/api/state') {
          return {
            activeWorkspace: { workspacePath: 'C:/Proj/Hub', workspaceName: 'Hub' },
            sidecars: [
              {
                sidecarId: 'context-monitor',
                displayName: 'Context Monitor',
                matchesWorkspace: true,
                isRunning: true,
                iframeUrl: 'http://127.0.0.1:51001/',
              },
              {
                sidecarId: 'agy-plugin-porter/cockpit',
                displayName: 'Porter Cockpit',
                matchesWorkspace: true,
                isRunning: true,
                iframeUrl: 'http://127.0.0.1:51002/',
              },
            ],
            terminals: [],
            layout: {
              pinnedTopSidecarId: 'context-monitor',
              topSplitTabIds: ['context-monitor'],
              closedTabIds: ['__extensions__'],
              extensionsDisplayMode: 'tab',
              splitViewEnabled: false,
            },
          };
        }
        if (path === '/api/store/registry') {
          return { packages: [] };
        }
        return { ok: true };
      };

      vm.runInContext(readFileSync(join(UI_DIR, 'app.js'), 'utf8'), ctx, { filename: 'app.js' });
      await flush();

      const emitParentMessage = (data) => {
        for (const fn of [...(winListeners.get('message') || [])]) {
          fn({ source: parentWin, data });
        }
      };

      return { window, document, parentPosted, emitParentMessage };
    };

    const { window, document, parentPosted, emitParentMessage } = await mountHangar(
      '?urlSync=1&initSubpath=extensions%2Fdiscover',
    );
    const ns = window.Hangar;
    const toPlain = (v) => JSON.parse(JSON.stringify(v));

    // Codec round-trips and WLc validation
    assert.equal(ns.encodeHangarSubpath('__terminal__'), 'terminal');
    assert.deepEqual(toPlain(ns.decodeHangarSubpath('terminal')), { activeTabId: '__terminal__' });
    assert.equal(ns.encodeHangarSubpath('terminal__term-77'), 'terminal/term-77');
    assert.deepEqual(toPlain(ns.decodeHangarSubpath('terminal/term-77')), { activeTabId: 'terminal__term-77' });
    assert.equal(ns.encodeHangarSubpath('__sidechat__'), 'sidechat');
    assert.deepEqual(toPlain(ns.decodeHangarSubpath('sidechat')), { activeTabId: '__sidechat__' });
    assert.equal(ns.encodeHangarSubpath('__extensions__', 'installed'), 'extensions');
    assert.equal(ns.encodeHangarSubpath('__extensions__', 'discover'), 'extensions/discover');
    assert.equal(ns.encodeHangarSubpath('__extensions__', 'sideload'), 'extensions/sideload');
    assert.equal(ns.encodeHangarSubpath('__extensions__', 'settings'), 'extensions/settings');
    assert.deepEqual(toPlain(ns.decodeHangarSubpath('extensions')), {
      activeTabId: '__extensions__',
      extSubTab: 'installed',
    });
    assert.deepEqual(toPlain(ns.decodeHangarSubpath('extensions/discover')), {
      activeTabId: '__extensions__',
      extSubTab: 'discover',
    });
    assert.equal(ns.encodeHangarSubpath('agy-plugin-porter/cockpit'), 'tab/agy-plugin-porter%2Fcockpit');
    assert.deepEqual(toPlain(ns.decodeHangarSubpath('tab/agy-plugin-porter%2Fcockpit')), {
      activeTabId: 'agy-plugin-porter/cockpit',
    });
    assert.equal(ns.decodeHangarSubpath(''), null);
    assert.equal(ns.decodeHangarSubpath('extensions/invalid'), null);
    assert.equal(ns.decodeHangarSubpath('unknown/foo'), null);
    assert.equal(ns.decodeHangarSubpath('tab/%E0%A4%A'), null);
    assert.equal(ns.decodeHangarSubpath('tab/..'), null);
    assert.equal(ns.decodeHangarSubpath('tab/~q=token=secret'), null);

    // 1. Deep-linked initSubpath=extensions%2Fdiscover survives /api/state hydration (and un-closes closedTabIds) with 0 outbound url changes
    const urlChanges = () => toPlain(parentPosted.filter((m) => m.type === 'sidecar-url-change'));
    const storeView = document.getElementById('store-view');
    assert.equal(storeView.classList.contains('hidden'), false);
    assert.equal(ns.getExtensionsSubTab(), 'discover');
    assert.equal(storeView.querySelector('[data-role="pane-discover"]').classList.contains('hidden'), false);
    assert.equal(
      document.querySelector('.agy-tab.active[data-sidecar-id]')?.dataset?.sidecarId,
      '__extensions__',
    );
    assert.deepEqual(urlChanges(), []);

    // 2. Switching to agy-plugin-porter/cockpit posts sidecar-url-change with replace: false
    document.querySelector('.agy-tab[data-sidecar-id="agy-plugin-porter/cockpit"]').click();
    await flush();
    assert.deepEqual(urlChanges(), [
      {
        type: 'sidecar-url-change',
        payload: { subpath: 'tab/agy-plugin-porter%2Fcockpit', replace: false },
      },
    ]);

    // 3. Receiving host-url-change { subpath: 'terminal' } switches active tab to __terminal__ with 0 echo messages
    const beforeEchoCount = urlChanges().length;
    emitParentMessage({ type: 'host-url-change', payload: { subpath: 'terminal' } });
    await flush();
    assert.equal(
      document.querySelector('.agy-tab.active[data-sidecar-id]')?.dataset?.sidecarId,
      '__terminal__',
    );
    assert.equal(urlChanges().length, beforeEchoCount);

    // 4. Inbound extensions/settings switches subtab with 0 echo, and user clicking sideload pushes replace: false
    emitParentMessage({ type: 'host-url-change', payload: { subpath: 'extensions/settings' } });
    await flush();
    assert.equal(storeView.classList.contains('hidden'), false);
    assert.equal(ns.getExtensionsSubTab(), 'settings');
    assert.equal(urlChanges().length, beforeEchoCount);

    storeView.querySelector('[data-subtab="sideload"]').click();
    await flush();
    assert.deepEqual(urlChanges().at(-1), {
      type: 'sidecar-url-change',
      payload: { subpath: 'extensions/sideload', replace: false },
    });

    // Top-bar extensions toggle button also pushes replace: false when toggling back to last non-extensions tab (__terminal__)
    document.getElementById('extensions-toggle-btn').click();
    await flush();
    assert.deepEqual(urlChanges().at(-1), {
      type: 'sidecar-url-change',
      payload: { subpath: 'terminal', replace: false },
    });

    // 5. Alt+ArrowLeft / Alt+ArrowRight step history outside editable inputs, ignored inside inputs
    const historySteps = () => toPlain(parentPosted.filter((m) => m.type === 'sidecar-history-step'));
    const makeKeyEvent = (key) => {
      const ev = new window.Event('keydown', { bubbles: true, cancelable: true });
      return Object.assign(ev, { key, altKey: true, ctrlKey: false, metaKey: false, shiftKey: false });
    };
    const backEv = makeKeyEvent('ArrowLeft');
    document.body.dispatchEvent(backEv);
    assert.equal(backEv.defaultPrevented, true);

    const fwdEv = makeKeyEvent('ArrowRight');
    document.body.dispatchEvent(fwdEv);
    assert.equal(fwdEv.defaultPrevented, true);

    const inputEl = document.createElement('input');
    document.body.appendChild(inputEl);
    const inputEv = makeKeyEvent('ArrowLeft');
    inputEl.dispatchEvent(inputEv);
    assert.equal(inputEv.defaultPrevented, false);

    assert.deepEqual(historySteps(), [
      { type: 'sidecar-history-step', payload: { delta: -1 } },
      { type: 'sidecar-history-step', payload: { delta: 1 } },
    ]);

    // 6. Default hydration without initSubpath syncs active tab with replace: true
    const defaultMount = await mountHangar('?urlSync=1');
    assert.deepEqual(
      toPlain(defaultMount.parentPosted.filter((m) => m.type === 'sidecar-url-change')),
      [{ type: 'sidecar-url-change', payload: { subpath: 'tab/context-monitor', replace: true } }],
    );
  });
});
