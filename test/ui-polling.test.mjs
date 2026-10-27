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
      if (sel.startsWith('.manager-card[data-sidecar-id="')) {
        const id = sel.slice(31, -2);
        return el.dataset?.sidecarId === id;
      }
      if (sel === '.manager-card') return (el.className || '').split(/\s+/).includes('manager-card');
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

    const cmCard = storeViewEl.querySelector('.manager-card[data-sidecar-id="context-monitor"]');
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
    const pluginCard = storeViewEl.querySelector('.manager-card[data-sidecar-id="my-plugin/pane"]');
    const pluginHibBtn = pluginCard.querySelector('[data-role="hibernate-btn"]');
    assert.equal(pluginHibBtn.disabled, true);
    pluginHibBtn.click();
    await flush();
    assert.deepEqual(toggledHib, ['context-monitor']);
  });
});
