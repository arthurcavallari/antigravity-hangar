import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { buildAgyUiJs } from 'antigravity-sidecar-kit/ui';
import { extractNativeSideQuestions, extractSideQuestionMeta } from '../lib/state-orchestrator.mjs';
import {
  checkJetboxAuth,
  closeTerminalSideChatStreams,
  deleteTerminalSideChat,
  pollChatStream,
  promoteTerminalSideChat,
  registerJetboxProxyRoutes,
  startTerminalSideChat,
} from '../lib/jetbox-proxy.mjs';
import { markHangarSideChatId, noteObservedLiveSideChatIds } from '../lib/jetbox-sidechat.mjs';

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

  it('keeps Side Chat tab active and open when Quote & Ask races with /api/state or when clicking the Side Chat tab directly (Issue #4)', async () => {
    const sharedSession = new Map([['hangar.activeTabId:c:/proj/theme', 'context-monitor']]);
    const sessionStorage = {
      getItem: (k) => sharedSession.get(k) || '',
      setItem: (k, v) => sharedSession.set(k, String(v)),
      removeItem: (k) => sharedSession.delete(k),
    };
    const localStorage = {
      getItem: () => null,
      setItem() {},
      removeItem() {},
    };
    let sharedLayout = {
      pinnedTopSidecarId: 'context-monitor',
      topSplitTabIds: ['context-monitor'],
      closedTabIds: ['__sidechat__'],
      tabOrder: ['context-monitor', '__sidechat__'],
      splitViewEnabled: false,
      workspaceLayouts: {
        'c:/proj/theme': {
          pinnedTopSidecarId: 'context-monitor',
          topSplitTabIds: ['context-monitor'],
          closedTabIds: ['__sidechat__'],
          tabOrder: ['context-monitor', '__sidechat__'],
          splitViewEnabled: false,
        },
      },
    };
    let pendingStartResolve = null;
    const deletedCascades = [];
    let lastTabBarProps = null;
    let firstPoll = true;

    const makeEl = (tag = 'div') => ({
      tagName: tag.toUpperCase(),
      className: '',
      dataset: {},
      style: { setProperty() {} },
      children: [],
      classList: {
        _s: new Set(),
        add(...c) { c.forEach((x) => this._s.add(x)); },
        remove(...c) { c.forEach((x) => this._s.delete(x)); },
        toggle(c, f) {
          const on = f === undefined ? !this._s.has(c) : Boolean(f);
          this._s[on ? 'add' : 'delete'](c);
          return on;
        },
        contains(c) { return this._s.has(c); },
      },
      appendChild(ch) { this.children.push(ch); ch.parentElement = this; return ch; },
      append(...chs) { chs.forEach((c) => this.appendChild(c)); },
      remove() {},
      contains(ch) { return this.children.includes(ch); },
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
    });
    const viewportEl = makeEl('div');
    const document = {
      hidden: false,
      body: makeEl('body'),
      createElement: (t) => makeEl(t),
      getElementById: (id) => (id === 'main-viewport' ? viewportEl : null),
      addEventListener() {},
      querySelectorAll: () => [],
    };
    const window = {
      location: { search: '?conversationId=conv-quote-race' },
      addEventListener() {},
      Hangar: {
        apiCall: (path, body) => {
          if (path === '/api/state') {
            const wsPath = firstPoll ? '' : 'C:\\Proj\\Theme';
            firstPoll = false;
            return Promise.resolve({
              activeWorkspace: { workspacePath: wsPath, workspaceName: wsPath ? 'Theme' : 'Detecting...' },
              sidecars: [{ sidecarId: 'context-monitor', displayName: 'Context Monitor', matchesWorkspace: true, isRunning: true }],
              terminals: [],
              layout: JSON.parse(JSON.stringify(sharedLayout)),
            });
          }
          if (path === '/api/terminal/sidechat/start') {
            return new Promise((r) => {
              pendingStartResolve = () => r({ cascadeId: body.cascadeId || 'sc-started-1' });
            });
          }
          if (path === '/api/terminal/sidechat/delete') {
            deletedCascades.push(body.cascadeId);
            return Promise.resolve({ ok: true });
          }
          if (path === '/api/layout/update') {
            const prevWsLayouts = sharedLayout.workspaceLayouts || {};
            const prevScByWs = sharedLayout.sideChatStateByWorkspace || {};
            sharedLayout = { ...sharedLayout, ...body };
            if (body.workspaceLayouts) sharedLayout.workspaceLayouts = { ...prevWsLayouts, ...body.workspaceLayouts };
            if (body.sideChatStateByWorkspace) sharedLayout.sideChatStateByWorkspace = { ...prevScByWs, ...body.sideChatStateByWorkspace };
            return Promise.resolve({ ok: true, layout: sharedLayout });
          }
          return Promise.resolve({});
        },
      },
    };
    window.parent = {};
    const ctx = vm.createContext({
      window, document, URLSearchParams, sessionStorage, localStorage, console, Date, setTimeout,
      setInterval: () => 0,
    });
    for (const rel of [
      'core.js',
      'components/terminal-groups.js',
      'components/sidechat-store.js',
      'components/sidechat-strip.js',
      'components/sidechat-pane.js',
      'components/terminal-quote.js',
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

    // User triggers Quote & Ask before workspacePath resolves and while /api/terminal/sidechat/start is in flight
    window.Hangar.openTerminalQuoteComposer(
      viewportEl,
      { terminalId: 'term-1', cleanName: 'pwsh', selectionContent: 'dir output', promptText: 'hello', autoSubmit: true },
      { conversationId: 'conv-quote-race', forceNewThread: true }
    );
    await flush();
    assert.equal(lastTabBarProps.layout.pinnedTopSidecarId, '__sidechat__');
    assert.ok(pendingStartResolve);

    // /api/state poll resolves with workspacePath 'C:\\Proj\\Theme' while StartCascade is still in flight
    window.sidecar?.onWorkspaceChange?.(['file:///c:/Proj/Theme']);
    await flush();

    // Now StartCascade finishes
    pendingStartResolve();
    await flush();

    assert.deepEqual(deletedCascades, [], 'ensureSideChatThread must not abort and delete the cascade when hydration runs mid-flight');
    assert.equal(window.Hangar.getSideChatState().isOpen, true);
    assert.equal(window.Hangar.getSideChatState().threads.length, 1);
    assert.equal(lastTabBarProps.layout.pinnedTopSidecarId, '__sidechat__', 'must stay on __sidechat__ and never snap back to context-monitor');
    assert.equal(lastTabBarProps.layout.closedTabIds.includes('__sidechat__'), false);

    // Switch to context-monitor, then click the Side Chat tab directly
    await lastTabBarProps.onSelectTopSplitTab('context-monitor');
    await flush();
    assert.equal(lastTabBarProps.layout.pinnedTopSidecarId, 'context-monitor');

    await lastTabBarProps.onSelectTopSplitTab('__sidechat__');
    await flush();
    assert.equal(lastTabBarProps.layout.pinnedTopSidecarId, '__sidechat__');
    assert.equal(window.Hangar.getSideChatState().isOpen, true);
  });

  it('extractNativeSideQuestions extracts parent annotations and falls back to resident child titles', () => {
    assert.equal(extractNativeSideQuestions({ trajectorySummaries: {} }, ''), null);
    assert.equal(extractNativeSideQuestions({ trajectorySummaries: {} }, '_new'), null);
    assert.equal(extractNativeSideQuestions({ trajectorySummaries: {} }, 'conv-missing'), null);

    const extracted = extractNativeSideQuestions(
      {
        trajectorySummaries: {
          'conv-main': {
            annotations: {
              sideQuestionCascadeIds: ['sq-1', 'sq-2', 'sq-1'],
              sideQuestionTitles: { 'sq-1': '  Check   Redis TTL  ' },
            },
          },
          'sq-2': {
            annotations: { title: 'Fallback Child Title' },
          },
        },
      },
      'conv-main',
    );
    assert.deepEqual(extracted, {
      conversationId: 'conv-main',
      cascadeIds: ['sq-1', 'sq-2'],
      titles: {
        'sq-1': 'Check Redis TTL',
        'sq-2': 'Fallback Child Title',
      },
    });
  });

  it('supports hideFromAntigravity in startTerminalSideChat, safe promoteTerminalSideChat, and extractSideQuestionMeta', async () => {
    const startCalls = [];
    const hiddenRes = await startTerminalSideChat({
      parentConversationId: 'conv-parent-99',
      cascadeId: 'sq-hidden-1',
      hideFromAntigravity: true,
      rpcFn: async (method, body) => {
        startCalls.push({ method, body });
        return {};
      },
    });
    assert.equal(hiddenRes.cascadeId, 'sq-hidden-1');
    assert.equal(hiddenRes.parentConversationId, '');
    assert.equal(hiddenRes.hiddenFromAntigravity, true);
    assert.deepEqual(startCalls, [
      {
        method: 'StartCascade',
        body: { cascadeId: 'sq-hidden-1', trajectoryType: 22, source: 12 },
      },
    ]);

    // registerJetboxProxyRoutes uses getHideHangarSideQuestions when hideFromAntigravity is omitted
    const apis = new Map();
    const routeCalls = [];
    registerJetboxProxyRoutes(
      { page() {}, api: (p, fn) => apis.set(p, fn) },
      {
        getHideHangarSideQuestions: () => true,
        rpcFn: async (method, body) => {
          routeCalls.push({ method, body });
          return {};
        },
      },
    );
    const viaRoute = await apis.get('/api/terminal/sidechat/start')({
      parentConversationId: 'conv-parent-99',
      cascadeId: 'sq-hidden-route',
    });
    assert.equal(viaRoute.parentConversationId, '');
    assert.equal(routeCalls[0].body.baseTrajectoryIdentifier, undefined);

    // promoteTerminalSideChat: aborts WITHOUT deleting when ForkConversation fails or omits newCascadeId
    const failedCalls = [];
    await assert.rejects(
      () =>
        promoteTerminalSideChat({
          cascadeId: 'sq-keep-on-fail',
          rpcFn: async (method, body) => {
            failedCalls.push({ method, body });
            return {};
          },
        }),
      /no conversation/i,
    );
    assert.equal(
      failedCalls.some((c) => c.method === 'DeleteCascadeTrajectory'),
      false,
      'must never delete source side question when ForkConversation returns no newCascadeId',
    );

    // promoteTerminalSideChat: forks at step -1 and deletes ephemeral trajectory on success
    const promoteCalls = [];
    const promoted = await promoteTerminalSideChat({
      cascadeId: 'sq-promote-1',
      rpcFn: async (method, body) => {
        promoteCalls.push({ method, body });
        if (method === 'ForkConversation') {
          return { newCascadeId: 'conv-promoted-777', newProjectId: 'proj-1' };
        }
        return {};
      },
    });
    assert.deepEqual(promoted, {
      ok: true,
      cascadeId: 'sq-promote-1',
      newCascadeId: 'conv-promoted-777',
      newProjectId: 'proj-1',
      warnings: [],
    });
    assert.deepEqual(promoteCalls, [
      {
        method: 'ForkConversation',
        body: { sourceCascadeId: 'sq-promote-1', forkAtStepIndex: -1, targetForkWorkspace: 1 },
      },
      {
        method: 'DeleteCascadeTrajectory',
        body: { cascadeId: 'sq-promote-1' },
      },
    ]);

    // Promoted trajectory must never be resurrected by a late iframe pollChatStream
    const resurrectRes = pollChatStream({
      conversationId: '00000000-0000-4000-8000-000000000099',
      subscriberId: 'late-sub',
      afterSeq: 5,
      fetchFn: null,
    });
    assert.equal(resurrectRes.closed, true);
    const promotedUuid = '11111111-2222-4333-8444-555555555555';
    await promoteTerminalSideChat({
      cascadeId: promotedUuid,
      rpcFn: async (method) => (method === 'ForkConversation' ? { newCascadeId: 'conv-forked-uuid' } : {}),
    });
    const postPromotePoll = pollChatStream({
      conversationId: promotedUuid,
      subscriberId: 'late-sub',
      afterSeq: 0,
      fetchFn: null,
    });
    assert.equal(postPromotePoll.closed, true);
    assert.deepEqual(postPromotePoll.chunks, []);

    // extractSideQuestionMeta captures running status, stepCount, and title for both native and hidden standalone SIDE_QUESTION trajectories
    const meta = extractSideQuestionMeta(
      {
        trajectorySummaries: {
          'conv-main': { status: 2, stepCount: 10 },
          'sq-native-idle': { trajectoryType: 1, stepCount: 4, status: 1, summary: 'Native idle' },
          'sq-hidden-busy': {
            trajectoryType: 22,
            stepCount: 6,
            status: 'CASCADE_RUN_STATUS_RUNNING',
            annotations: { title: '  Hidden   Debug  ' },
          },
          'sq-killed': {
            trajectoryType: 'CORTEX_TRAJECTORY_TYPE_SIDE_QUESTION',
            stepCount: 2,
            status: 2,
            killed: true,
            summary: 'Killed thread',
          },
        },
      },
      { conversationId: 'conv-main', cascadeIds: ['sq-native-idle'], titles: {} },
    );
    assert.deepEqual(meta, {
      'sq-native-idle': { isRunning: false, stepCount: 4, title: 'Native idle' },
      'sq-hidden-busy': { isRunning: true, stepCount: 6, title: 'Hidden Debug' },
      'sq-killed': { isRunning: false, stepCount: 2, title: 'Killed thread' },
    });
  });

  it('prevents native/Hangar resurrection, enforces cold-open pollChatStream gate, prunes parent annotations, and hardens ls-rpc & checkJetboxAuth', async () => {
    const apis = new Map();
    const lsCalls = [];
    registerJetboxProxyRoutes(
      { page() {}, api: (p, fn) => apis.set(p, fn) },
      {
        getHideHangarSideQuestions: () => true,
        rpcFn: async (method, body) => {
          lsCalls.push({ method, body });
          if (method === 'GetCascadeTrajectory') throw new Error('cascade not_found');
          return {};
        },
      },
    );
    assert.equal(apis.has('/api/terminal/sidechat/promote'), false, 'duplicate promote route removed');

    // 1. /api/terminal/ls-rpc must NEVER resurrect a not_found UUID via StartCascade
    const nativeDeletedUuid = 'aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb';
    await apis.get('/api/terminal/ls-rpc')({
      method: 'GetCascadeTrajectory',
      body: { cascadeId: nativeDeletedUuid },
    });
    assert.equal(
      lsCalls.some((c) => c.method === 'StartCascade'),
      false,
      '/api/terminal/ls-rpc must never auto-create cascades on not_found',
    );

    // 2. /api/terminal/ls-rpc blocks global permission mutations and enforces hideFromAntigravity on StartCascade
    for (const blocked of ['UpdatePermissionSettings', 'DeletePlugin']) {
      await assert.rejects(
        () => apis.get('/api/terminal/ls-rpc')({ method: blocked, body: {} }),
        /Disallowed Jetbox RPC/,
      );
    }
    await apis.get('/api/terminal/ls-rpc')({
      method: 'StartCascade',
      body: { cascadeId: 'cccccccc-1111-4222-8333-dddddddddddd', baseTrajectoryIdentifier: { cascadeId: 'conv-p' } },
    });
    assert.equal(lsCalls.at(-1)?.body?.baseTrajectoryIdentifier, undefined);

    // 3. /api/terminal/sidechat/close-stream with markDeleted: true blocks late pollChatStream
    const prunedNativeUuid = 'eeeeeeee-1111-4222-8333-ffffffffffff';
    await apis.get('/api/terminal/sidechat/close-stream')({ cascadeId: prunedNativeUuid, markDeleted: true });
    assert.equal(pollChatStream({ conversationId: prunedNativeUuid, subscriberId: 's1' }).closed, true);

    // 4. Cold-open pollChatStream gate: only hangarOwnedIds && seq === 0 && !observedLiveIds && !autoStartedIds && !deleted
    const origLsAddr = process.env.ANTIGRAVITY_LS_ADDRESS;
    const origCsrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
    process.env.ANTIGRAVITY_LS_ADDRESS = '127.0.0.1:59999';
    process.env.ANTIGRAVITY_CSRF_TOKEN = 'csrf-test';
    try {
      const autoStartCalls = [];
      const makeNotFoundFetch = () => async () => {
        const trailerPayload = Buffer.from(JSON.stringify({ error: { code: 'not_found', message: 'not found' } }), 'utf8');
        const frame = Buffer.alloc(5 + trailerPayload.length);
        frame[0] = 2;
        frame.writeUInt32BE(trailerPayload.length, 1);
        trailerPayload.copy(frame, 5);
        return {
          ok: true,
          body: new ReadableStream({
            start(ctrl) {
              ctrl.enqueue(frame);
              ctrl.close();
            },
          }),
        };
      };

      // Unowned external UUID -> must NOT auto-start
      const unownedUuid = '22222222-1111-4222-8333-111111111111';
      pollChatStream({
        conversationId: unownedUuid,
        subscriberId: 'sub-ext',
        fetchFn: makeNotFoundFetch(),
        rpcFn: async (m, b) => autoStartCalls.push({ m, b }),
      });
      await flush();
      assert.equal(autoStartCalls.length, 0, 'unowned external UUID must never auto-start');

      // Owned UUID already observed live -> must NOT auto-start
      const observedUuid = '33333333-1111-4222-8333-111111111111';
      markHangarSideChatId(observedUuid);
      noteObservedLiveSideChatIds([observedUuid]);
      pollChatStream({
        conversationId: observedUuid,
        subscriberId: 'sub-obs',
        fetchFn: makeNotFoundFetch(),
        rpcFn: async (m, b) => autoStartCalls.push({ m, b }),
      });
      await flush();
      assert.equal(autoStartCalls.length, 0, 'already-observed live UUID must never auto-start when deleted natively');

      // Brand-new cold Hangar-owned UUID -> auto-starts AT MOST ONCE across reconnects
      const coldOwnedUuid = '44444444-1111-4222-8333-111111111111';
      markHangarSideChatId(coldOwnedUuid);
      pollChatStream({
        conversationId: coldOwnedUuid,
        subscriberId: 'sub-cold-1',
        fetchFn: makeNotFoundFetch(),
        rpcFn: async (m, b) => autoStartCalls.push({ m, b }),
      });
      await flush();
      assert.equal(autoStartCalls.length, 1);
      closeTerminalSideChatStreams({ cascadeId: coldOwnedUuid });
      pollChatStream({
        conversationId: coldOwnedUuid,
        subscriberId: 'sub-cold-2',
        fetchFn: makeNotFoundFetch(),
        rpcFn: async (m, b) => autoStartCalls.push({ m, b }),
      });
      await flush();
      assert.equal(autoStartCalls.length, 1, 'autoStartedIds prevents repeated StartCascade across reconnects');
    } finally {
      if (origLsAddr === undefined) delete process.env.ANTIGRAVITY_LS_ADDRESS;
      else process.env.ANTIGRAVITY_LS_ADDRESS = origLsAddr;
      if (origCsrf === undefined) delete process.env.ANTIGRAVITY_CSRF_TOKEN;
      else process.env.ANTIGRAVITY_CSRF_TOKEN = origCsrf;
    }

    // 5. deleteTerminalSideChat rolls back deletedSideChatIds and rethrows on real RPC failure, and prunes parent annotations + extractNativeSideQuestions filters deleted IDs
    const failingDelUuid = '55555555-1111-4222-8333-111111111111';
    await assert.rejects(
      () =>
        deleteTerminalSideChat({
          cascadeId: failingDelUuid,
          rpcFn: async () => {
            throw new Error('HTTP 500 cascade busy');
          },
        }),
      /500/,
    );
    assert.equal(
      pollChatStream({ conversationId: failingDelUuid, subscriberId: 'check-not-poisoned', fetchFn: null }).closed,
      false,
      'failed delete must roll back deletedSideChatIds so live stream is not poisoned',
    );
    closeTerminalSideChatStreams({ cascadeId: failingDelUuid });

    const parentSummaries = {
      'conv-parent-1': {
        annotations: {
          sideQuestionCascadeIds: ['sq-del-ok', 'sq-keep-ok'],
          sideQuestionTitles: { 'sq-del-ok': 'Gone', 'sq-keep-ok': 'Alive' },
        },
      },
      'sq-del-ok': { trajectoryType: 22, stepCount: 2 },
      'sq-keep-ok': { trajectoryType: 22, stepCount: 3 },
    };
    const parentPatchCalls = [];
    await deleteTerminalSideChat({
      cascadeId: 'sq-del-ok',
      parentConversationId: 'conv-parent-1',
      rpcFn: async (method, body) => {
        if (method === 'GetAllCascadeTrajectories') return { trajectorySummaries: parentSummaries };
        if (method === 'UpdateConversationAnnotations') parentPatchCalls.push(body);
        if (method === 'DeleteCascadeTrajectory') delete parentSummaries[body.cascadeId];
        return {};
      },
    });
    const extractedAfterDel = extractNativeSideQuestions(
      { trajectorySummaries: parentSummaries, deletedIds: [] },
      'conv-parent-1',
    );
    assert.deepEqual(extractedAfterDel.cascadeIds, ['sq-keep-ok']);
    assert.equal(parentPatchCalls.some((b) => Array.isArray(b.annotations?.sideQuestionCascadeIds)), true);

    // 6. checkJetboxAuth ignores spoofed x-codeium-csrf-token when query token is valid and rejects cross-site Sec-Fetch-Site
    const origUiTok = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN;
    process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN = 'valid-secret-tok';
    try {
      const okWithProxyCsrf = checkJetboxAuth(
        {},
        {
          headers: { origin: 'http://127.0.0.1:61234', 'x-codeium-csrf-token': 'hangar-jetbox-proxy' },
          query: { token: 'valid-secret-tok' },
        },
      );
      assert.equal(okWithProxyCsrf.ok, true);
      const blockedCrossSite = checkJetboxAuth(
        {},
        {
          headers: { 'sec-fetch-site': 'cross-site', cookie: 'hangar_jetbox_tok=valid-secret-tok' },
        },
      );
      assert.equal(blockedCrossSite.ok, false);
    } finally {
      if (origUiTok === undefined) delete process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN;
      else process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN = origUiTok;
    }
  });

  it('syncs native /btw Side Questions, bidirectional titles, stale-poll protection, and native Promote/Delete pruning', async () => {
    const sharedSession = new Map([['hangar.activeTabId:c:/proj/sync', 'context-monitor']]);
    const sessionStorage = {
      getItem: (k) => sharedSession.get(k) || '',
      setItem: (k, v) => sharedSession.set(k, String(v)),
      removeItem: (k) => sharedSession.delete(k),
    };
    const localMap = new Map();
    const localStorage = {
      getItem: (k) => localMap.get(k) ?? null,
      setItem: (k, v) => localMap.set(k, String(v)),
      removeItem: (k) => localMap.delete(k),
    };
    let sharedLayout = {
      pinnedTopSidecarId: 'context-monitor',
      topSplitTabIds: ['context-monitor'],
      closedTabIds: [],
      tabOrder: ['context-monitor'],
      splitViewEnabled: false,
    };
    let currentConvId = 'conv-sync-a';
    let nativePayload = {
      conversationId: 'conv-sync-a',
      cascadeIds: ['sq-btw-1'],
      titles: { 'sq-btw-1': 'Check port 5432' },
    };
    const renameRequests = [];
    let lastTabBarProps = null;
    let intervalTick = null;
    let now = 1000;

    const makeEl = (tag = 'div') => ({
      tagName: tag.toUpperCase(),
      className: '',
      dataset: {},
      style: { setProperty() {} },
      children: [],
      classList: {
        _s: new Set(),
        add(...c) { c.forEach((x) => this._s.add(x)); },
        remove(...c) { c.forEach((x) => this._s.delete(x)); },
        toggle(c, f) {
          const on = f === undefined ? !this._s.has(c) : Boolean(f);
          this._s[on ? 'add' : 'delete'](c);
          return on;
        },
        contains(c) { return this._s.has(c); },
      },
      appendChild(ch) { this.children.push(ch); ch.parentElement = this; return ch; },
      append(...chs) { chs.forEach((c) => this.appendChild(c)); },
      remove() {
        if (this.parentElement) {
          this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
        }
      },
      contains(ch) { return this.children.includes(ch); },
      setAttribute(k, v) { this[k] = v; },
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
    });
    const viewportEl = makeEl('div');
    const document = {
      hidden: false,
      body: makeEl('body'),
      createElement: (t) => makeEl(t),
      getElementById: (id) => (id === 'main-viewport' ? viewportEl : null),
      addEventListener() {},
      querySelector: () => null,
      querySelectorAll: () => [],
    };
    const window = {
      location: { search: '?conversationId=_new' },
      addEventListener() {},
      Hangar: {
        apiCall: async (path, body) => {
          if (path === '/api/state') {
            return {
              activeWorkspace: {
                workspacePath: 'C:\\Proj\\Sync',
                workspaceName: 'Sync',
                conversationId: currentConvId,
              },
              nativeSideQuestions: JSON.parse(JSON.stringify(nativePayload)),
              sidecars: [{ sidecarId: 'context-monitor', displayName: 'Context Monitor', matchesWorkspace: true, isRunning: true }],
              terminals: [],
              layout: JSON.parse(JSON.stringify(sharedLayout)),
            };
          }
          if (path === '/api/terminal/sidechat/start') {
            return { ok: true, cascadeId: 'sq-hangar-2', parentConversationId: body.parentConversationId };
          }
          if (path === '/api/sidechat/rename') {
            renameRequests.push(body);
            return { ok: true };
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
    const ctx = vm.createContext({
      window, document, URLSearchParams, sessionStorage, localStorage, console,
      Date: { now: () => now }, setTimeout,
      setInterval: (fn) => {
        intervalTick ??= fn;
        return 0;
      },
    });
    for (const rel of [
      'core.js',
      'components/terminal-groups.js',
      'components/sidechat-store.js',
      'components/sidechat-strip.js',
      'components/sidechat-pane.js',
      'components/terminal-quote.js',
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

    // 1. Native /btw thread arrives on /api/state without stealing focus or spawning background iframes
    assert.equal(lastTabBarProps.layout.pinnedTopSidecarId, 'context-monitor');
    assert.equal(viewportEl.children.length, 0, 'must not spawn Side Chat DOM/iframe while context-monitor is active');
    const part1 = window.Hangar.partitionSplitTabs(lastTabBarProps.sidecars, lastTabBarProps.layout, []);
    assert.ok(part1.workspaceTabs.some((t) => t.sidecarId === '__sidechat__'));
    assert.equal(window.Hangar.getSideChatState().threads.length, 1);
    assert.equal(window.Hangar.getSideChatState().threads[0].title, 'Check port 5432');

    // Alt+Shift+L mini-composer lists the native /btw thread
    const mini = window.Hangar.openTerminalMiniComposer(
      makeEl('div'),
      { terminalId: 't1', cleanName: 'pwsh', selectionContent: 'ERR' },
      { conversationId: 'conv-sync-a' },
    );
    mini._setTargetCascadeId('sq-btw-1');
    assert.ok(mini._els.sideChatBtn.innerHTML.includes('Ask in Check port 5432'));

    // 2. User spawns a Hangar Quote & Ask thread; stale /api/state poll BEFORE LS lists sq-hangar-2 must NOT prune it
    window.Hangar.openTerminalQuoteComposer(
      viewportEl,
      { terminalId: 't1', cleanName: 'pwsh', selectionContent: 'netstat', promptText: 'why', autoSubmit: true },
      { conversationId: 'conv-sync-a', forceNewThread: true },
    );
    await flush();
    assert.equal(window.Hangar.getSideChatState().threads.length, 2);
    assert.equal(lastTabBarProps.layout.pinnedTopSidecarId, '__sidechat__');

    // Stale poll still only has ['sq-btw-1']
    now += 3500;
    intervalTick();
    await flush();
    assert.equal(
      window.Hangar.getSideChatState().threads.some((t) => t.cascadeId === 'sq-hangar-2'),
      true,
      'stale /api/state poll must never prune a newly started Hangar Side Chat before LS registers it',
    );

    // 3. LS registers sq-hangar-2 and generates an automatic summary title
    nativePayload = {
      conversationId: 'conv-sync-a',
      cascadeIds: ['sq-btw-1', 'sq-hangar-2'],
      titles: {
        'sq-btw-1': 'Check port 5432',
        'sq-hangar-2': 'Investigate netstat listener',
      },
    };
    now += 3500;
    intervalTick();
    await flush();
    assert.equal(
      window.Hangar.getSideChatState().threads.find((t) => t.cascadeId === 'sq-hangar-2')?.title,
      'Investigate netstat listener',
    );

    // 4. Optimistic Hangar rename resists stale in-flight /api/state poll, settles, then accepts native UI rename
    window.Hangar.recordSideChatRename('sq-hangar-2', 'Hangar Custom Title');
    // Stale poll still carries 'Investigate netstat listener'
    now += 3500;
    intervalTick();
    await flush();
    assert.equal(
      window.Hangar.resolveSideChatTitle(window.Hangar.getSideChatState().threads.find((t) => t.cascadeId === 'sq-hangar-2')),
      'Hangar Custom Title',
    );

    // Server catches up with 'Hangar Custom Title', then user renames in Antigravity's native UI to 'Native Final Title'
    nativePayload.titles['sq-hangar-2'] = 'Hangar Custom Title';
    now += 3500;
    intervalTick();
    await flush();
    nativePayload.titles['sq-hangar-2'] = 'Native Final Title';
    now += 3500;
    intervalTick();
    await flush();
    assert.equal(
      window.Hangar.resolveSideChatTitle(window.Hangar.getSideChatState().threads.find((t) => t.cascadeId === 'sq-hangar-2')),
      'Native Final Title',
    );

    // 5. Native Promote to Conversation / Delete removes both threads -> Hangar prunes frames and falls back to context-monitor
    nativePayload = { conversationId: 'conv-sync-a', cascadeIds: [], titles: {} };
    now += 3500;
    intervalTick();
    await flush();
    assert.equal(window.Hangar.getSideChatState().threads.length, 0);
    assert.equal(window.Hangar.getSideChatState().isOpen, false);
    assert.equal(lastTabBarProps.layout.pinnedTopSidecarId, 'context-monitor');

    // 6. Switching between conversations in the same workspace swaps unpinned native threads cleanly
    nativePayload = {
      conversationId: 'conv-sync-a',
      cascadeIds: ['sq-conv-a'],
      titles: { 'sq-conv-a': 'Thread in Conv A' },
    };
    now += 3500;
    intervalTick();
    await flush();
    assert.deepEqual(Array.from(window.Hangar.getSideChatState().threads, (t) => t.cascadeId), ['sq-conv-a']);

    currentConvId = 'conv-sync-b';
    nativePayload = {
      conversationId: 'conv-sync-b',
      cascadeIds: ['sq-conv-b'],
      titles: { 'sq-conv-b': 'Thread in Conv B' },
    };
    now += 3500;
    intervalTick();
    await flush();
    assert.deepEqual(Array.from(window.Hangar.getSideChatState().threads, (t) => t.cascadeId), ['sq-conv-b']);
  });

  it('renders external badges, showExternalSideQuestions/hideHangarSideQuestions, Promote to Conversation, and inline delete confirmation on real DOM', async () => {
    const indexHtml = readFileSync(join(UI_DIR, 'index.html'), 'utf8');
    const { window, document, CustomEvent, Event, HTMLElement, DocumentFragment, Node, MutationObserver } = parseHTML(indexHtml);
    const sessionMap = new Map();
    const localMap = new Map();
    const sessionStorage = {
      getItem: (k) => sessionMap.get(k) || '',
      setItem: (k, v) => sessionMap.set(k, String(v)),
      removeItem: (k) => sessionMap.delete(k),
    };
    const localStorage = {
      getItem: (k) => localMap.get(k) ?? null,
      setItem: (k, v) => localMap.set(k, String(v)),
      removeItem: (k) => localMap.delete(k),
    };
    const CSS = { escape: (s) => String(s) };
    Object.assign(window, {
      CSS,
      URLSearchParams,
      sessionStorage,
      localStorage,
      location: { search: '?conversationId=conv-dom-1', origin: 'http://127.0.0.1:61234' },
      parent: {},
      innerWidth: 520,
      innerHeight: 760,
    });
    const toggledConversations = [];
    window.sidecar = {
      ui: {
        toggleConversation: (cid) => toggledConversations.push(cid),
      },
      onWorkspaceChange() {},
    };

    let sharedLayout = {
      pinnedTopSidecarId: '__sidechat__',
      topSplitTabIds: ['__sidechat__'],
      closedTabIds: [],
      tabOrder: ['context-monitor', '__sidechat__'],
      splitViewEnabled: false,
      showExternalSideQuestions: true,
      hideHangarSideQuestions: false,
      hideHangarTerminals: true,
    };
    let nativePayload = {
      conversationId: 'conv-dom-1',
      cascadeIds: ['sq-ext-1'],
      titles: { 'sq-ext-1': 'Native /btw Question' },
    };
    let sqMeta = {
      'sq-ext-1': { isRunning: true, stepCount: 4, title: 'Native /btw Question' },
    };
    const startBodies = [];
    const deleteBodies = [];
    const promoteBodies = [];
    const renameBodies = [];
    const closeStreamBodies = [];
    let promoteShouldFail = false;
    let intervalTick = null;
    let now = 5000;
    let activeWs = { workspacePath: 'C:\\Proj\\Dom', workspaceName: 'Dom', conversationId: 'conv-dom-1' };

    window.Hangar = {
      apiCall: async (path, body) => {
        if (path === '/api/state') {
          return {
            activeWorkspace: JSON.parse(JSON.stringify(activeWs)),
            nativeSideQuestions: activeWs.conversationId === 'conv-dom-1' ? JSON.parse(JSON.stringify(nativePayload)) : null,
            sideQuestionMeta: JSON.parse(JSON.stringify(sqMeta)),
            sidecars: [{ sidecarId: 'context-monitor', displayName: 'Context Monitor', matchesWorkspace: true, isRunning: true }],
            terminals: [],
            layout: JSON.parse(JSON.stringify(sharedLayout)),
          };
        }
        if (path === '/api/terminal/sidechat/start') {
          startBodies.push(body);
          return {
            ok: true,
            cascadeId: body.cascadeId,
            parentConversationId: body.hideFromAntigravity ? '' : body.parentConversationId,
          };
        }
        if (path === '/api/terminal/sidechat/delete') {
          deleteBodies.push(body);
          return { ok: true };
        }
        if (path === '/api/terminal/sidechat/close-stream') {
          closeStreamBodies.push(body);
          return { ok: true };
        }
        if (path === '/api/sidechat/rename') {
          renameBodies.push(body);
          return { ok: true };
        }
        if (path === '/api/sidechat/promote') {
          promoteBodies.push(body);
          if (promoteShouldFail) throw new Error('Fork failed upstream');
          nativePayload.cascadeIds = nativePayload.cascadeIds.filter((id) => id !== body.cascadeId);
          return { ok: true, cascadeId: body.cascadeId, newCascadeId: 'conv-promoted-999' };
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
    };

    const ctx = vm.createContext({
      window,
      document,
      CustomEvent,
      Event,
      HTMLElement,
      DocumentFragment,
      Node,
      MutationObserver,
      CSS,
      URLSearchParams,
      URL,
      sessionStorage,
      localStorage,
      console,
      Date: { now: () => now },
      setTimeout,
      clearTimeout,
      setInterval: (fn) => {
        intervalTick ??= fn;
        return 0;
      },
    });
    vm.runInContext(buildAgyUiJs('all'), ctx, { filename: 'ui.js' });
    for (const rel of [
      'core.js',
      'components/tab-bar.js',
      'components/marketplace-panes.js',
      'components/plugin-panes.js',
      'components/installed-pane.js',
      'components/extensions-tab.js',
      'components/iframe-deck.js',
      'components/terminal-emulator.js',
      'components/sidechat-store.js',
      'components/sidechat-strip.js',
      'components/sidechat-pane.js',
      'components/terminal-quote.js',
      'components/terminal-groups.js',
      'components/terminal-drag.js',
      'components/terminal-pane.js',
      'components/terminal-tab.js',
      'components/layout-controller.js',
      'app.js',
    ]) {
      vm.runInContext(readFileSync(join(UI_DIR, rel), 'utf8'), ctx, { filename: rel });
    }
    await flush();

    // 1. Top-bar tab says "Side Questions"; clicking it opens the pane and native /btw pill shows external badge
    const topSideQTab = document.querySelector('#tab-strip .agy-tab[data-sidecar-id="__sidechat__"]');
    assert.ok(topSideQTab);
    assert.match(topSideQTab.textContent, /Side Questions/);
    topSideQTab.click();
    await flush();

    const extPill = document.querySelector('.term-quote-composer [data-role="sessions"] .agy-tab[data-cascade-id="sq-ext-1"]');
    assert.ok(extPill);
    assert.equal(extPill.dataset.external, 'true');
    assert.equal(extPill.querySelector('.agy-tab-ext-badge')?.classList.contains('hidden'), false);

    // 2. Promote button is disabled while sq-ext-1 isRunning === true
    const promoteBtn = document.querySelector('.term-quote-composer [data-role="sidechat-promote"]');
    assert.ok(promoteBtn);
    assert.equal(promoteBtn.disabled, true);
    assert.match(promoteBtn.title, /running/i);

    // 3. Once sq-ext-1 finishes running, Promote enables; failed promote keeps thread; successful promote focuses new conversation without extra delete RPC
    sqMeta['sq-ext-1'].isRunning = false;
    now += 3500;
    intervalTick();
    await flush();
    assert.equal(promoteBtn.disabled, false);

    promoteShouldFail = true;
    promoteBtn.click();
    await flush();
    assert.equal(promoteBodies.length, 1);
    assert.equal(deleteBodies.length, 0);
    assert.equal(window.Hangar.getSideChatState().threads.some((t) => t.cascadeId === 'sq-ext-1'), true);

    promoteShouldFail = false;
    promoteBtn.click();
    await flush();
    assert.equal(promoteBodies.length, 2);
    assert.deepEqual(toggledConversations, ['conv-promoted-999']);
    assert.equal(deleteBodies.length, 0, 'backend /api/sidechat/promote handles trajectory deletion');
    assert.equal(window.Hangar.getSideChatState().threads.some((t) => t.cascadeId === 'sq-ext-1'), false);

    // 4. Native /btw thread arrives again; pinning survives showExternalSideQuestions: true -> false -> true without deleting on LS
    nativePayload.cascadeIds = ['sq-ext-2'];
    nativePayload.titles = { 'sq-ext-2': 'Another /btw' };
    sqMeta['sq-ext-2'] = { isRunning: false, stepCount: 2, title: 'Another /btw' };
    now += 3500;
    intervalTick();
    await flush();
    assert.equal(window.Hangar.getSideChatState().threads.length, 1);
    assert.equal(window.Hangar.getSideChatState().threads[0].isExternal, true);
    document.querySelector('#tab-strip .agy-tab[data-sidecar-id="__sidechat__"]')?.click();
    await flush();

    // Top-bar Side Questions context menu must NOT offer bulk "Delete Side Questions"
    const topTabNow = document.querySelector('#tab-strip .agy-tab[data-sidecar-id="__sidechat__"]');
    topTabNow.dispatchEvent(new Event('contextmenu', { bubbles: true, cancelable: true }));
    await flush();
    assert.equal(
      Array.from(document.querySelectorAll('.agy-context-menu-item')).some((el) => /Delete Side Questions/.test(el.textContent)),
      false,
      'top-bar tab menu must not offer bulk Delete Side Questions',
    );
    window.AgyUI?.closeContextMenu?.();

    // Pin sq-ext-2 via pill context menu, then toggle showExternalSideQuestions false -> true and verify pinned is preserved
    const sqExt2Pill = document.querySelector('.term-quote-composer .agy-tab[data-cascade-id="sq-ext-2"]');
    sqExt2Pill.dispatchEvent(new Event('contextmenu', { bubbles: true, cancelable: true }));
    await flush();
    Array.from(document.querySelectorAll('.agy-context-menu-item')).find((el) => el.textContent.includes('Pin Tab'))?.click();
    await flush();
    assert.equal(window.Hangar.getSideChatState().threads[0].pinned, true);

    sharedLayout.showExternalSideQuestions = false;
    now += 3500;
    intervalTick();
    await flush();
    assert.equal(window.Hangar.getSideChatState().threads.length, 0);
    assert.equal(deleteBodies.length, 0, 'hiding external Side Questions must not delete native threads');

    sharedLayout.showExternalSideQuestions = true;
    now += 3500;
    intervalTick();
    await flush();
    assert.equal(window.Hangar.getSideChatState().threads.length, 1);
    assert.equal(window.Hangar.getSideChatState().threads[0].cascadeId, 'sq-ext-2');
    assert.equal(window.Hangar.getSideChatState().threads[0].pinned, true, 'pinned state survives external toggle round-trip');
    document.querySelector('#tab-strip .agy-tab[data-sidecar-id="__sidechat__"]')?.click();
    await flush();
    // Unpin sq-ext-2 so we can test pill close (×)
    const sqExt2Restored = document.querySelector('.term-quote-composer .agy-tab[data-cascade-id="sq-ext-2"]');
    sqExt2Restored.dispatchEvent(new Event('contextmenu', { bubbles: true, cancelable: true }));
    await flush();
    Array.from(document.querySelectorAll('.agy-context-menu-item')).find((el) => el.textContent.includes('Unpin Tab'))?.click();
    await flush();

    // 5. Closing a pill via × does NOT delete on LS; stays hidden across /api/state polls; reopens from Side Question strip overflow (⋯) menu
    const toolbarDeleteBtn = document.querySelector('.term-quote-composer [data-role="sidechat-delete"]');
    assert.ok(toolbarDeleteBtn);
    assert.equal(toolbarDeleteBtn.classList.contains('hidden'), false, 'toolbar delete button must be visible');

    document.querySelector('.term-quote-composer .agy-tab[data-cascade-id="sq-ext-2"] .agy-tab-close').click();
    await flush();
    assert.equal(deleteBodies.length, 0, 'closing a Side Question pill via × must never call delete');
    assert.equal(window.Hangar.getSideChatState().threads.some((t) => t.cascadeId === 'sq-ext-2'), false);
    now += 3500;
    intervalTick();
    await flush();
    assert.equal(
      window.Hangar.getSideChatState().threads.some((t) => t.cascadeId === 'sq-ext-2'),
      false,
      'closed Side Question pill stays hidden across /api/state polls',
    );
    const scOverflowBtn = document.querySelector('.term-quote-composer [data-role="sidechat-overflow"]');
    assert.ok(scOverflowBtn);
    assert.equal(scOverflowBtn.classList.contains('hidden'), false, 'overflow (⋯) button shows badge when closed threads exist');
    scOverflowBtn.click();
    await flush();
    const reopenBtn = Array.from(document.querySelectorAll('.agy-tab-overflow-item')).find((el) =>
      el.textContent.includes('Another /btw'),
    );
    assert.ok(reopenBtn, 'overflow menu lists closed Side Question for reopening');
    reopenBtn.click();
    await flush();
    assert.equal(window.Hangar.getSideChatState().threads.some((t) => t.cascadeId === 'sq-ext-2'), true);

    // 6. Toolbar delete button: empty Hangar thread deletes immediately without confirm; non-empty thread opens confirmBar & does NOT resurrect on next poll
    sharedLayout.hideHangarSideQuestions = true;
    now += 3500;
    intervalTick();
    await flush();
    const addBtn = document.querySelector('.term-quote-composer [data-role="sidechat-strip-add"]');
    addBtn.click();
    await flush();
    assert.equal(startBodies.at(-1)?.hideFromAntigravity, true);
    const emptyHangarThread = window.Hangar.getSideChatState().threads.find((t) => !t.isExternal);
    assert.ok(emptyHangarThread);
    const confirmBar = document.querySelector('.term-quote-composer [data-role="sidechat-delete-confirm"]');
    assert.equal(confirmBar.classList.contains('hidden'), true);

    toolbarDeleteBtn.click();
    await flush();
    assert.equal(confirmBar.classList.contains('hidden'), true, 'empty thread deletes immediately via toolbar Delete button');
    assert.equal(deleteBodies.at(-1)?.cascadeId, emptyHangarThread.cascadeId);

    // Non-empty thread (sq-ext-2) via toolbar Delete button (and pill context menu "Delete Side Question"): Cancel keeps, Confirm deletes with parentConversationId and stays gone across poll
    assert.equal(window.Hangar.getActiveSideChatId(), 'sq-ext-2');
    toolbarDeleteBtn.click();
    await flush();
    assert.equal(confirmBar.classList.contains('hidden'), false);
    assert.match(confirmBar.textContent, /Another \/btw/);
    confirmBar.querySelector('[data-role="sidechat-delete-cancel"]').click();
    await flush();
    assert.equal(confirmBar.classList.contains('hidden'), true);

    const nonEmptyPill = document.querySelector('.term-quote-composer .agy-tab[data-cascade-id="sq-ext-2"]');
    nonEmptyPill.dispatchEvent(new Event('contextmenu', { bubbles: true, cancelable: true }));
    await flush();
    Array.from(document.querySelectorAll('.agy-context-menu-item')).find((el) => el.textContent.includes('Delete Side Question'))?.click();
    await flush();
    assert.equal(confirmBar.classList.contains('hidden'), false);
    confirmBar.querySelector('[data-role="sidechat-delete-confirm-btn"]').click();
    await flush();
    assert.equal(confirmBar.classList.contains('hidden'), true);
    assert.equal(deleteBodies.at(-1)?.cascadeId, 'sq-ext-2');
    assert.equal(deleteBodies.at(-1)?.parentConversationId, 'conv-dom-1');
    // Even if parent annotations still temporarily list sq-ext-2, client deletedIds prevents zombie resurrection
    now += 3500;
    intervalTick();
    await flush();
    assert.equal(window.Hangar.getSideChatState().threads.some((t) => t.cascadeId === 'sq-ext-2'), false);
    nativePayload.cascadeIds = [];

    // 7. Activity persistence + clearing rename + cross-workspace _new _convId reset + selector injection defense
    sharedLayout.hideHangarSideQuestions = false;
    window.location.search = '';
    activeWs = { workspacePath: 'C:\\Proj\\Beta', workspaceName: 'Beta', conversationId: '_new' };
    now += 3500;
    intervalTick();
    await flush();
    document.querySelector('[data-role="hub-add-tab"]')?.click();
    await flush();
    Array.from(document.querySelectorAll('.agy-context-menu-item')).find((el) => el.textContent.includes('New Side Question'))?.click();
    await flush();
    // Clicking strip + in Workspace Beta (_new) must NOT fork conv-dom-1
    document.querySelector('.term-quote-composer [data-role="sidechat-strip-add"]')?.click();
    await flush();
    assert.equal(startBodies.at(-1)?.parentConversationId, '', 'switching to _new workspace resets box._convId');
    const betaCid = startBodies.at(-1).cascadeId;

    // Simulate user sending message -> hasActivity persisted to sharedLayout immediately
    const chatFrame = document.querySelector('.term-quote-composer .term-sidechat-frame');
    const fakeWin = {};
    Object.defineProperty(chatFrame, 'contentWindow', { value: fakeWin, configurable: true });
    const runEvt = new Event('message');
    Object.assign(runEvt, {
      origin: 'http://127.0.0.1:61234',
      source: fakeWin,
      data: { type: 'hangar-sidechat-run-state', payload: { cascadeId: betaCid, isRunning: false, hasActivity: true } },
    });
    window.dispatchEvent(runEvt);
    await flush();
    const persistedBetaThreads = sharedLayout.sideChatStateByWorkspace?.['c:/proj/beta']?.threads || [];
    assert.equal(
      persistedBetaThreads.find((t) => t.cascadeId === betaCid)?.hasActivity,
      true,
      'hangar-sidechat-run-state must persist hasActivity: true to layout',
    );

    // Clearing custom rename sends title: '' to /api/sidechat/rename
    window.Hangar.recordSideChatRename(betaCid, 'Custom Name');
    const betaPill = document.querySelector(`.term-quote-composer .agy-tab[data-cascade-id="${betaCid}"]`);
    betaPill.dispatchEvent(new Event('dblclick', { bubbles: true }));
    await flush();
    const renameInput = betaPill.querySelector('.agy-rename-input');
    if (renameInput) {
      renameInput.value = '';
      const enterEvt = new Event('keydown', { bubbles: true, cancelable: true });
      enterEvt.key = 'Enter';
      renameInput.dispatchEvent(enterEvt);
      await flush();
      assert.equal(renameBodies.at(-1)?.cascadeId, betaCid);
      assert.equal(renameBodies.at(-1)?.title, '');
    }

    // Selector injection in handleHangarNavigateMessage must not click arbitrary parent DOM elements or throw
    let injectedClicked = false;
    const trapBtn = document.createElement('button');
    trapBtn.setAttribute('data-role', 'trap-btn');
    trapBtn.addEventListener('click', () => { injectedClicked = true; });
    document.body.appendChild(trapBtn);
    assert.doesNotThrow(() => {
      window.Hangar.handleHangarNavigateMessage({
        origin: 'http://127.0.0.1:61234',
        source: {},
        data: { type: 'hangar-navigate', pluginId: 'demo', targetTab: 'nonexistent"], [data-role="trap-btn' },
      });
      window.Hangar.handleHangarNavigateMessage({
        origin: 'http://127.0.0.1:61234',
        source: {},
        data: { type: 'hangar-navigate', pluginId: 'demo', targetTab: 'bad"quote' },
      });
    });
    assert.equal(injectedClicked, false);
  });
});
