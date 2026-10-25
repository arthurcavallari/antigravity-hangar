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
});
