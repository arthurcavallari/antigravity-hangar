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

describe('Hangar Side Chat openTerminal split-pane routing and poll race protection', () => {
  it('opens Terminal in the opposite Top/Bottom Split Pane and auto-enables Split View when triggered from Side Chat', async () => {
    const sharedSession = new Map();
    const sessionStorage = {
      getItem: (k) => sharedSession.get(k) || '',
      setItem: (k, v) => sharedSession.set(k, String(v)),
      removeItem: (k) => sharedSession.delete(k),
    };
    let sharedLayout = {
      pinnedTopSidecarId: '__sidechat__',
      topSplitTabIds: ['__sidechat__'],
      closedTabIds: ['__terminal__'],
      tabOrder: [],
      splitViewEnabled: false,
    };
    let [liveTerminals, mainTermOpen, sideChatDockCb, lastTabBarProps, lastTermSlotsProps, lastSideChatSlotProps] = [[], false, null, null, null, null];
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
        setMainTerminalOpen: (v) => {
          mainTermOpen = Boolean(v);
        },
        getInstanceTerminals: (terms) => terms || [],
        getSideChatState: () => ({ isOpen: true, isDocked: true, threads: [{ cascadeId: 'sc-1', title: 'Side Chat #1' }] }),
        serializeSideChatState: () => ({ isOpen: true, isDocked: true, threads: [{ cascadeId: 'sc-1', title: 'Side Chat #1' }] }),
        serializeTerminalState: () => ({ mainTerminalOpen: mainTermOpen }),
        setSideChatDockCallback: (cb) => {
          sideChatDockCb = cb;
        },
        renderTerminalSlots: (props) => {
          lastTermSlotsProps = props;
        },
        renderSideChatSlot: (props) => {
          lastSideChatSlotProps = props;
        },
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
    let sharedLayout = {
      pinnedTopSidecarId: '__sidechat__',
      topSplitTabIds: ['__sidechat__'],
      closedTabIds: [],
      tabOrder: [],
      splitViewEnabled: false,
    };
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
        setMainTerminalOpen: (v) => {
          mainTermOpen = Boolean(v);
        },
        getInstanceTerminals: (terms) => terms || [],
        hydrateTerminalStateFromLayout: (layout, terms) => {
          const closed = new Set(layout?.closedTabIds || []);
          mainTermOpen = !closed.has('__terminal__') && (terms || []).length > 0;
        },
        getSideChatState: () => ({ isOpen: true, isDocked: true, threads: [{ cascadeId: 'sc-1', title: 'Side Chat #1' }] }),
        serializeSideChatState: () => ({ isOpen: true, isDocked: true, threads: [{ cascadeId: 'sc-1', title: 'Side Chat #1' }] }),
        serializeTerminalState: () => ({ mainTerminalOpen: mainTermOpen }),
        setSideChatDockCallback: (cb) => {
          sideChatDockCb = cb;
        },
        apiCall: (path, body) => {
          if (path === '/api/state') {
            const snapLayout = JSON.parse(JSON.stringify(sharedLayout));
            const snapResp = {
              activeWorkspace: { workspacePath: 'C:\\Proj\\One', workspaceName: 'One' },
              sidecars: [{ sidecarId: 'context-monitor', displayName: 'Context Monitor', matchesWorkspace: true, isRunning: true }],
              terminals: [],
              layout: snapLayout,
            };
            if (pendingCreateResolve && !pendingStateResolve) {
              return new Promise((r) => {
                pendingStateResolve = () => r(snapResp);
              });
            }
            return Promise.resolve(snapResp);
          }
          if (path === '/api/terminal/create') {
            return new Promise((r) => {
              pendingCreateResolve = r;
            });
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
      window, document, URLSearchParams, sessionStorage, console,
      Date: { now: () => now }, setTimeout,
      setInterval: (fn) => {
        intervalTick ??= fn;
        return 0;
      },
    });
    for (const rel of ['core.js', 'components/tab-bar.js', 'components/layout-controller.js']) {
      vm.runInContext(readFileSync(join(UI_DIR, rel), 'utf8'), ctx, { filename: rel });
    }
    window.Hangar.renderTabBar = (props) => {
      lastTabBarProps = props;
    };
    vm.runInContext(readFileSync(join(UI_DIR, 'app.js'), 'utf8'), ctx, { filename: 'app.js' });
    await flush();

    const openProm = sideChatDockCb({ openTerminal: true, pane: 'top', sourceTabId: '__sidechat__' });
    await flush();
    assert.ok(pendingCreateResolve);

    now += 3000;
    intervalTick();
    await flush();
    assert.ok(pendingStateResolve);

    pendingCreateResolve({ terminalId: 'term-race-1', title: 'pwsh' });
    await openProm;
    await flush();
    assert.equal(lastTabBarProps.layout.splitViewEnabled, true);
    assert.equal(lastTabBarProps.bottomActiveTabId, '__terminal__');

    pendingStateResolve();
    await flush();
    assert.equal(mainTermOpen, true);
    assert.equal(lastTabBarProps.layout.splitViewEnabled, true);
    assert.equal(lastTabBarProps.layout.pinnedTopSidecarId, '__sidechat__');
    assert.equal(lastTabBarProps.bottomActiveTabId, '__terminal__');
    assert.deepEqual(Array.from(lastTabBarProps.terminals, (t) => t.terminalId), ['term-race-1']);
  });
});
