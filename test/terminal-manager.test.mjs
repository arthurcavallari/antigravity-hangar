import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import vm from 'node:vm';
import { closeWorkspaceTerminal, createWorkspaceTerminal, encodeConnectFrame, listWorkspaceTerminals, parseConnectFrames, pollTerminalOutput, registerTerminalRoutes, renameWorkspaceTerminal, sendTerminalInput, toWorkspaceFileUri } from '../lib/terminal-manager.mjs';
import { buildJetboxTerminalHtml } from '../lib/jetbox-proxy.mjs';

const REPO_ROOT = join(import.meta.dirname, '..');

describe('Terminal Manager Connect framing, PTY RPCs, Quoting, and VT100 Emulator', () => {
  it('encodes and parses 5-byte Connect frames across fragmented chunk boundaries', () => {
    const f1 = encodeConnectFrame({ output: Buffer.from('hello ').toString('base64'), isScrollback: true });
    const f2 = encodeConnectFrame({ output: Buffer.from('world').toString('base64'), isScrollback: false });
    const f3 = encodeConnectFrame({}, 2), combined = Buffer.concat([f1, f2, f3]);
    const partA = combined.subarray(0, 3), partB = combined.subarray(3, f1.length + 7), partC = combined.subarray(f1.length + 7);

    let res = parseConnectFrames(partA);
    assert.equal(res.frames.length, 0); assert.equal(res.rest.length, 3);
    res = parseConnectFrames(Buffer.concat([res.rest, partB]));
    assert.equal(res.frames.length, 1); assert.equal(res.frames[0].flags, 0); assert.equal(res.frames[0].data.isScrollback, true);
    assert.equal(Buffer.from(res.frames[0].data.output, 'base64').toString('utf8'), 'hello ');
    res = parseConnectFrames(Buffer.concat([res.rest, partC]));
    assert.equal(res.frames.length, 2); assert.equal(Buffer.from(res.frames[0].data.output, 'base64').toString('utf8'), 'world');
    assert.equal(res.frames[1].flags, 2); assert.equal(res.rest.length, 0);
  });

  it('normalizes Windows workspace paths to lowercase drive file:// URIs and filters ListTerminals', async () => {
    assert.equal(toWorkspaceFileUri('C:\\Users\\arthu\\IdeaProjects\\antigravity-sidecar-hub'), 'file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub');
    assert.equal(toWorkspaceFileUri('file:///C%3A/Users/arthu/IdeaProjects/antigravity-sidecar-hub/'), 'file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub');
    const mockRpc = async (method) => {
      assert.equal(method, 'ListTerminals');
      return {
        terminals: [
          { terminalId: 't-match', pid: 1234, title: 'pwsh', workspaceUri: 'file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-hub', cwd: 'C:\\Users\\arthu\\IdeaProjects\\antigravity-sidecar-hub' },
          { terminalId: 't-other', pid: 5678, title: 'bash', workspaceUri: 'file:///c:/other/project', cwd: 'C:\\other\\project' },
        ],
      };
    };
    const list = await listWorkspaceTerminals({ workspacePath: 'c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub', rpcFn: mockRpc });
    assert.equal(list.length, 1); assert.equal(list[0].terminalId, 't-match'); assert.equal(list[0].pid, 1234);
  });

  it('creates a terminal, streams 5-byte Connect output, chains inputOffset acks, renames, and closes cleanly', async () => {
    const prevAddr = process.env.ANTIGRAVITY_LS_ADDRESS, prevCsrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
    process.env.ANTIGRAVITY_LS_ADDRESS = '127.0.0.1:59999'; process.env.ANTIGRAVITY_CSRF_TOKEN = 'test-csrf';
    const rpcCalls = [];
    const mockRpc = async (method, body) => {
      rpcCalls.push({ method, body });
      if (method === 'CreateTerminal') return { terminal: { terminalId: 'term-live-1', pid: 4242, title: 'pwsh', workspaceUri: body.workspaceUri } };
      if (method === 'SendTerminalInput' && body.input) return { ackedOffset: String(Number(body.inputOffset) + Buffer.from(body.input, 'base64').length) };
      return {};
    };
    const boxBytes = Buffer.from('─', 'utf8');
    const streamFrames = Buffer.concat([
      encodeConnectFrame({ output: Buffer.from('\x1b]0;pwsh-custom\x07PS C:\\repo> ').toString('base64'), isScrollback: true, title: 'pwsh-custom' }),
      encodeConnectFrame({ output: Buffer.concat([Buffer.from('npm test '), boxBytes.subarray(0, 1)]).toString('base64'), isScrollback: false }),
      encodeConnectFrame({ output: Buffer.concat([boxBytes.subarray(1), Buffer.from('\r\n')]).toString('base64'), isScrollback: false }),
      encodeConnectFrame({ exitCode: 0 }),
    ]);
    const mockFetch = async () => ({ ok: true, body: new ReadableStream({ start(c) { c.enqueue(streamFrames); c.close(); } }) });
    try {
      const created = await createWorkspaceTerminal({ workspacePath: 'c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub', conversationId: '_new', cols: 120, rows: 32, rpcFn: mockRpc, fetchFn: mockFetch });
      assert.equal(created.terminalId, 'term-live-1'); assert.equal(rpcCalls[0].method, 'CreateTerminal'); assert.equal(rpcCalls[0].body.conversationId, undefined);
      await new Promise((r) => setTimeout(r, 25));
      const polled = pollTerminalOutput({ terminalId: 'term-live-1', afterSeq: 0, fetchFn: mockFetch });
      assert.equal(polled.title, 'pwsh-custom'); assert.equal(polled.exited, true); assert.equal(polled.exitCode, 0);
      assert.equal(polled.chunks.length, 3); assert.equal(polled.chunks[0].isScrollback, true);
      assert.equal(polled.chunks[1].text + polled.chunks[2].text, 'npm test ─\r\n');

      await sendTerminalInput({ terminalId: 'term-live-1', data: 'ls\r', rpcFn: mockRpc, fetchFn: mockFetch });
      const secondSend = await sendTerminalInput({ terminalId: 'term-live-1', data: 'pwd\r', rpcFn: mockRpc, fetchFn: mockFetch });
      assert.equal(secondSend.ackedOffset, 7);
      const inputCalls = rpcCalls.filter((c) => c.method === 'SendTerminalInput' && c.body.input);
      assert.equal(inputCalls.length, 2); assert.equal(inputCalls[0].body.inputOffset, '0'); assert.equal(inputCalls[1].body.inputOffset, '3');

      const renamed = await renameWorkspaceTerminal({ terminalId: 'term-live-1', title: '  api-worker  ', rpcFn: mockRpc });
      assert.deepEqual(renamed, { ok: true, terminalId: 'term-live-1', title: 'api-worker' });
      assert.deepEqual(rpcCalls.find((c) => c.method === 'RenameTerminal')?.body, { terminalId: 'term-live-1', title: 'api-worker' });
      assert.equal(pollTerminalOutput({ terminalId: 'term-live-1', afterSeq: 0, fetchFn: mockFetch }).title, 'api-worker');
      await renameWorkspaceTerminal({ terminalId: 'term-live-1', title: '', rpcFn: mockRpc });
      assert.equal(pollTerminalOutput({ terminalId: 'term-live-1', afterSeq: 0, fetchFn: mockFetch }).title, 'pwsh-custom');

      await closeWorkspaceTerminal({ terminalId: 'term-live-1', rpcFn: mockRpc });
      assert.equal(rpcCalls.at(-1).method, 'CloseTerminal');
    } finally {
      if (prevAddr === undefined) delete process.env.ANTIGRAVITY_LS_ADDRESS; else process.env.ANTIGRAVITY_LS_ADDRESS = prevAddr;
      if (prevCsrf === undefined) delete process.env.ANTIGRAVITY_CSRF_TOKEN; else process.env.ANTIGRAVITY_CSRF_TOKEN = prevCsrf;
    }
  });

  it('serializes TerminalScopeItemSchema for Lexical paste and Cider drag-and-drop', () => {
    const windowObj = { Hangar: {}, navigator: { platform: 'Win32' } };
    const documentObj = { addEventListener() {}, removeEventListener() {}, createElement: () => ({ style: {}, appendChild() {}, remove() {} }), body: { appendChild() {} } };
    const ctx = vm.createContext({ window: windowObj, document: documentObj, navigator: windowObj.navigator, JSON, encodeURIComponent, setTimeout, clearTimeout });
    vm.runInContext(readFileSync(join(REPO_ROOT, 'ui/core.js'), 'utf8'), ctx);
    vm.runInContext(readFileSync(join(REPO_ROOT, 'ui/components/terminal-quote.js'), 'utf8'), ctx);
    const payload = windowObj.Hangar.buildTerminalScopePayload({ terminalId: 'f49811d2-c03f-4484-aa22-be4aa429211d', title: 'pwsh [main]', selectionContent: 'Error: EADDRINUSE: address already in use' });
    assert.equal(payload.cleanName, 'pwsh main'); assert.equal(payload.plainText, '[pwsh main](terminal;f49811d2-c03f-4484-aa22-be4aa429211d) ');
    assert.deepEqual(JSON.parse(payload.contextScopeJson), { terminal: { processId: 'f49811d2-c03f-4484-aa22-be4aa429211d', name: 'pwsh main', selectionContent: 'Error: EADDRINUSE: address already in use' } });
    const lexical = JSON.parse(payload.lexicalJson);
    assert.equal(lexical.namespace, 'chat-editor'); assert.equal(lexical.nodes[0].type, 'contextScopeItemMention');
    assert.equal(lexical.nodes[0].data.data, payload.contextScopeJson); assert.equal(lexical.nodes[1].type, 'text'); assert.equal(lexical.nodes[1].text, ' ');
    let writeTextCalled = false;
    windowObj.navigator.clipboard = { writeText: async () => { writeTextCalled = true; } };
    documentObj.execCommand = () => false;
    windowObj.Hangar.copyTerminalQuoteToClipboard({ terminalId: 't1', title: 'pwsh', selectionContent: 'x', alreadyCopied: true });
    assert.equal(writeTextCalled, false);
  });

  it('builds Aux-Pane-Only jetbox_web bootstrapper HTML with gateway token, gRPC-Web framing, cwd forwarding, and RPC allowlist', async () => {
    const html = buildJetboxTerminalHtml({ cascadeId: 'b1fe4a7d-9d38-4d53-8b92-87dd4d8a0039', terminalId: 'term-99', hostTheme: 'dark', csrfToken: 'csrf-123', uiToken: 'tok-abc' });
    assert.ok(html.includes('"terminalId":"term-99"') && html.includes('/preload.js?token=tok-abc') && html.includes('/jetbox-main.js?token=tok-abc') && html.includes('/compiled_tailwind.css?token=tok-abc'));
    assert.ok(html.includes('application/grpc-web+json') && html.includes('grpc-status: ') && html.includes('aux-pane-v2-session') && html.includes('[data-testid="terminal-split-container"]') && html.includes('hangar-jetbox-pane-focused'));
    assert.ok(html.includes('defaultThemeMode=dark') && html.includes('hangar-jetbox-quote-clicked') && html.includes('application/x-lexical-editor') && html.includes('application/context-scope-item-cider') && html.includes('p?.process'));

    const inlineScript = html.match(/<script>([\s\S]*?)<\/script>/)[1], winListeners = {}, docListeners = {}, posted = [], copiedMime = {};
    const termActiveEl = {
      nodeType: 1, closest: () => termActiveEl,
      __reactFiber$xyz: {
        memoizedProps: { process: { terminalId: 'term-proc-77', title: 'zsh-split' } },
        memoizedState: { memoizedState: { current: { getSelection: () => 'FATAL_ERR_42', clearSelection() { this.cleared = true; } } }, next: null }, return: null,
      },
    };
    const popupBtn = { closest: (sel) => (sel === '.selection-popup button' ? popupBtn : termActiveEl), setAttribute() {} };
    const win = {
      navigator: { userAgent: 'Windows' }, localStorage: { setItem() {} }, history: { replaceState() {} }, customElements: { get: () => false, define() {} },
      requestAnimationFrame: () => 999, cancelAnimationFrame() {},
      fetch: async () => ({ json: async () => ({ title: 'pwsh', cwd: 'C:\\repo\\sub', exited: true, exitCode: 0, chunks: [{ seq: 1, outputBase64: Buffer.from('hi').toString('base64'), isScrollback: false, rawFrame: { output: 'aGk=', cwd: 'C:\\repo\\sub' } }] }) }),
      Response: class { constructor(b) { this.body = b; } }, location: { origin: 'http://localhost:54824' }, parent: { postMessage: (msg) => posted.push(msg) },
      addEventListener: (ev, fn) => { (winListeners[ev] = winListeners[ev] || []).push(fn); },
      getSelection: () => ({ rangeCount: 0, isCollapsed: true, removeAllRanges() {}, addRange() {}, toString: () => '' }),
    };
    const doc = {
      documentElement: { style: { setProperty() {} } }, body: { appendChild() {} }, createElement: () => ({ style: {}, remove() {} }), createRange: () => ({ selectNodeContents() {} }),
      querySelector: (sel) => (sel.includes('terminal-active') ? termActiveEl : null),
      addEventListener: (ev, fn) => { (docListeners[ev] = docListeners[ev] || []).push(fn); },
      removeEventListener: (ev, fn) => { docListeners[ev] = (docListeners[ev] || []).filter((f) => f !== fn); },
      execCommand: (cmd) => { if (cmd === 'copy') for (const fn of docListeners.copy || []) fn({ preventDefault() {}, stopPropagation() {}, clipboardData: { setData: (k, v) => { copiedMime[k] = v; } } }); return true; },
    };
    vm.runInContext(inlineScript, vm.createContext({ window: win, document: doc, navigator: win.navigator, localStorage: win.localStorage, history: win.history, URL, TextEncoder, TextDecoder, Uint8Array, DataView, ReadableStream, JSON, Math, Object, String, Boolean, Number, Map, Date, encodeURIComponent, setTimeout, clearTimeout }));
    let rafFired = false;
    win.requestAnimationFrame(() => { rafFired = true; });
    await new Promise((r) => setTimeout(r, 35));
    assert.equal(rafFired, true);
    for (const fn of winListeners.click || []) fn({ target: popupBtn, preventDefault() {}, stopPropagation() {} });
    assert.ok(posted.at(-1)?.type === 'hangar-jetbox-quote-clicked' && posted.at(-1)?.payload?.terminalId === 'term-proc-77' && posted.at(-1)?.payload?.copied === true);
    assert.deepEqual(JSON.parse(copiedMime['application/context-scope-item-cider']), { terminal: { processId: 'term-proc-77', name: 'zsh-split', selectionContent: 'FATAL_ERR_42' } });
    const streamRes = await win.fetch('/exa.language_server_pb.LanguageServerService/StreamTerminalOutput', { method: 'POST' });
    const streamReader = streamRes.body.getReader(), chunks = [];
    while (true) { const { done, value } = await streamReader.read(); if (done) break; chunks.push(Buffer.from(value)); }
    const { frames } = parseConnectFrames(Buffer.concat(chunks));
    assert.ok(frames.some((f) => f.data?.output === 'aGk=') && frames.some((f) => f.data?.cwd === 'C:\\repo\\sub'));
    const pages = new Map(), apis = new Map();
    registerTerminalRoutes({ page: (p, fn) => pages.set(p, fn), api: (p, fn) => apis.set(p, fn) });
    assert.ok(apis.has('/api/terminal/rename') && pages.has('/jetbox-main.js') && pages.has('/audio_processor.js'));
    assert.deepEqual(await apis.get('/api/terminal/ls-rpc')({ method: 'GetSidecars' }), { sidecars: [] });
    assert.deepEqual(await apis.get('/api/terminal/ls-rpc')({ method: 'JetboxReadState' }), { appState: { agentOnboardingCompleted: 2 }, userConfig: { userSettings: { themeMode: 1 } } });
    assert.deepEqual(await apis.get('/api/terminal/ls-rpc')({ method: 'JetboxWriteState' }), {});
    await assert.rejects(() => apis.get('/api/terminal/ls-rpc')({ method: 'DeletePlugin' }), /Disallowed Jetbox RPC/);
  });

  it('parses VT100/ANSI sequences, TabGroups, splitGroupId reconciliation, inline rename, and pointer drag', () => {
    const children = [], winListeners = {}, apiCalls = [];
    const makeEl = (rect = { left: 0, right: 80, top: 0, bottom: 22, width: 80, height: 22 }) => {
      const listeners = {}, classes = new Set();
      return {
        className: '', style: {}, dataset: {}, innerHTML: '', value: '', scrollTop: 0, scrollLeft: 0, scrollWidth: 200, clientWidth: 200, scrollHeight: 100, clientHeight: 100,
        classList: { toggle: (c, v) => (v ? classes.add(c) : classes.delete(c)), remove: (...cs) => cs.forEach((c) => classes.delete(c)), add: (...cs) => cs.forEach((c) => classes.add(c)), contains: (c) => classes.has(c) },
        setAttribute() {}, focus() { this._focused = true; }, select() {}, replaceWith(el) { children.push(el); }, getBoundingClientRect: () => rect, cloneNode() { return makeEl(rect); }, remove() {}, querySelector: () => makeEl(rect), querySelectorAll: () => [],
        addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
        emit(ev, payload) { for (const fn of listeners[ev] || []) fn(payload); },
        append(...els) { children.push(...els); }, appendChild(el) { children.push(el); }, contains: () => false,
      };
    };
    const store = new Map([['hangar.poppedTerminalIds', JSON.stringify(['term-popped-1'])]]);
    const windowObj = {
      Hangar: {}, navigator: { platform: 'Win32' }, addEventListener(ev, fn) { (winListeners[ev] = winListeners[ev] || []).push(fn); }, location: { search: '?token=tok-split' },
      localStorage: { getItem: (k) => store.get(k) || null, setItem: (k, v) => store.set(k, v) },
      getSelection: () => ({ isCollapsed: true, toString: () => '' }),
    };
    const documentObj = {
      addEventListener() {}, removeEventListener() {}, execCommand: () => true, createElement: () => makeEl(), querySelectorAll: () => [],
      createDocumentFragment: () => ({ rows: [], appendChild(r) { this.rows.push(r); } }),
      body: { appendChild() {}, classList: { add() {}, remove() {}, contains: () => false } },
    };
    const ctx = vm.createContext({
      window: windowObj, document: documentObj, navigator: windowObj.navigator, localStorage: windowObj.localStorage, URLSearchParams,
      requestAnimationFrame: (fn) => { fn(); return 1; }, cancelAnimationFrame() {}, Date,
      JSON, Math, Array, String, Number, Boolean, Set, Map, Object, encodeURIComponent, setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {},
    });
    for (const rel of ['ui/core.js', 'ui/components/tab-bar.js', 'ui/components/terminal-emulator.js', 'ui/components/terminal-quote.js', 'ui/components/terminal-groups.js', 'ui/components/terminal-tab.js']) {
      vm.runInContext(readFileSync(join(REPO_ROOT, rel), 'utf8'), ctx);
    }
    windowObj.Hangar.apiCall = async (path, body) => { apiCalls.push({ path, body }); return {}; };
    assert.equal(windowObj.Hangar.readEngineMode(), 'jetbox');
    windowObj.Hangar.saveCustomTermTitle('t1', 'build-watcher');
    assert.equal(windowObj.Hangar.readCustomTermTitles().t1, 'build-watcher');

    let detectedTitle = '', receivedInput = '';
    const containerEl = makeEl();
    const emu = windowObj.Hangar.createTerminalEmulator(containerEl, { onTitleChange: (t) => { detectedTitle = t; }, onInput: (d) => { receivedInput += d; } });
    emu.write('\x1b]0;Administrator: PowerShell\x07\x1b[1;32mREADY\x1b[0m\r\nLine2');
    assert.equal(detectedTitle, 'Administrator: PowerShell');
    containerEl.emit('keydown', { key: 'a', target: containerEl, preventDefault() {} });
    assert.equal(receivedInput, 'a');
    const screenEl = children.find((c) => c.className === 'term-screen');
    assert.equal(screenEl._rows[0].innerHTML.replace(/<[^>]+>/g, ''), 'READY');
    assert.ok(screenEl._rows[0].innerHTML.includes('font-weight:700') && screenEl._rows[1].innerHTML.includes('Line2') && screenEl._rows.length === 2);
    emu.write(`\x1b[?25l\x1b[2J\x1b[H${'\r\n'.repeat(40)}\x1b[H\x1b[>4;2m\x1b[2 qPS C:\\repo> \x1b[?12;25h`, { reset: true });
    assert.ok(screenEl._rows.length === 1 && screenEl._rows[0].innerHTML.includes('PS C:\\repo&gt;') && screenEl._rows[0].innerHTML.includes('term-cursor'));
    emu.write(`\x1b[?25l\x1b[HPowerShell 7.6.9\x1b[K\r\nPS C:\\repo>\x1b[K\r\n${'\x1b[K\r\n'.repeat(38)}\x1b[K\x1b[2;13H\x1b[?25h`);
    assert.equal(screenEl._rows.length, 2);

    const allTerms = [{ terminalId: 'term-popped-1', title: 'pwsh-1' }, { terminalId: 'term-unpopped-2', title: 'pwsh-2' }];
    const partitioned = windowObj.Hangar.partitionSplitTabs([{ sidecarId: 'context-monitor', displayName: 'Context', matchesWorkspace: true }], { pinnedTopSidecarId: 'terminal__term-popped-1' }, allTerms);
    assert.deepEqual(Array.from(partitioned.workspaceTabs, (t) => t.sidecarId), ['context-monitor', 'terminal__term-popped-1', '__terminal__', '__extensions__']);
    assert.equal(partitioned.workspaceTabs.find((t) => t.sidecarId === 'terminal__term-popped-1')?.displayName, 'pwsh-1');
    assert.equal(partitioned.activeSingleId, 'terminal__term-popped-1');
    const pinClosed = windowObj.Hangar.partitionSplitTabs([{ sidecarId: 'context-monitor', displayName: 'Context', matchesWorkspace: true }], { pinnedTabIds: ['__terminal__'], closedTabIds: ['context-monitor', '__terminal__', '__extensions__'] }, allTerms);
    assert.deepEqual(Array.from(pinClosed.workspaceTabs, (t) => `${t.sidecarId}:${t.canClose}`), ['__terminal__:false', 'terminal__term-popped-1:true']);
    assert.deepEqual(Array.from(pinClosed.closedTabs, (t) => t.sidecarId), ['context-monitor', '__extensions__']);
    assert.deepEqual(Array.from(windowObj.Hangar.getInstanceTerminals(allTerms, ''), (t) => t.terminalId), ['term-unpopped-2']);
    assert.deepEqual(Array.from(windowObj.Hangar.getInstanceTerminals(allTerms, 'term-popped-1'), (t) => t.terminalId), ['term-popped-1']);
    assert.equal(windowObj.Hangar.formatTermTitle('C:\\Program Files\\PowerShell\\7\\pwsh.exe'), 'pwsh.exe');

    let { groups } = windowObj.Hangar.reconcileTabGroups([{ groupId: 't3', paneIds: ['t3'], activePaneId: 't3', pinned: true }], ['t1', 't3'], null);
    assert.deepEqual(Array.from(groups, (g) => `${g.groupId}:${Boolean(g.pinned)}`), ['t3:true', 't1:false']);
    const sgGroups = windowObj.Hangar.reconcileTabGroups([], [{ terminalId: 's1', splitGroupId: 'sg-a' }, { terminalId: 's2', splitGroupId: 'sg-a' }, { terminalId: 's3', splitGroupId: '' }]).groups;
    assert.deepEqual(Array.from(sgGroups, (g) => Array.from(g.paneIds)), [['s1', 's2'], ['s3']]);
    groups = windowObj.Hangar.reconcileTabGroups([], ['t1', 't3'], null).groups;
    groups = windowObj.Hangar.insertSplitPane(groups, 't1', 't1', 't2');
    assert.deepEqual(Array.from(groups[0].paneIds), ['t1', 't2']);
    groups = windowObj.Hangar.applyTerminalDrop(groups, { kind: 'pane', terminalId: 't2', groupId: 't1' }, { zone: 'pane', targetGroupId: 't1', targetPaneId: 't1', side: 'left' }).groups;
    assert.deepEqual(Array.from(groups[0].paneIds), ['t2', 't1']);
    groups = windowObj.Hangar.applyTerminalDrop(groups, { kind: 'pane', terminalId: 't2', groupId: 't1' }, { zone: 'strip', index: 1 }).groups;
    assert.deepEqual(Array.from(groups, (g) => g.groupId), ['t1', 't2', 't3']);
    groups = windowObj.Hangar.applyTerminalDrop(groups, { kind: 'tab', groupId: 't3', terminalId: 't3' }, { zone: 'pane', targetGroupId: 't1', targetPaneId: 't1', side: 'right' }).groups;
    assert.deepEqual(Array.from(groups[0].paneIds), ['t1', 't3']);

    windowObj.Hangar.saveTabGroups('__terminal__', groups);
    const prom1 = windowObj.Hangar.promoteDragToHangarBar({ kind: 'tab', groupId: 't1', terminalId: 't1', instanceTabId: '__terminal__' });
    assert.equal(prom1.newSidecarId, 'terminal__t1');
    assert.equal(windowObj.Hangar.readGroupMap().t3, 't1');
    const promRoot = windowObj.Hangar.promoteDragToHangarBar({ kind: 'pane', groupId: 't1', terminalId: 't1', instanceTabId: 'terminal__t1' });
    assert.deepEqual(JSON.parse(JSON.stringify(promRoot)), { newSidecarId: 'terminal__t1', replacedSidecarId: { from: 'terminal__t1', to: 'terminal__t3' } });
    assert.ok(windowObj.Hangar.demoteHangarTabIntoInstance('terminal__t1', { targetInstanceTabId: '__terminal__', zone: 'pane', targetPaneId: 't2', side: 'left' }));
    assert.deepEqual(Array.from(windowObj.Hangar.readTabGroups('__terminal__')[0].paneIds), ['t1', 't2']);
    const m1 = windowObj.Hangar.mergeTermDragIntoInstance({ kind: 'tab', groupId: 't2', terminalId: 't1', instanceTabId: '__terminal__' }, { targetInstanceTabId: 'terminal__t3', zone: 'hub-tab', pane: 'bottom' });
    assert.deepEqual(JSON.parse(JSON.stringify(m1)), { removedSidecarId: 'terminal__t3', replacedSidecarId: { from: 'terminal__t3', to: '__terminal__' }, targetInstanceTabId: '__terminal__', targetPane: 'bottom' });
    assert.deepEqual(Array.from(windowObj.Hangar.readTabGroups('__terminal__'), (g) => g.groupId), ['t3', 't1']);

    let menuClicked = false;
    windowObj.Hangar.openTabContextMenu({ clientX: 40, clientY: 20, preventDefault() {}, stopPropagation() {} }, [{ id: 'pin-tab', label: 'Pin Tab', onClick: () => { menuClicked = true; } }, { separator: true }, { id: 'toggle-global', label: 'Show in All Workspaces (Global)' }]);
    assert.ok(windowObj.Hangar.iconSvg('globe', 15).includes('M480-80') && windowObj.Hangar.iconSvg('terminal', 16).includes('viewBox="0 0 24 24"') && children.some((c) => c.className === 'agy-context-menu-sep'));
    children.find((c) => c.className === 'agy-context-menu-item')?.emit('click', { stopPropagation() {} });
    assert.equal(menuClicked, true);

    const p1 = makeEl({ left: 0, right: 60, top: 4, bottom: 26, width: 60, height: 22 }), p2 = makeEl({ left: 64, right: 124, top: 4, bottom: 26, width: 60, height: 22 });
    const stripEl = makeEl({ left: 0, right: 200, top: 0, bottom: 30, width: 200, height: 30 });
    stripEl.querySelectorAll = () => [p1, p2];
    let droppedTarget = null;
    windowObj.Hangar.bindTermPointerDrag(p1, { kind: 'tab', groupId: 't3', terminalId: 't3', instanceTabId: '__terminal__', sessionsEl: stripEl, onSameInstanceDrop: (_d, tgt) => { droppedTarget = tgt; } });
    p1.emit('pointerdown', { button: 0, pointerId: 1, clientX: 20, clientY: 15 });
    p1.emit('pointermove', { pointerId: 1, clientX: 105, clientY: 15 });
    assert.ok(p1.classList.contains('is-dragging-source') && p2.style.transform === 'translateX(-64px)');
    p1.emit('pointerup', { pointerId: 1, clientX: 105, clientY: 15 });
    assert.deepEqual(JSON.parse(JSON.stringify(droppedTarget)), { zone: 'strip', index: 2 });
    windowObj.Hangar.saveEngineMode('jetbox'); windowObj.Hangar.saveTabGroups('__terminal__', []);
    windowObj.Hangar.renderTerminalSlots({ topTermEl: makeEl(), bottomTermEl: makeEl(), topSlotId: '__terminal__', bottomSlotId: '', splitEnabled: false, terminals: [{ terminalId: 't1', title: 'pwsh-1', splitGroupId: 'sg-native' }, { terminalId: 't2', title: 'pwsh-2', splitGroupId: 'sg-native' }] });
    assert.deepEqual(children.filter((c) => c.className === 'term-jetbox-frame').map((c) => c.src.includes('terminalId=t1') ? 't1' : 't2'), ['t1', 't2']);
    assert.ok(children.some((c) => c.dataset?.testid === 'aux-pane-new-tab-button'));
    const sessionPill = children.find((c) => c.className?.includes('term-session-pill'));
    sessionPill.emit('dblclick', { stopPropagation() {} });
    const escInp = children.filter((c) => c.className === 'term-rename-input').at(-1);
    escInp.value = 'cancelled-name'; escInp.emit('keydown', { key: 'Escape', stopPropagation() {} }); escInp.emit('blur', {});
    assert.equal(windowObj.Hangar.readCustomTermTitles().t1, 'build-watcher');
    assert.equal(apiCalls.filter((c) => c.path === '/api/terminal/rename').length, 0);
    children.filter((c) => c.className?.includes('term-session-pill')).at(-1).emit('dblclick', { stopPropagation() {} });
    const okInp = children.filter((c) => c.className === 'term-rename-input').at(-1);
    okInp.value = 'committed-name'; okInp.emit('keydown', { key: 'Enter', stopPropagation() {} }); okInp.emit('blur', {});
    assert.equal(windowObj.Hangar.readCustomTermTitles().t1, 'committed-name');
    assert.deepEqual(JSON.parse(JSON.stringify(apiCalls.filter((c) => c.path === '/api/terminal/rename'))), [{ path: '/api/terminal/rename', body: { terminalId: 't1', title: 'committed-name' } }]);
    for (const fn of winListeners.message || []) fn({ data: { type: 'hangar-jetbox-title-changed', payload: { terminalId: 't1', title: 'zsh-osc' } } });
    for (const fn of winListeners.message || []) fn({ data: { type: 'hangar-jetbox-quote-clicked', payload: { terminalId: 't1', title: 'pwsh-1', selectionContent: 'ERR_TEST', copied: true } } });
    assert.ok(children.some((c) => c.className === 'term-quote-toast' && c.textContent.includes('Quoted selection from "committed-name"')));
    children.filter((c) => c.className?.includes('term-session-pill')).at(-1).emit('dblclick', { stopPropagation() {} });
    const clrInp = children.filter((c) => c.className === 'term-rename-input').at(-1);
    clrInp.value = '   '; clrInp.emit('keydown', { key: 'Enter', stopPropagation() {} });
    assert.equal(windowObj.Hangar.readCustomTermTitles().t1, undefined);
    assert.ok(children.filter((c) => c.className?.includes('term-session-pill')).at(-1).innerHTML.includes('zsh-osc'));
  });
});
