import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import vm from 'node:vm';
import { closeWorkspaceTerminal, createWorkspaceTerminal, encodeConnectFrame, listWorkspaceTerminals, parseConnectFrames, pollTerminalOutput, registerTerminalRoutes, renameWorkspaceTerminal, sendTerminalInput, toWorkspaceFileUri } from '../lib/terminal-manager.mjs';
import { buildJetboxChatHtml, buildJetboxTerminalHtml, deleteTerminalSideChat, pollChatStream, startTerminalSideChat, syncQuoteWithHostWindow } from '../lib/jetbox-proxy.mjs';

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
          { terminalId: 't-match', pid: 1234, title: 'pwsh', projectId: 'file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-hub', conversationId: 'hangar:conv-1' },
          { terminalId: 't-ext', pid: 2222, title: 'pwsh-ext', projectId: 'file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-hub', conversationId: 'conv-1' },
          { terminalId: 't-other', pid: 5678, title: 'bash', projectId: 'file:///c:/other/project', cwd: 'C:\\other\\project' },
        ],
      };
    };
    const list = await listWorkspaceTerminals({ workspacePath: 'c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub', rpcFn: mockRpc });
    assert.equal(list.length, 2);
    assert.equal(list[0].terminalId, 't-match'); assert.equal(list[0].pid, 1234); assert.equal(list[0].isExternal, false);
    assert.equal(list[0].conversationId, 'conv-1'); assert.equal(list[0].workspaceUri, 'file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-hub');
    assert.equal(list[1].terminalId, 't-ext'); assert.equal(list[1].isExternal, true);
    const hangarOnlyList = await listWorkspaceTerminals({ workspacePath: 'c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub', showExternalTerminals: false, rpcFn: mockRpc });
    assert.deepEqual(hangarOnlyList.map((t) => t.terminalId), ['t-match']);
  });

  it('creates a terminal, streams 5-byte Connect output, chains inputOffset acks, renames, and closes cleanly', async () => {
    const prevAddr = process.env.ANTIGRAVITY_LS_ADDRESS, prevCsrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
    process.env.ANTIGRAVITY_LS_ADDRESS = '127.0.0.1:59999'; process.env.ANTIGRAVITY_CSRF_TOKEN = 'test-csrf';
    const rpcCalls = [];
    const mockRpc = async (method, body) => {
      rpcCalls.push({ method, body });
      if (method === 'CreateTerminal') return { terminal: { terminalId: 'term-live-1', pid: 4242, title: 'pwsh', projectId: body.projectId, conversationId: body.conversationId } };
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
      const created = await createWorkspaceTerminal({ workspacePath: 'c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub', conversationId: 'conv-abc', cols: 120, rows: 32, rpcFn: mockRpc, fetchFn: mockFetch });
      assert.equal(created.terminalId, 'term-live-1'); assert.equal(created.conversationId, 'conv-abc');
      assert.equal(rpcCalls[0].method, 'CreateTerminal');
      assert.equal(rpcCalls[0].body.workspaceUri, undefined);
      assert.equal(rpcCalls[0].body.projectId, 'file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub');
      assert.equal(rpcCalls[0].body.conversationId, 'hangar:conv-abc');
      const initCall = rpcCalls.find((c) => c.method === 'SendTerminalInput' && c.body.inputStreamId === 'hangar-init');
      const initCmdText = initCall ? Buffer.from(initCall.body.input, 'base64').toString('utf8') : '';
      assert.ok(initCmdText.includes('cd "c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub"'));
      assert.ok(initCmdText.includes('[2;1H') && initCmdText.includes('[J') && !/\bclear\b/.test(initCmdText));
      await new Promise((r) => setTimeout(r, 25));
      const polled = pollTerminalOutput({ terminalId: 'term-live-1', afterSeq: 0, fetchFn: mockFetch });
      assert.equal(polled.title, 'pwsh-custom'); assert.equal(polled.exited, true); assert.equal(polled.exitCode, 0);
      assert.equal(polled.chunks.length, 3); assert.equal(polled.chunks[0].isScrollback, true);
      assert.equal(polled.chunks[1].text + polled.chunks[2].text, 'npm test ─\r\n');

      await sendTerminalInput({ terminalId: 'term-live-1', data: 'ls\r', rpcFn: mockRpc, fetchFn: mockFetch });
      const secondSend = await sendTerminalInput({ terminalId: 'term-live-1', data: 'pwd\r', rpcFn: mockRpc, fetchFn: mockFetch });
      assert.equal(secondSend.ackedOffset, 7);
      const inputCalls = rpcCalls.filter((c) => c.method === 'SendTerminalInput' && c.body.input && c.body.inputStreamId !== 'hangar-init');
      assert.equal(inputCalls.length, 2); assert.equal(inputCalls[0].body.inputOffset, '0'); assert.equal(inputCalls[1].body.inputOffset, '3');

      const renamed = await renameWorkspaceTerminal({ terminalId: 'term-live-1', title: '  api-worker  ', rpcFn: mockRpc });
      assert.deepEqual(renamed, { ok: true, terminalId: 'term-live-1', title: 'api-worker' });
      assert.deepEqual(rpcCalls.find((c) => c.method === 'RenameTerminal')?.body, { terminalId: 'term-live-1', title: 'api-worker' });
      assert.equal(pollTerminalOutput({ terminalId: 'term-live-1', afterSeq: 0, fetchFn: mockFetch }).title, 'api-worker');
      await renameWorkspaceTerminal({ terminalId: 'term-live-1', title: '', rpcFn: mockRpc });
      assert.equal(pollTerminalOutput({ terminalId: 'term-live-1', afterSeq: 0, fetchFn: mockFetch }).title, 'pwsh-custom');
      await sendTerminalInput({ terminalId: 'term-live-1', data: 'node\r', rpcFn: mockRpc, fetchFn: mockFetch });
      assert.equal(pollTerminalOutput({ terminalId: 'term-live-1', afterSeq: 0, fetchFn: mockFetch }).title, 'node');

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
    assert.equal(lexical.namespace, 'Input'); assert.equal(lexical.nodes[0].type, 'contextScopeItemMention');
    assert.equal(lexical.nodes[0].scopeItem, payload.contextScopeJson); assert.equal(lexical.nodes[0].data.data, payload.contextScopeJson); assert.equal(lexical.nodes[1].type, 'text'); assert.equal(lexical.nodes[1].text, ' ');
    let writeTextCalled = false, dragFn = null;
    const dragMime = {}, dragBtn = { style: {}, setAttribute() {}, addEventListener: (ev, fn) => { if (ev === 'dragstart') dragFn = fn; } };
    windowObj.Hangar.bindTerminalDragSource(dragBtn, payload);
    dragFn({ dataTransfer: { setData: (k, v) => { dragMime[k] = v; } } });
    assert.equal(dragBtn.style.webkitUserDrag, 'element');
    assert.equal(dragMime['application/context-scope-item'], payload.contextScopeJson);
    assert.equal(dragMime['application/context-scope-item-cider'], payload.contextScopeJson);
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
        memoizedState: { memoizedState: { current: { getSelection: () => 'FATAL_ERR_42', clearSelection() { this.cleared = true; }, focus() { this.focused = true; } } }, next: null }, return: null,
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
    const jetboxDragMime = {}, dragOverDt = {}; let dragStopped = false, dragOverStopped = false, dragOverPrevented = false;
    for (const fn of winListeners.mousedown || []) fn({ target: popupBtn, stopPropagation() {}, preventDefault() {} });
    termActiveEl.__reactFiber$xyz.memoizedState.memoizedState.current.clearSelection();
    assert.equal(termActiveEl.__reactFiber$xyz.memoizedState.memoizedState.current.cleared, undefined);
    for (const fn of winListeners.dragstart || []) fn({ target: popupBtn, stopPropagation: () => { dragStopped = true; }, dataTransfer: { setData: (k, v) => { jetboxDragMime[k] = v; } } });
    for (const fn of winListeners.dragover || []) fn({ stopPropagation: () => { dragOverStopped = true; }, preventDefault: () => { dragOverPrevented = true; }, dataTransfer: dragOverDt });
    assert.ok(dragStopped && dragOverStopped && dragOverPrevented && dragOverDt.dropEffect === 'copy' && html.includes('conversation-view-drag-tint'));
    assert.deepEqual(JSON.parse(jetboxDragMime['application/context-scope-item']), { terminal: { processId: 'term-proc-77', name: 'zsh-split', selectionContent: 'FATAL_ERR_42' } });
    assert.equal(jetboxDragMime['application/context-scope-item-cider'], jetboxDragMime['application/context-scope-item']);
    assert.equal(jetboxDragMime['text/plain'], '[zsh-split](terminal;term-proc-77) ');
    assert.equal(jetboxDragMime['text/uri-list'], undefined);
    for (const fn of winListeners.dragend || []) fn({ clientX: -360, clientY: 719, dataTransfer: { dropEffect: 'copy' } });
    assert.equal(termActiveEl.__reactFiber$xyz.memoizedState.memoizedState.current.cleared, true);
    assert.deepEqual(JSON.parse(JSON.stringify(posted.at(-1))), {
      type: 'hangar-jetbox-quote-dragend',
      payload: { terminalId: 'term-proc-77', title: 'zsh-split', selectionContent: 'FATAL_ERR_42', clientX: -360, clientY: 719, outsideFrame: true, dropEffect: 'copy' },
    });
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
    assert.ok(apis.has('/api/terminal/rename') && pages.has('/jetbox-main.js') && pages.has('/audio_processor.js') && pages.has('/diff_worker.js'));
    assert.deepEqual(await apis.get('/api/terminal/ls-rpc')({ method: 'GetSidecars' }), { sidecars: [] });
    assert.deepEqual(await apis.get('/api/terminal/ls-rpc')({ method: 'JetboxReadState' }), { appState: { agentOnboardingCompleted: 2 }, userConfig: { userSettings: { themeMode: 1 } } });
    assert.deepEqual(await apis.get('/api/terminal/ls-rpc')({ method: 'JetboxWriteState' }), {});
    assert.deepEqual(await apis.get('/api/terminal/ls-rpc')({ method: 'SendTerminalInput', body: { terminalId: 'term-proc-77', resize: { cols: 2, rows: 1 } } }), {});
    for (const fn of winListeners.message || []) fn({ data: { type: 'hangar-jetbox-focus' } });
    assert.equal(termActiveEl.__reactFiber$xyz.memoizedState.memoizedState.current.focused, true);
    await assert.rejects(() => apis.get('/api/terminal/ls-rpc')({ method: 'DeletePlugin' }), /Disallowed Jetbox RPC/);
  });

  it('parses VT100/ANSI sequences, TabGroups, splitGroupId reconciliation, inline rename, and pointer drag', async () => {
    const children = [], winListeners = {}, apiCalls = [];
    const makeEl = (rect = { left: 0, right: 80, top: 0, bottom: 22, width: 80, height: 22 }) => {
      const listeners = {}, classes = new Set(), childNodes = [];
      let html = '';
      return {
        className: '', style: {}, dataset: {}, value: '', scrollTop: 0, scrollLeft: 0, scrollWidth: 200, clientWidth: 200, scrollHeight: 100, clientHeight: 100, childNodes,
        get innerHTML() { return html; },
        set innerHTML(v) { html = v; if (v === '') childNodes.length = 0; },
        classList: { toggle: (c, v) => (v ? classes.add(c) : classes.delete(c)), remove: (...cs) => cs.forEach((c) => classes.delete(c)), add: (...cs) => cs.forEach((c) => classes.add(c)), contains: (c) => classes.has(c) },
        setAttribute() {}, focus() { this._focused = true; }, select() {}, replaceWith(el) { children.push(el); }, getBoundingClientRect: () => rect, cloneNode() { return makeEl(rect); }, remove() {}, querySelector: () => makeEl(rect), querySelectorAll: () => [],
        addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
        emit(ev, payload) { for (const fn of listeners[ev] || []) fn(payload); },
        append(...els) { childNodes.push(...els); children.push(...els); }, appendChild(el) { childNodes.push(el); children.push(el); }, contains: () => false,
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
    emu.write('PowerShell 7.6.9\r\nPS C:\\Users\\arthu> cd "c:/repo" ; [Console]::Write("$([char]27)[2;1H$([char]27)[J")\r\n\x1b[2;1H\x1b[JPS C:\\repo> ', { reset: true });
    assert.equal(screenEl._rows.length, 2);
    assert.equal(screenEl._rows[0].innerHTML.replace(/<[^>]+>/g, ''), 'PowerShell 7.6.9');
    assert.ok(screenEl._rows[1].innerHTML.includes('PS C:\\repo&gt;'));

    const allTerms = [{ terminalId: 'term-popped-1', title: 'pwsh-1' }, { terminalId: 'term-unpopped-2', title: 'pwsh-2' }];
    assert.equal(windowObj.Hangar.isMainTerminalOpen(), false);
    const defaultPart = windowObj.Hangar.partitionSplitTabs([{ sidecarId: 'context-monitor', displayName: 'Context', matchesWorkspace: true }], {}, allTerms);
    assert.deepEqual(Array.from(defaultPart.workspaceTabs, (t) => t.sidecarId), ['context-monitor', 'terminal__term-popped-1', '__extensions__']);
    windowObj.Hangar.setMainTerminalOpen(true);
    const partitioned = windowObj.Hangar.partitionSplitTabs([{ sidecarId: 'context-monitor', displayName: 'Context', matchesWorkspace: true }], { pinnedTopSidecarId: 'terminal__term-popped-1' }, allTerms);
    assert.deepEqual(Array.from(partitioned.workspaceTabs, (t) => t.sidecarId), ['context-monitor', '__terminal__', 'terminal__term-popped-1', '__extensions__']);
    assert.equal(partitioned.workspaceTabs.find((t) => t.sidecarId === 'terminal__term-popped-1')?.displayName, 'Terminal 2');
    windowObj.Hangar.saveCustomTermTitle('term-popped-1', 'dev-server');
    assert.equal(windowObj.Hangar.partitionSplitTabs([], {}, allTerms).workspaceTabs.find((t) => t.sidecarId === 'terminal__term-popped-1')?.displayName, 'dev-server');
    windowObj.Hangar.saveCustomTermTitle('term-popped-1', '');
    windowObj.Hangar.setPoppedTerminalIds(new Set(['term-popped-1', 'term-unpopped-2']));
    const revTerms = [{ terminalId: 'term-unpopped-2', title: 'pwsh-2' }, { terminalId: 'term-popped-1', title: 'pwsh-1' }];
    assert.deepEqual(Array.from(windowObj.Hangar.partitionSplitTabs([], { tabOrder: ['terminal__term-popped-1', 'terminal__term-unpopped-2'] }, revTerms).workspaceTabs.filter((t) => t.terminalId), (t) => `${t.sidecarId}:${t.displayName}`), ['terminal__term-popped-1:Terminal 2', 'terminal__term-unpopped-2:Terminal 3']);
    windowObj.Hangar.setPoppedTerminalIds(new Set(['term-popped-1']));
    assert.equal(partitioned.activeSingleId, 'terminal__term-popped-1');
    const pinClosed = windowObj.Hangar.partitionSplitTabs([{ sidecarId: 'context-monitor', displayName: 'Context', matchesWorkspace: true }], { pinnedTabIds: ['__terminal__'], closedTabIds: ['context-monitor', '__terminal__', '__extensions__'] }, allTerms);
    assert.deepEqual(Array.from(pinClosed.workspaceTabs, (t) => `${t.sidecarId}:${t.canClose}`), ['__terminal__:true', 'terminal__term-popped-1:true']);
    assert.deepEqual(Array.from(pinClosed.closedTabs, (t) => t.sidecarId), ['context-monitor', '__extensions__']);
    assert.deepEqual(Array.from(windowObj.Hangar.getInstanceTerminals(allTerms, ''), (t) => t.terminalId), ['term-unpopped-2']);
    assert.deepEqual(Array.from(windowObj.Hangar.getInstanceTerminals(allTerms, 'term-popped-1'), (t) => t.terminalId), ['term-popped-1']);
    assert.equal(windowObj.Hangar.formatTermTitle('C:\\Program Files\\PowerShell\\7\\pwsh.exe'), 'pwsh.exe');
    assert.equal(windowObj.Hangar.formatTermTitle('C:\\Program Files\\PowerShell\\7\\pwsh.exe - node'), 'node');

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
    windowObj.Hangar.renderTerminalSlots({ topTermEl: makeEl(), bottomTermEl: makeEl(), topSlotId: '__terminal__', bottomSlotId: '', splitEnabled: false, terminals: [], workspacePath: 'C:\\repo' });
    assert.equal(apiCalls.filter((c) => c.path === '/api/terminal/create').length, 0);
    assert.equal(children.some((c) => c.dataset?.testid === 'aux-pane-new-tab-button'), false);
    windowObj.Hangar.renderTerminalSlots({ topTermEl: makeEl(), bottomTermEl: makeEl(), topSlotId: '__terminal__', bottomSlotId: '', splitEnabled: false, terminals: [{ terminalId: 't1', title: 'pwsh-1', splitGroupId: 'sg-native', conversationId: 'conv-host-1' }, { terminalId: 't2', title: 'pwsh-2', splitGroupId: 'sg-native' }], conversationId: 'conv-host-1' });
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
    for (const fn of winListeners.message || []) fn({ data: { type: 'hangar-jetbox-quote-dragend', payload: { terminalId: 't1', title: 'pwsh-1', selectionContent: 'ERR_DRAG', clientX: 20, clientY: 10, outsideFrame: false } } });
    assert.equal(apiCalls.filter((c) => c.body?.method === 'InjectQuoteDrop').length, 0);
    for (const fn of winListeners.message || []) fn({ data: { type: 'hangar-jetbox-quote-dragend', payload: { terminalId: 't1', title: 'pwsh-1', selectionContent: 'ERR_DRAG', clientX: -360, clientY: 719, outsideFrame: true } } });
    assert.deepEqual(JSON.parse(JSON.stringify(apiCalls.filter((c) => c.body?.method === 'InjectQuoteDrop'))), [
      { path: '/api/terminal/ls-rpc', body: { method: 'InjectQuoteDrop', conversationId: 'conv-host-1', terminalId: 't1', title: 'committed-name', selectionContent: 'ERR_DRAG' } },
    ]);
    const notified = [];
    windowObj.Hangar.notifyAgent = async (msg, cid, title) => { notified.push({ msg, cid, title }); return { ok: true }; };
    for (const fn of winListeners.message || []) fn({ data: { type: 'hangar-jetbox-title-changed', payload: { terminalId: 't1', title: 'zsh-osc' } } });
    for (const fn of winListeners.message || []) fn({ data: { type: 'hangar-jetbox-quote-clicked', payload: { terminalId: 't1', title: 'pwsh-1', selectionContent: 'ERR_TEST', copied: true, askAgent: false } } });
    assert.ok(children.some((c) => c.className === 'term-quote-toast' && c.textContent.includes('Quoted selection from "committed-name"')));
    assert.equal(children.find((c) => c.className === 'term-quote-composer'), undefined);
    for (const fn of winListeners.message || []) fn({ data: { type: 'hangar-jetbox-quote-clicked', payload: { terminalId: 't1', title: 'pwsh-1', selectionContent: 'ERR_TEST', copied: true, askAgent: true } } });
    const miniComposer = children.find((c) => c.className === 'term-mini-composer');
    assert.ok(miniComposer && !miniComposer.classList.contains('hidden'));
    assert.equal(windowObj.Hangar.getSideChatState().isOpen, false);
    assert.equal(windowObj.Hangar.getSideChatState().threads.length, 0);
    miniComposer._els.input.value = 'Why did this fail?\nCheck line 2.';
    miniComposer._els.input.emit('keydown', { key: 'Enter', shiftKey: true, preventDefault() {}, stopPropagation() {} });
    assert.equal(notified.length, 0);
    await miniComposer._submitMain();
    assert.equal(notified.length, 1);
    assert.match(notified[0].msg, /From terminal "committed-name":\n```text\nERR_TEST\n```\n\nWhy did this fail\?\nCheck line 2\./);
    assert.equal(miniComposer.classList.contains('hidden'), true);
    assert.equal(windowObj.Hangar.getSideChatState().isOpen, false);
    assert.equal(windowObj.Hangar.getSideChatState().threads.length, 0);

    for (const fn of winListeners.message || []) fn({ data: { type: 'hangar-jetbox-quote-clicked', payload: { terminalId: 't1', title: 'pwsh-1', selectionContent: 'ERR_SIDECHAT', copied: true, askAgent: true } } });
    assert.equal(miniComposer.classList.contains('hidden'), false);
    miniComposer._els.input.value = 'Investigate this in Side Chat';
    const composer = miniComposer._submitSideChat();
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(miniComposer.classList.contains('hidden'), true);
    assert.ok(composer && !composer.classList.contains('hidden'));
    assert.equal(windowObj.Hangar.getSideChatState().isOpen, true);
    assert.equal(windowObj.Hangar.getSideChatState().isDocked, true);
    assert.equal(windowObj.Hangar.getSideChatState().threads.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(composer._pendingQuote)), {
      terminalId: 't1',
      title: 'committed-name',
      selectionContent: 'ERR_SIDECHAT',
      promptText: 'Investigate this in Side Chat',
      autoSubmit: true,
    });
    const dockedTabs = windowObj.Hangar.partitionSplitTabs([], {}, allTerms).workspaceTabs;
    assert.ok(dockedTabs.some((t) => t.sidecarId === '__sidechat__' && t.displayName === 'Side Chat' && t.canClose === true));
    const vpEl = makeEl();
    windowObj.Hangar.renderSideChatSlot({ viewportEl: vpEl, topSlotId: '__sidechat__', bottomSlotId: '', splitEnabled: false });
    assert.ok(composer.classList.contains('slot-top') && !composer.classList.contains('hidden'));
    windowObj.Hangar.closeSideChatDrawer({ deleteAll: false, notify: false });
    const hiddenPart = windowObj.Hangar.partitionSplitTabs([], { closedTabIds: ['__sidechat__'] }, allTerms);
    assert.equal(hiddenPart.workspaceTabs.some((t) => t.sidecarId === '__sidechat__'), false);
    assert.equal(hiddenPart.closedTabs.some((t) => t.sidecarId === '__sidechat__'), true);
    composer._els.deleteBtn.emit('click', { stopPropagation() {} });
    assert.equal(windowObj.Hangar.getSideChatState().isOpen, false);
    assert.equal(windowObj.Hangar.partitionSplitTabs([], {}, allTerms).workspaceTabs.some((t) => t.sidecarId === '__sidechat__'), false);
    windowObj.Hangar.renderSideChatSlot({ viewportEl: vpEl, topSlotId: '__sidechat__', bottomSlotId: '', splitEnabled: false });
    assert.equal(composer.classList.contains('hidden'), true);
    windowObj.Hangar.closeSideChatDrawer({ deleteAll: true, notify: false });
    windowObj.Hangar.openTerminalQuoteComposer(vpEl, {}, { conversationId: 'conv-host-1' });
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(composer._els.badge.classList.contains('hidden'), true);
    assert.equal(composer._els.mainToggleBtn.classList.contains('hidden'), true);
    assert.ok(composer._els.newThreadBtn.className.includes('hidden'));
    assert.ok(composer._els.deleteBtn.className.includes('hidden'));
    assert.equal(composer._els.overviewBtn.classList.contains('active'), false);
    composer._els.overviewBtn.emit('click', { stopPropagation() {} });
    assert.equal(composer._els.overviewBtn.classList.contains('active'), true);
    composer._els.overviewBtn.emit('click', { stopPropagation() {} });
    assert.equal(composer._els.overviewBtn.classList.contains('active'), false);
    let lastScDockEvt = null;
    windowObj.Hangar.setSideChatDockCallback((evt) => { lastScDockEvt = evt; });
    for (const fn of winListeners.message || []) fn({ data: { type: 'hangar-sidechat-open-terminal', payload: { cascadeId: windowObj.Hangar.getSideChatState().threads[0].cascadeId } } });
    assert.equal(lastScDockEvt?.openTerminal, true);
    assert.equal(lastScDockEvt?.sourceTabId, '__sidechat__');
    assert.equal(windowObj.Hangar.getSideChatState().threads.length, 1);
    assert.equal(windowObj.Hangar.getSideChatState().threads[0].title, 'Side Chat #1');
    miniComposer._setTargetCascadeId(windowObj.Hangar.getSideChatState().threads[0].cascadeId);
    assert.ok(miniComposer._els.sideChatBtn.innerHTML.includes('Ask in Side Chat #1'));
    miniComposer._els.input.value = 'Follow-up in existing thread';
    miniComposer._submitSideChat();
    assert.equal(windowObj.Hangar.getSideChatState().threads.length, 1);
    assert.equal(composer._pendingQuote.promptText, 'Follow-up in existing thread');
    windowObj.Hangar.openTerminalQuoteComposer(vpEl, {}, { conversationId: 'conv-host-1', forceNewThread: true });
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(windowObj.Hangar.getSideChatState().threads.length, 2);
    assert.equal(windowObj.Hangar.getSideChatState().threads[1].title, 'Side Chat #2');
    assert.ok(composer._els.chatFrame.src.includes(encodeURIComponent(windowObj.Hangar.getSideChatState().threads[1].cascadeId)));
    const scPills = children.filter((c) => c.className?.includes('sidechat-session-pill')).slice(-2);
    assert.equal(scPills.length, 2);
    scPills.at(-1).emit('dblclick', { stopPropagation() {} });
    const scRenameInp = children.filter((c) => c.className === 'term-rename-input').at(-1);
    scRenameInp.value = 'Bug Triage Chat';
    scRenameInp.emit('keydown', { key: 'Enter', stopPropagation() {} });
    scRenameInp.emit('blur', {});
    const secondCid = windowObj.Hangar.getSideChatState().threads[1].cascadeId;
    assert.equal(windowObj.Hangar.readCustomSideChatTitles()[secondCid], 'Bug Triage Chat');
    composer._els.popoutBtn.emit('click', { stopPropagation() {} });
    assert.equal(windowObj.Hangar.getPoppedSideChatIds().has(secondCid), true);
    const savedSideChatState = windowObj.Hangar.serializeSideChatState();
    const remainingMainPills = composer._els.sessionsEl.childNodes.filter((c) => c.className?.includes('sidechat-session-pill'));
    assert.equal(remainingMainPills.length, 1);
    assert.notEqual(remainingMainPills[0].dataset.cascadeId, secondCid);
    const poppedBox = children.find((c) => c.dataset?.instanceTabId === `sidechat__${secondCid}`);
    assert.ok(poppedBox);
    assert.equal(poppedBox._els.initialFrame.classList.contains('hidden'), true);
    assert.equal(poppedBox._els.chatFrame.classList.contains('hidden'), false);
    const poppedScTabs = windowObj.Hangar.partitionSplitTabs([], {}, allTerms).workspaceTabs;
    assert.ok(poppedScTabs.some((t) => t.sidecarId === `sidechat__${secondCid}` && t.displayName === 'Bug Triage Chat'));
    assert.equal(windowObj.Hangar.demoteSideChatTabIntoInstance(`sidechat__${secondCid}`, { targetInstanceTabId: '__sidechat__', zone: 'strip', index: 0 }), true);
    assert.equal(windowObj.Hangar.getPoppedSideChatIds().has(secondCid), false);
    assert.equal(windowObj.Hangar.getSideChatState().threads[0].cascadeId, secondCid);
    composer._els.popoutBtn.emit('click', { stopPropagation() {} });
    assert.equal(windowObj.Hangar.getPoppedSideChatIds().has(secondCid), true);
    await windowObj.Hangar.closeSideChatInstance(`sidechat__${secondCid}`);
    assert.equal(windowObj.Hangar.getPoppedSideChatIds().has(secondCid), false);
    windowObj.Hangar.closeSideChatDrawer({ deleteAll: true, notify: false });
    children.filter((c) => c.className?.includes('term-session-pill')).at(-1).emit('dblclick', { stopPropagation() {} });
    const clrInp = children.filter((c) => c.className === 'term-rename-input').at(-1);
    clrInp.value = '   '; clrInp.emit('keydown', { key: 'Enter', stopPropagation() {} });
    assert.equal(windowObj.Hangar.readCustomTermTitles().t1, undefined);
    assert.ok(children.filter((c) => c.className?.includes('term-session-pill')).at(-1).innerHTML.includes('zsh-osc'));
    windowObj.Hangar.apiCall = async (path, body) => {
      apiCalls.push({ path, body });
      if (path === '/api/terminal/create') return { terminalId: 't-spawned-new', title: 'pwsh-new' };
      return {};
    };
    const topTermSlot = makeEl();
    const curTerms = [{ terminalId: 't1', title: 'pwsh-1', splitGroupId: 'sg-native', conversationId: 'conv-host-1' }, { terminalId: 't2', title: 'pwsh-2', splitGroupId: 'sg-native' }];
    windowObj.Hangar.renderTerminalSlots({
      topTermEl: topTermSlot, bottomTermEl: makeEl(), topSlotId: '__terminal__', bottomSlotId: '', splitEnabled: false,
      terminals: curTerms, conversationId: 'conv-host-1',
      onRefreshState: async () => {
        windowObj.Hangar.renderTerminalSlots({
          topTermEl: topTermSlot, bottomTermEl: makeEl(), topSlotId: '__terminal__', bottomSlotId: '', splitEnabled: false,
          terminals: [...curTerms, { terminalId: 't-spawned-new', title: 'pwsh-new', isExternal: false }, { terminalId: 't-ext-tab', title: 'pwsh-ext', isExternal: true }], conversationId: 'conv-host-1',
        });
      },
    });
    const newTabBtn = children.filter((c) => c.dataset?.testid === 'aux-pane-new-tab-button').at(-1);
    newTabBtn.emit('click', { stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(windowObj.Hangar.getActiveGroupId('__terminal__'), 't-spawned-new');
    const activePills = children.filter((c) => c.className === 'term-session-pill active');
    assert.equal(activePills.at(-1)?.dataset?.termTid, 't-spawned-new');
    assert.equal(activePills.at(-1)?.innerHTML.includes('term-external-badge'), false);
    const extPill = children.filter((c) => c.dataset?.termTid === 't-ext-tab').at(-1);
    assert.ok(extPill?.innerHTML.includes('term-external-badge'));
    const hiddenExtPart = windowObj.Hangar.partitionSplitTabs([], { showExternalTerminals: false }, [{ terminalId: 'term-popped-1', title: 'ext-popped', isExternal: true }]);
    assert.equal(hiddenExtPart.workspaceTabs.some((t) => t.sidecarId === 'terminal__term-popped-1'), false);

    windowObj.Hangar.saveCustomTermTitle('t-spawned-new', 'persisted-term');
    const savedTermState = windowObj.Hangar.serializeTerminalState();
    assert.equal(savedTermState.mainTerminalOpen, true);
    assert.equal(savedSideChatState.threads.length, 2);

    const freshStore = new Map();
    const freshWin = {
      Hangar: {}, navigator: { platform: 'Win32' }, addEventListener() {}, location: { search: '?token=tok-restarted' },
      localStorage: { getItem: (k) => freshStore.get(k) || null, setItem: (k, v) => freshStore.set(k, v) },
      getSelection: () => ({ isCollapsed: true, toString: () => '' }),
    };
    const freshCtx = vm.createContext({
      window: freshWin, document: documentObj, navigator: freshWin.navigator, localStorage: freshWin.localStorage, URLSearchParams,
      requestAnimationFrame: (fn) => { fn(); return 1; }, cancelAnimationFrame() {}, Date,
      JSON, Math, Array, String, Number, Boolean, Set, Map, Object, encodeURIComponent, setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {},
    });
    for (const rel of ['ui/core.js', 'ui/components/tab-bar.js', 'ui/components/terminal-emulator.js', 'ui/components/terminal-quote.js', 'ui/components/terminal-groups.js', 'ui/components/terminal-tab.js']) {
      vm.runInContext(readFileSync(join(REPO_ROOT, rel), 'utf8'), freshCtx);
    }
    freshWin.Hangar.hydrateTerminalStateFromLayout({ terminalState: savedTermState, tabOrder: ['__terminal__', 'terminal__term-popped-1'] }, [...curTerms, { terminalId: 'term-popped-1', title: 'popped' }, { terminalId: 't-spawned-new', title: 'pwsh-new' }]);
    freshWin.Hangar.hydrateSideChatStateFromLayout({ sideChatState: savedSideChatState, tabOrder: ['__sidechat__', `sidechat__${secondCid}`, 'sidechat__sc-popped-9'] });
    assert.equal(freshWin.Hangar.isMainTerminalOpen(), true);
    assert.equal(freshWin.Hangar.getActiveGroupId('__terminal__'), 't-spawned-new');
    assert.equal(freshWin.Hangar.readCustomTermTitles()['t-spawned-new'], 'persisted-term');
    assert.equal(freshWin.Hangar.getPoppedTerminalIds().has('term-popped-1'), true);
    assert.equal(freshWin.Hangar.getSideChatState().isOpen, true);
    assert.equal(freshWin.Hangar.getPoppedSideChatIds().has(secondCid), true);
    assert.equal(freshWin.Hangar.getPoppedSideChatIds().has('sc-popped-9'), true);
    assert.equal(freshWin.Hangar.readCustomSideChatTitles()[secondCid], 'Bug Triage Chat');

    freshWin.Hangar.hydrateTerminalStateFromLayout({ terminalState: savedTermState, tabOrder: ['__terminal__', 'terminal__term-popped-1'] }, []);
    freshWin.Hangar.hydrateSideChatStateFromLayout({ sideChatState: savedSideChatState, sideChatStateByWorkspace: { 'c:/users/arthu/ideaprojects/antigravity-hangar': savedSideChatState }, tabOrder: ['__sidechat__', `sidechat__${secondCid}`] }, 'C:\\Users\\arthu\\IdeaProjects\\antigravity-sidecar-kit');
    assert.equal(freshWin.Hangar.isMainTerminalOpen(), false);
    assert.equal(freshWin.Hangar.getSideChatState().isOpen, false);
    const otherProjPart = freshWin.Hangar.partitionSplitTabs([{ sidecarId: 'context-monitor', displayName: 'Context', matchesWorkspace: true }], { tabOrder: ['context-monitor', '__terminal__', 'terminal__term-popped-1', '__sidechat__'] }, []);
    assert.deepEqual(Array.from(otherProjPart.workspaceTabs, (t) => t.sidecarId), ['context-monitor', '__extensions__']);
  });

  it('forks tool-enabled SIDE_QUESTION cascades, streams AgentStateUpdates, and injects @terminal mentions into jetbox-chat', async () => {
    const prevAddr = process.env.ANTIGRAVITY_LS_ADDRESS, prevCsrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
    process.env.ANTIGRAVITY_LS_ADDRESS = '127.0.0.1:59999'; process.env.ANTIGRAVITY_CSRF_TOKEN = 'test-csrf';
    const rpcCalls = [];
    const mockRpc = async (method, body) => {
      rpcCalls.push({ method, body });
      if (method === 'StartCascade') return { cascadeId: 'side-cascade-101' };
      if (method === 'DeleteCascadeTrajectory') return {};
      return {};
    };
    const streamFrames = Buffer.concat([
      encodeConnectFrame({ update: { conversationId: 'side-cascade-101', status: 2 } }),
      encodeConnectFrame({ error: { code: 'canceled' } }, 2),
    ]);
    const mockFetch = async () => ({ ok: true, body: new ReadableStream({ start(c) { c.enqueue(streamFrames); c.close(); } }) });
    try {
      const started = await startTerminalSideChat({ parentConversationId: 'parent-conv-1', cascadeId: 'side-cascade-101', rpcFn: mockRpc });
      assert.equal(started.cascadeId, 'side-cascade-101');
      assert.equal(started.parentConversationId, 'parent-conv-1');
      assert.deepEqual(rpcCalls[0], {
        method: 'StartCascade',
        body: { cascadeId: 'side-cascade-101', source: 12, trajectoryType: 22, baseTrajectoryIdentifier: { cascadeId: 'parent-conv-1' } },
      });
      assert.equal(rpcCalls[0].body.plannerConfig, undefined);

      const standalone = await startTerminalSideChat({ parentConversationId: '_new', cascadeId: 'side-cascade-102', rpcFn: mockRpc });
      assert.equal(standalone.cascadeId, 'side-cascade-102');
      assert.equal(rpcCalls[1].body.baseTrajectoryIdentifier, undefined);

      pollChatStream({ conversationId: 'side-cascade-101', subscriberId: 'sub-1', afterSeq: 0, fetchFn: mockFetch });
      await new Promise((r) => setTimeout(r, 25));
      const polled = pollChatStream({ conversationId: 'side-cascade-101', subscriberId: 'sub-1', afterSeq: 0, fetchFn: mockFetch });
      assert.equal(polled.chunks.length, 1);
      assert.equal(polled.chunks[0].frameData.update.conversationId, 'side-cascade-101');
      assert.equal(polled.closed, true);

      const deleted = await deleteTerminalSideChat({ cascadeId: 'side-cascade-101', rpcFn: mockRpc });
      assert.deepEqual(deleted, { ok: true, cascadeId: 'side-cascade-101' });
      assert.deepEqual(rpcCalls.at(-1), { method: 'DeleteCascadeTrajectory', body: { cascadeId: 'side-cascade-101' } });

      const chatHtml = buildJetboxChatHtml({ cascadeId: 'side-cascade-101', hostTheme: 'dark', csrfToken: 'csrf-123', uiToken: 'tok-abc' });
      assert.ok(chatHtml.includes('[data-testid="conversation-view"]') && chatHtml.includes('z-index: 10 !important') && chatHtml.includes('PatchedWorker'));
      assert.ok(chatHtml.includes('StreamAgentStateUpdates') && chatHtml.includes('hangar-inject-terminal-quote') && chatHtml.includes('hangar-sidechat-switch-cascade'));
      assert.ok(chatHtml.includes('data-hangar-overview="open"') && chatHtml.includes('hangar-sidechat-toggle-overview'));
      assert.ok(chatHtml.includes('overview-panel-row-terminal') && chatHtml.includes('hangar-sidechat-open-terminal'));
    } finally {
      if (prevAddr === undefined) delete process.env.ANTIGRAVITY_LS_ADDRESS; else process.env.ANTIGRAVITY_LS_ADDRESS = prevAddr;
      if (prevCsrf === undefined) delete process.env.ANTIGRAVITY_CSRF_TOKEN; else process.env.ANTIGRAVITY_CSRF_TOKEN = prevCsrf;
    }
  });

  it('stages and injects cross-iframe terminal quote drops into the host Hub window via DevToolsActivePort', async () => {
    const captureListeners = [], bubbleDropped = [];
    let editorFocused = false;
    const hubWin = {
      addEventListener(ev, fn, capture) { if (ev === 'drop' && capture) captureListeners.push(fn); },
      dispatchEvent(ev) {
        for (const fn of captureListeners) fn(ev);
        bubbleDropped.push(ev.dataTransfer.getData('application/context-scope-item-cider'));
      },
    };
    const hubCtx = vm.createContext({
      window: hubWin,
      document: { querySelector: (s) => (s === '[data-lexical-editor="true"]' ? { focus() { editorFocused = true; } } : null) },
      DataTransfer: class { constructor() { this.m = {}; } setData(k, v) { this.m[k] = v; } getData(k) { return this.m[k] || ''; } },
      DragEvent: class { constructor(t, init) { this.type = t; this.dataTransfer = init?.dataTransfer; this.isTrusted = false; } },
      Date, setTimeout,
    });
    const mockTargets = [
      { id: 'page-devtools', type: 'page', title: 'DevTools', url: 'devtools://devtools/bundled/inspector.html', webSocketDebuggerUrl: 'ws://127.0.0.1:54818/devtools/page/page-devtools' },
      { id: 'page-other', type: 'page', title: 'Other Task - repo - Antigravity', url: 'https://127.0.0.1:50000/c/other-conv', webSocketDebuggerUrl: 'ws://127.0.0.1:54818/devtools/page/page-other' },
      { id: 'page-match', type: 'page', title: 'Antigravity Side Chat Support - antigravity-hangar - Antigravity', url: 'https://127.0.0.1:50000/c/conv-target-1?tab=sidecar__hangar__%2F', webSocketDebuggerUrl: 'ws://127.0.0.1:54818/devtools/page/page-match' },
      { id: 'frame-hangar', type: 'iframe', parentId: 'page-match', url: 'plugin://hangar-53555/?token=abc&conversationId=conv-target-1' },
    ];
    class MockWs {
      constructor(url) { this.url = url; setTimeout(() => this.onopen?.(), 1); }
      send(raw) {
        const msg = JSON.parse(raw), val = vm.runInContext(msg.params.expression, hubCtx);
        setTimeout(() => this.onmessage?.({ data: JSON.stringify({ id: msg.id, result: { result: { value: val } } }) }), 1);
      }
      close() {}
    }
    const mockFetch = async () => ({ json: async () => mockTargets });
    const stageRes = await syncQuoteWithHostWindow({ conversationId: 'conv-target-1', terminalId: 'term-88', name: 'pwsh [dev]', selectionContent: 'line 1\nline 2', action: 'stage', cdpPort: 54818, fetchFn: mockFetch, WebSocketClass: MockWs });
    assert.deepEqual(stageRes, { ok: true, result: 'staged', targetId: 'page-match' });
    assert.equal(captureListeners.length, 1);

    const osFileDt = { files: [{ name: 'real.txt' }], getData: (k) => (k === 'text/plain' ? 'keep-me' : '') };
    for (const fn of captureListeners) fn({ isTrusted: true, dataTransfer: osFileDt });
    assert.equal(osFileDt.getData('text/plain'), 'keep-me');
    assert.equal(osFileDt.getData('application/context-scope-item-cider'), '');

    const dropRes = await syncQuoteWithHostWindow({ conversationId: '_new', terminalId: 'term-88', name: 'pwsh [dev]', selectionContent: 'line 1\nline 2', action: 'drop', cdpPort: 54818, fetchFn: mockFetch, WebSocketClass: MockWs });
    assert.deepEqual(dropRes, { ok: true, result: 'injected-drop', targetId: 'page-match' });
    assert.equal(editorFocused, true);
    assert.deepEqual(JSON.parse(bubbleDropped.at(-1)), { terminal: { processId: 'term-88', name: 'pwsh dev', selectionContent: 'line 1\nline 2' } });
    const dupInjectRes = await syncQuoteWithHostWindow({ conversationId: '_new', terminalId: 'term-88', name: 'pwsh [dev]', selectionContent: 'line 1\nline 2', action: 'drop', cdpPort: 54818, fetchFn: mockFetch, WebSocketClass: MockWs });
    assert.deepEqual(dupInjectRes, { ok: true, result: 'already-injected', targetId: 'page-match' });

    await syncQuoteWithHostWindow({ conversationId: 'conv-target-1', terminalId: 'term-99', name: 'zsh', selectionContent: 'native drop test', action: 'stage', cdpPort: 54818, fetchFn: mockFetch, WebSocketClass: MockWs });
    const strippedDt = { getData: (k) => (k === 'text/uri-list' ? 'file:///tmp/zsh-quote.txt' : (k === 'text/plain' ? '[zsh](terminal;term-99) ' : '')) };
    for (const fn of captureListeners) fn({ isTrusted: true, dataTransfer: strippedDt });
    assert.equal(strippedDt.getData('text/uri-list'), '');
    assert.equal(strippedDt.getData('text/plain'), '');
    assert.deepEqual(JSON.parse(strippedDt.getData('application/context-scope-item-cider')), { terminal: { processId: 'term-99', name: 'zsh', selectionContent: 'native drop test' } });
    const dupRes = await syncQuoteWithHostWindow({ conversationId: 'conv-target-1', terminalId: 'term-99', name: 'zsh', selectionContent: 'native drop test', action: 'drop', cdpPort: 54818, fetchFn: mockFetch, WebSocketClass: MockWs });
    assert.deepEqual(dupRes, { ok: true, result: 'already-dropped-natively', targetId: 'page-match' });
  });
});
