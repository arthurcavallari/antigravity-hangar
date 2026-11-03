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
});
