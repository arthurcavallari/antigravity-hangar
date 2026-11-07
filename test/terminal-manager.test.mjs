import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import vm from 'node:vm';
import { closeWorkspaceTerminal, createWorkspaceTerminal, DEFAULT_MAX_SCROLLBACK_BYTES, encodeConnectFrame, listWorkspaceTerminals, parseConnectFrames, pollTerminalOutput, registerTerminalRoutes, renameWorkspaceTerminal, sendTerminalInput, toWorkspaceFileUri } from '../lib/terminal-manager.mjs';
import { DEFAULT_HANGAR_CONFIG } from '../lib/constants.mjs';
import { encodeConnectFrame as kitEncodeConnectFrame, parseConnectFrames as kitParseConnectFrames } from 'antigravity-sidecar-kit/rpc';
import { buildAgyUiJs } from 'antigravity-sidecar-kit';
import { buildJetboxChatHtml, buildJetboxTerminalHtml, checkJetboxAuth, deleteTerminalSideChat, evictStaleChatStreams, pollChatStream, startTerminalSideChat, syncQuoteWithHostWindow, writeQuoteFile } from '../lib/jetbox-proxy.mjs';

const REPO_ROOT = join(import.meta.dirname, '..');

describe('Terminal Manager Connect framing, PTY RPCs, Quoting, and VT100 Emulator', () => {
  it('encodes and parses 5-byte Connect frames across fragmented chunk boundaries', () => {
    assert.equal(encodeConnectFrame, kitEncodeConnectFrame);
    assert.equal(parseConnectFrames, kitParseConnectFrames);
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

    // Projectless conversations (workspacePath: '') must never return terminals from projects or other conversations
    const mockProjectlessRpc = async () => ({
      terminals: [
        { terminalId: 't-proj-a', pid: 1001, title: 'pwsh', projectId: 'file:///c:/proj/a', conversationId: 'hangar:conv-a' },
        { terminalId: 't-proj-a-ext', pid: 1007, title: 'pwsh', projectId: '75a739a6-6915-4aab-a8c8-285c5439b4f0', workspaceUri: 'file:///C:/proj/a', conversationId: 'conv-a-other' },
        { terminalId: 't-proj-b', pid: 1002, title: 'pwsh', workspaceUri: 'file:///c:/proj/b', conversationId: 'conv-b' },
        { terminalId: 't-no-proj-other', pid: 1003, title: 'pwsh', conversationId: 'hangar:conv-other' },
        { terminalId: 't-no-proj-other-ext', pid: 1008, title: 'pwsh', projectId: 'outside-of-project', conversationId: 'conv-other' },
        { terminalId: 't-untagged', pid: 1004, title: 'pwsh' },
        { terminalId: 't-no-proj-match', pid: 1005, title: 'pwsh', conversationId: 'hangar:conv-no-proj' },
        { terminalId: 't-no-proj-ext', pid: 1006, title: 'pwsh', projectId: 'outside-of-project', conversationId: 'conv-no-proj' },
      ],
    });
    const noProjMatch = await listWorkspaceTerminals({ workspacePath: '', conversationId: 'conv-no-proj', rpcFn: mockProjectlessRpc });
    assert.deepEqual(noProjMatch.map((t) => t.terminalId), ['t-no-proj-match', 't-no-proj-ext']);
    assert.equal(noProjMatch[1].isExternal, true);
    assert.equal(noProjMatch[1].workspaceUri, '');
    const noProjNew = await listWorkspaceTerminals({ workspacePath: '', conversationId: '_new', rpcFn: mockProjectlessRpc });
    assert.deepEqual(noProjNew, []);
    const noProjEmpty = await listWorkspaceTerminals({ workspacePath: '', conversationId: '', rpcFn: mockProjectlessRpc });
    assert.deepEqual(noProjEmpty, []);
    const projAList = await listWorkspaceTerminals({ workspacePath: 'c:/proj/a', conversationId: 'conv-a', rpcFn: mockProjectlessRpc });
    assert.deepEqual(projAList.map((t) => t.terminalId), ['t-proj-a', 't-proj-a-ext', 't-untagged']);
  });

  it('creates a terminal, streams 5-byte Connect output, chains inputOffset acks, renames, and closes cleanly', async () => {
    const prevAddr = process.env.ANTIGRAVITY_LS_ADDRESS, prevCsrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
    process.env.ANTIGRAVITY_LS_ADDRESS = '127.0.0.1:59999'; process.env.ANTIGRAVITY_CSRF_TOKEN = 'test-csrf';
    const rpcCalls = [];
    const mockRpc = async (method, body) => {
      rpcCalls.push({ method, body });
      if (method === 'CreateTerminal') return { terminal: { terminalId: 'term-live-1', pid: 4242, title: 'pwsh', workspaceUri: body.workspaceUri, projectId: body.projectId, conversationId: body.conversationId } };
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
      assert.equal(rpcCalls[0].body.workspaceUri, 'file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub');
      assert.equal(rpcCalls[0].body.projectId, 'file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub');
      assert.equal(rpcCalls[0].body.conversationId, 'hangar:conv-abc');
      const initCall = rpcCalls.find((c) => c.method === 'SendTerminalInput' && c.body.inputStreamId === 'hangar-init');
      assert.equal(initCall, undefined);

      // Verify writeQuoteFile keys files by terminalId and normalizes bracketed titles so concurrent terminals do not collide
      const qUriA = writeQuoteFile('pwsh [dev]', 'quote A', 'term-alpha-1');
      const qUriB = writeQuoteFile('pwsh', 'quote B', 'term-beta-2');
      assert.notEqual(qUriA, qUriB);
      assert.ok(qUriA.endsWith('/pwsh-dev-term-alpha-1-quote.txt'));
      assert.ok(qUriB.endsWith('/pwsh-term-beta-2-quote.txt'));
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
    const payload = windowObj.Hangar.buildTerminalScopePayload({ terminalId: 'f49811d2-c03f-4484-aa22-be4aa429211d', title: 'pwsh[main]', selectionContent: 'Error: EADDRINUSE: address already in use (port 3000)' });
    assert.equal(payload.cleanName, 'pwsh main');
    assert.equal(
      payload.plainText,
      '[pwsh main](terminal;f49811d2-c03f-4484-aa22-be4aa429211d?sel=Error%3A%20EADDRINUSE%3A%20address%20already%20in%20use%20%28port%203000%29) '
    );
    assert.deepEqual(JSON.parse(payload.contextScopeJson), { terminal: { processId: 'f49811d2-c03f-4484-aa22-be4aa429211d', name: 'pwsh main', selectionContent: 'Error: EADDRINUSE: address already in use (port 3000)' } });
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
    let directRafCalls = 0;
    win.innerWidth = 800;
    doc.hidden = false;
    win.requestAnimationFrame(() => { directRafCalls++; });
    assert.equal(directRafCalls, 0, 'visible iframe delegates directly to native origRaf without setTimeout');
    const jetboxDragMime = {}, dragOverDt = {}; let dragStopped = false, dragOverStopped = false, dragOverPrevented = false;
    for (const fn of winListeners.mousedown || []) fn({ target: popupBtn, stopPropagation() {}, preventDefault() {} });
    termActiveEl.__reactFiber$xyz.memoizedState.memoizedState.current.clearSelection();
    assert.equal(termActiveEl.__reactFiber$xyz.memoizedState.memoizedState.current.cleared, undefined);
    for (const fn of winListeners.dragstart || []) fn({ target: popupBtn, stopPropagation: () => { dragStopped = true; }, dataTransfer: { setData: (k, v) => { jetboxDragMime[k] = v; } } });
    for (const fn of winListeners.dragover || []) fn({ stopPropagation: () => { dragOverStopped = true; }, preventDefault: () => { dragOverPrevented = true; }, dataTransfer: dragOverDt });
    assert.ok(dragStopped && dragOverStopped && dragOverPrevented && dragOverDt.dropEffect === 'copy' && html.includes('conversation-view-drag-tint'));
    assert.deepEqual(JSON.parse(jetboxDragMime['application/context-scope-item']), { terminal: { processId: 'term-proc-77', name: 'zsh-split', selectionContent: 'FATAL_ERR_42' } });
    assert.equal(jetboxDragMime['application/context-scope-item-cider'], jetboxDragMime['application/context-scope-item']);
    assert.equal(jetboxDragMime['text/plain'], '[zsh-split](terminal;term-proc-77?sel=FATAL_ERR_42) ');
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

    for (const rel of [
      'ui/jetbox/jetbox-shared.css',
      'ui/jetbox/jetbox-chat.css',
      'ui/jetbox/jetbox-terminal.css',
    ]) {
      const css = readFileSync(join(REPO_ROOT, rel), 'utf8');
      const golfed = css.split(/\r?\n/).filter((l) => (l.match(/;/g) || []).length >= 3);
      assert.deepEqual(golfed, [], `${rel} contains horizontally golfed CSS lines`);
    }
    const bootJs = readFileSync(join(REPO_ROOT, 'ui/jetbox/jetbox-bootstrap.js'), 'utf8');
    const bootMultiStmt = bootJs
      .split(/\r?\n/)
      .filter((l) => !l.includes('for (') && (l.match(/;/g) || []).length >= 3);
    assert.deepEqual(bootMultiStmt, [], 'jetbox-bootstrap.js contains packed multi-statement lines');
    const proxySrc = readFileSync(join(REPO_ROOT, 'lib/jetbox-proxy.mjs'), 'utf8');
    assert.ok(proxySrc.split(/\r?\n/).length < 500, 'lib/jetbox-proxy.mjs must stay under 500 lines after asset extraction');
  });

  it('parses VT100/ANSI sequences, TabGroups, splitGroupId reconciliation, inline rename, and pointer drag', async () => {
    const children = [], winListeners = {}, apiCalls = [];
    const makeEl = (rect = { left: 0, right: 80, top: 0, bottom: 22, width: 80, height: 22 }) => {
      const listeners = {}, classes = new Set(), childNodes = [];
      let html = '';
      const el = {
        className: '', style: {}, dataset: {}, value: '', textContent: '', scrollTop: 0, scrollLeft: 0, scrollWidth: 200, clientWidth: 200, scrollHeight: 100, clientHeight: 100, childNodes, children: childNodes, parentElement: null,
        get innerHTML() {
          if (html) return html;
          if (this._slots) {
            const label = this._slots.labelEl?.textContent || '';
            const ext = this._slots.extBadge && !this._slots.extBadge.classList.contains('hidden') ? '<span class="agy-tab-ext-badge"></span>' : '';
            return `${label}${ext}`;
          }
          return '';
        },
        set innerHTML(v) { html = v; if (v === '') childNodes.length = 0; },
        classList: { toggle: (c, v) => (v ? classes.add(c) : classes.delete(c)), remove: (...cs) => cs.forEach((c) => classes.delete(c)), add: (...cs) => cs.forEach((c) => classes.add(c)), contains: (c) => classes.has(c) },
        setAttribute() {}, focus() { this._focused = true; }, select() {}, replaceWith(nextEl) { children.push(nextEl); }, getBoundingClientRect: () => rect, cloneNode() { return makeEl(rect); },
        remove() {
          if (this.parentElement?.childNodes) {
            const idx = this.parentElement.childNodes.indexOf(this);
            if (idx >= 0) this.parentElement.childNodes.splice(idx, 1);
          }
        },
        querySelector(sel) {
          if (this._slots?.labelEl && String(sel).includes('tab-label')) return this._slots.labelEl;
          return makeEl(rect);
        },
        querySelectorAll: () => [],
        addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
        removeEventListener(ev, fn) { if (listeners[ev]) listeners[ev] = listeners[ev].filter((f) => f !== fn); },
        emit(ev, payload) { for (const fn of listeners[ev] || []) fn(payload); },
        append(...els) { els.forEach((c) => { if (c && typeof c === 'object') c.parentElement = el; }); childNodes.push(...els); children.push(...els); },
        appendChild(c) { if (c && typeof c === 'object') c.parentElement = el; childNodes.push(c); children.push(c); return c; },
        replaceChildren(...els) { childNodes.length = 0; els.forEach((c) => { if (c && typeof c === 'object') c.parentElement = el; }); childNodes.push(...els); children.push(...els); },
        insertBefore(c, ref) {
          if (c && typeof c === 'object') c.parentElement = el;
          const oldIdx = childNodes.indexOf(c);
          if (oldIdx >= 0) childNodes.splice(oldIdx, 1);
          const refIdx = ref ? childNodes.indexOf(ref) : -1;
          if (refIdx >= 0) childNodes.splice(refIdx, 0, c);
          else childNodes.push(c);
          children.push(c);
          return c;
        },
        contains: () => false,
      };
      return el;
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
    windowObj.document = documentObj;
    windowObj.innerWidth = 800;
    windowObj.innerHeight = 600;
    const ctx = vm.createContext({
      window: windowObj, document: documentObj, navigator: windowObj.navigator, localStorage: windowObj.localStorage, URLSearchParams,
      requestAnimationFrame: (fn) => { fn(); return 1; }, cancelAnimationFrame() {}, Date,
      JSON, Math, Array, String, Number, Boolean, Set, Map, Object, encodeURIComponent, setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {},
    });
    vm.runInContext(buildAgyUiJs('all'), ctx);
    for (const rel of [
      'ui/core.js',
      'ui/components/tab-bar.js',
      'ui/components/terminal-emulator.js',
      'ui/components/sidechat-store.js',
      'ui/components/sidechat-strip.js',
      'ui/components/sidechat-pane.js',
      'ui/components/terminal-quote.js',
      'ui/components/terminal-groups.js',
      'ui/components/terminal-drag.js',
      'ui/components/terminal-pane.js',
      'ui/components/terminal-tab.js',
    ]) {
      vm.runInContext(readFileSync(join(REPO_ROOT, rel), 'utf8'), ctx);
    }
    windowObj.Hangar.apiCall = async (path, body) => { apiCalls.push({ path, body }); return {}; };
    assert.ok(windowObj.Hangar.sideChatStore && typeof windowObj.Hangar.sideChatStore.getState === 'function');
    assert.ok(windowObj.Hangar.terminalStore && windowObj.Hangar.terminalStore.instances instanceof Map);
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
    // Regression: drag tab1 into tab2 (groupId 't2', paneIds ['t1', 't2']), then detach tab2 ('t2') back to strip
    let splitIntoT2 = windowObj.Hangar.applyTerminalDrop(
      [{ groupId: 't1', paneIds: ['t1'], focusedPaneId: 't1' }, { groupId: 't2', paneIds: ['t2'], focusedPaneId: 't2' }],
      { kind: 'tab', groupId: 't1', terminalId: 't1' },
      { zone: 'pane', targetGroupId: 't2', targetPaneId: 't2', side: 'left' }
    ).groups;
    assert.deepEqual(Array.from(splitIntoT2[0].paneIds), ['t1', 't2']);
    let unsplitT2 = windowObj.Hangar.applyTerminalDrop(
      splitIntoT2,
      { kind: 'pane', groupId: 't2', terminalId: 't2' },
      { zone: 'strip', index: 1 }
    ).groups;
    assert.deepEqual(Array.from(unsplitT2, (g) => `${g.groupId}:${g.paneIds.join(',')}`), ['t1:t1', 't2:t2']);
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
    assert.ok(windowObj.Hangar.iconSvg('globe', 15).includes('M480-80') && windowObj.Hangar.iconSvg('terminal', 16).includes('viewBox="0 0 24 24"') && children.some((c) => c.className?.includes('context-menu-sep')));
    children.find((c) => c.className?.includes('context-menu-item'))?.emit('click', { stopPropagation() {} });
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
    // Regression: dragging a split pane header (kind: 'pane', draggedIndex === -1) must not shift strip tabs negative when out of rail, must shift addBtn right by 1 slot when hovering any strip slot (including outermost last slot), and must drop at exact hovered slot
    const p3 = makeEl({ left: 128, right: 188, top: 4, bottom: 26, width: 60, height: 22 });
    const addBtn = makeEl({ left: 192, right: 214, top: 4, bottom: 26, width: 22, height: 22 });
    addBtn.className = 'agy-tab-add-btn';
    addBtn.dataset.role = 'term-add-tab';
    const paneHeaderEl = makeEl({ left: 0, right: 275, top: 34, bottom: 60, width: 275, height: 26 });
    stripEl.querySelectorAll = () => [p1, p2, p3];
    stripEl.querySelector = () => addBtn;
    let paneDroppedTarget = null;
    windowObj.Hangar.bindTermPointerDrag(paneHeaderEl, {
      kind: 'pane',
      groupId: 't4',
      terminalId: 't3',
      instanceTabId: '__terminal__',
      sessionsEl: stripEl,
      onSameInstanceDrop: (_d, tgt) => { paneDroppedTarget = tgt; },
    });
    paneHeaderEl.emit('pointerdown', { button: 0, pointerId: 2, clientX: 80, clientY: 45 });
    paneHeaderEl.emit('pointermove', { pointerId: 2, clientX: 110, clientY: 120 });
    assert.deepEqual([p1.style.transform, p2.style.transform, p3.style.transform, addBtn.style.transform], ['', '', '', '']);
    paneHeaderEl.emit('pointermove', { pointerId: 2, clientX: 195, clientY: 15 });
    assert.deepEqual([p1.style.transform, p2.style.transform, p3.style.transform, addBtn.style.transform], ['', '', '', 'translateX(64px)']);
    paneHeaderEl.emit('pointermove', { pointerId: 2, clientX: 140, clientY: 15 });
    assert.deepEqual([p1.style.transform, p2.style.transform, p3.style.transform, addBtn.style.transform], ['', '', 'translateX(64px)', 'translateX(64px)']);
    paneHeaderEl.emit('pointerup', { pointerId: 2, clientX: 140, clientY: 15 });
    assert.equal(addBtn.style.transform, '');
    assert.deepEqual(JSON.parse(JSON.stringify(paneDroppedTarget)), { zone: 'strip', index: 2 });
    const unsplitFour = windowObj.Hangar.applyTerminalDrop(
      [
        { groupId: 't1', paneIds: ['t1'], focusedPaneId: 't1' },
        { groupId: 't2', paneIds: ['t2'], focusedPaneId: 't2' },
        { groupId: 't4', paneIds: ['t3', 't4'], focusedPaneId: 't3' },
      ],
      { kind: 'pane', groupId: 't4', terminalId: 't3' },
      paneDroppedTarget
    ).groups;
    assert.deepEqual(Array.from(unsplitFour, (g) => `${g.groupId}:${g.paneIds.join(',')}`), ['t1:t1', 't2:t2', 't3:t3', 't4:t4']);
    windowObj.Hangar.saveEngineMode('jetbox'); windowObj.Hangar.saveTabGroups('__terminal__', []);
    windowObj.Hangar.renderTerminalSlots({ topTermEl: makeEl(), bottomTermEl: makeEl(), topSlotId: '__terminal__', bottomSlotId: '', splitEnabled: false, terminals: [], workspacePath: 'C:\\repo' });
    assert.equal(apiCalls.filter((c) => c.path === '/api/terminal/create').length, 0);
    assert.equal(children.some((c) => c.dataset?.testid === 'aux-pane-new-tab-button'), false);
    windowObj.Hangar.renderTerminalSlots({ topTermEl: makeEl(), bottomTermEl: makeEl(), topSlotId: '__terminal__', bottomSlotId: '', splitEnabled: false, terminals: [{ terminalId: 't1', title: 'pwsh-1', splitGroupId: 'sg-native', conversationId: 'conv-host-1' }, { terminalId: 't2', title: 'pwsh-2', splitGroupId: 'sg-native' }], conversationId: 'conv-host-1' });
    assert.deepEqual(children.filter((c) => c.className === 'term-jetbox-frame').map((c) => c.src.includes('terminalId=t1') ? 't1' : 't2'), ['t1', 't2']);
    assert.ok(children.some((c) => c.dataset?.testid === 'aux-pane-new-tab-button'));
    const sessionPill = children.find((c) => c.dataset?.termTid === 't1');
    for (let i = 0; i < 2; i++) {
      sessionPill.emit('pointerdown', { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
      sessionPill.emit('pointerup', { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
      sessionPill.emit('click', { button: 0, detail: i + 1, stopPropagation() {} });
    }
    sessionPill.emit('dblclick', { stopPropagation() {} });
    const escInp = children.filter((c) => c.className?.includes('rename-input')).at(-1);
    escInp.value = 'cancelled-name'; escInp.emit('keydown', { key: 'Escape', stopPropagation() {} }); escInp.emit('blur', {});
    assert.equal(windowObj.Hangar.readCustomTermTitles().t1, 'build-watcher');
    assert.equal(apiCalls.filter((c) => c.path === '/api/terminal/rename').length, 0);
    children.find((c) => c.dataset?.termTid === 't1').emit('dblclick', { stopPropagation() {} });
    const okInp = children.filter((c) => c.className?.includes('rename-input')).at(-1);
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
    assert.ok(children.some((c) => c.className?.includes('agy-toast') && c.textContent.includes('Quoted selection from "committed-name"')));
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
    let lastScDockEvt = null;
    windowObj.Hangar.setSideChatDockCallback((evt) => { lastScDockEvt = evt; });
    // Untrusted origin, empty origin, detached source === null, or unknown iframe source must be rejected
    for (const fn of winListeners.message || []) {
      fn({ origin: 'https://evil.example', data: { type: 'hangar-sidechat-open-terminal', payload: { cascadeId: windowObj.Hangar.getSideChatState().threads[0].cascadeId } } });
      fn({ origin: '', data: { type: 'hangar-sidechat-open-terminal', payload: { cascadeId: windowObj.Hangar.getSideChatState().threads[0].cascadeId } } });
      fn({ source: null, data: { type: 'hangar-sidechat-open-terminal', payload: { cascadeId: windowObj.Hangar.getSideChatState().threads[0].cascadeId } } });
      fn({ source: { foreignFrame: true }, data: { type: 'hangar-sidechat-open-terminal', payload: { cascadeId: windowObj.Hangar.getSideChatState().threads[0].cascadeId } } });
    }
    assert.equal(lastScDockEvt, null);
    // Verify ns.html auto-escapes untrusted strings while preserving escHtml and rawHtml
    assert.equal(
      String(windowObj.Hangar.html`<div>${'<img src=x onerror=alert(1)>'}<span>${windowObj.Hangar.escHtml('<b>ok</b>')}</span></div>`),
      '<div>&lt;img src=x onerror=alert(1)&gt;<span>&lt;b&gt;ok&lt;/b&gt;</span></div>'
    );
    for (const fn of winListeners.message || []) fn({ data: { type: 'hangar-sidechat-open-terminal', payload: { cascadeId: windowObj.Hangar.getSideChatState().threads[0].cascadeId } } });
    assert.equal(composer._overviewOpen, false);
    assert.equal(composer._els.overviewBtn.classList.contains('active'), false);
    assert.equal(lastScDockEvt?.openTerminal, true);
    assert.equal(lastScDockEvt?.pane, 'top');
    assert.equal(lastScDockEvt?.sourceTabId, '__sidechat__');
    windowObj.Hangar.renderSideChatSlot({ viewportEl: vpEl, topSlotId: 'context-monitor', bottomSlotId: '__sidechat__', splitEnabled: true });
    for (const fn of winListeners.message || []) fn({ data: { type: 'hangar-sidechat-open-terminal', payload: { cascadeId: windowObj.Hangar.getSideChatState().threads[0].cascadeId } } });
    assert.equal(lastScDockEvt?.pane, 'bottom');
    assert.equal(lastScDockEvt?.sourceTabId, '__sidechat__');
    windowObj.Hangar.renderSideChatSlot({ viewportEl: vpEl, topSlotId: '__sidechat__', bottomSlotId: '', splitEnabled: false });
    assert.equal(windowObj.Hangar.getSideChatState().threads.length, 1);
    assert.equal(windowObj.Hangar.getSideChatState().threads[0].title, 'Side Chat #1');
    miniComposer._setTargetCascadeId(windowObj.Hangar.getSideChatState().threads[0].cascadeId);
    assert.ok(miniComposer._els.sideChatBtn.innerHTML.includes('Ask in Side Chat #1'));
    assert.ok(composer._els.threadSelect.innerHTML.includes('<option value="'), 'threadSelect options must not be HTML-escaped');
    assert.equal(composer._els.threadSelect.innerHTML.includes('&lt;option'), false);
    miniComposer._els.input.value = 'Follow-up in existing thread';
    miniComposer._submitSideChat();
    assert.equal(windowObj.Hangar.getSideChatState().threads.length, 1);
    assert.equal(composer._pendingQuote.promptText, 'Follow-up in existing thread');
    const firstCid = windowObj.Hangar.getSideChatState().threads[0].cascadeId;
    const bgFrameWin = { isPooledBgFrame: true };
    composer._els.chatFrame.contentWindow = bgFrameWin;
    windowObj.Hangar.openTerminalQuoteComposer(vpEl, {}, { conversationId: 'conv-host-1', forceNewThread: true });
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(windowObj.Hangar.getSideChatState().threads.length, 2);
    assert.equal(windowObj.Hangar.getSideChatState().threads[1].title, 'Side Chat #2');
    assert.ok(composer._els.chatFrame.src.includes(encodeURIComponent(windowObj.Hangar.getSideChatState().threads[1].cascadeId)));
    // Background pooled frame in sc.frames must still be trusted by isTrustedSideChatMessage
    lastScDockEvt = null;
    for (const fn of winListeners.message || []) {
      fn({ source: bgFrameWin, data: { type: 'hangar-sidechat-open-terminal', payload: { cascadeId: firstCid } } });
    }
    assert.equal(lastScDockEvt?.openTerminal, true);
    // _handleJetboxTermEvent must reject foreign sourceWin even when p.frame is null (Direct VT100 mode)
    let foreignFocused = false;
    windowObj.Hangar._handleJetboxTermEvent(
      'hangar-jetbox-pane-focused',
      { terminalId: 't1' },
      { foreign: true },
      { visibleIds: ['t1'], setFocusedPane: () => { foreignFocused = true; } }
    );
    assert.equal(foreignFocused, false, 'foreign sourceWin must be rejected when p.frame is null');
    const scPills = children.filter((c) => c.className?.includes('agy-tab') && c.dataset?.cascadeId).slice(-2);
    assert.equal(scPills.length, 2);
    scPills.at(-1).emit('dblclick', { stopPropagation() {} });
    const scRenameInp = children.filter((c) => c.className?.includes('rename-input')).at(-1);
    scRenameInp.value = 'Bug Triage Chat';
    scRenameInp.emit('keydown', { key: 'Enter', stopPropagation() {} });
    scRenameInp.emit('blur', {});
    const secondCid = windowObj.Hangar.getSideChatState().threads[1].cascadeId;
    assert.equal(windowObj.Hangar.readCustomSideChatTitles()[secondCid], 'Bug Triage Chat');
    // Issue #2: foreign-nav state ("Back to Side Chat" button) must persist per thread across tab switches
    for (const fn of winListeners.message || []) {
      fn({
        source: bgFrameWin,
        data: {
          type: 'hangar-sidechat-foreign-nav',
          payload: { cascadeId: 'subagent-full-1', expectedCascadeId: firstCid, active: true },
        },
      });
    }
    // Active thread is currently secondCid, so backBtn stays hidden on secondCid
    assert.equal(composer._els.backBtn.classList.contains('hidden'), true);
    // Switch to firstCid -> backBtn must appear because firstCid is in Full View foreign-nav
    composer._syncThreadsUi(firstCid, null);
    assert.equal(composer._els.backBtn.classList.contains('hidden'), false);
    // Switch back to secondCid -> backBtn must hide
    composer._syncThreadsUi(secondCid, null);
    assert.equal(composer._els.backBtn.classList.contains('hidden'), true);
    // Switch back to firstCid -> backBtn must reappear, and clicking native breadcrumb (active: false) hides it
    composer._syncThreadsUi(firstCid, null);
    assert.equal(composer._els.backBtn.classList.contains('hidden'), false);
    for (const fn of winListeners.message || []) {
      fn({
        source: bgFrameWin,
        data: {
          type: 'hangar-sidechat-foreign-nav',
          payload: { cascadeId: firstCid, expectedCascadeId: firstCid, active: false },
        },
      });
    }
    assert.equal(composer._els.backBtn.classList.contains('hidden'), true);
    composer._syncThreadsUi(secondCid, null);
    composer._els.popoutBtn.emit('click', { stopPropagation() {} });
    assert.equal(windowObj.Hangar.getPoppedSideChatIds().has(secondCid), true);
    const savedSideChatState = windowObj.Hangar.serializeSideChatState();
    const remainingMainPills = composer._els.sessionsEl.childNodes.filter((c) => c.className?.includes('agy-tab') && c.dataset?.cascadeId);
    assert.equal(remainingMainPills.length, 1);
    assert.notEqual(remainingMainPills[0].dataset.cascadeId, secondCid);
    const poppedBox = children.find((c) => c.dataset?.instanceTabId === `sidechat__${secondCid}`);
    assert.ok(poppedBox);
    assert.equal(poppedBox._els.initialFrame.classList.contains('hidden'), true);
    assert.equal(poppedBox._els.chatFrame.classList.contains('hidden'), false);
    const poppedScTabs = windowObj.Hangar.partitionSplitTabs([], {}, allTerms).workspaceTabs;
    assert.ok(poppedScTabs.some((t) => t.sidecarId === `sidechat__${secondCid}` && t.displayName === 'Bug Triage Chat'));
    for (const fn of winListeners.message || []) fn({ data: { type: 'hangar-sidechat-open-terminal', payload: { cascadeId: secondCid } } });
    assert.equal(lastScDockEvt?.sourceTabId, `sidechat__${secondCid}`);
    assert.equal(windowObj.Hangar.demoteSideChatTabIntoInstance(`sidechat__${secondCid}`, { targetInstanceTabId: '__sidechat__', zone: 'strip', index: 0 }), true);
    assert.equal(windowObj.Hangar.getPoppedSideChatIds().has(secondCid), false);
    assert.equal(windowObj.Hangar.getSideChatState().threads[0].cascadeId, secondCid);
    composer._els.popoutBtn.emit('click', { stopPropagation() {} });
    assert.equal(windowObj.Hangar.getPoppedSideChatIds().has(secondCid), true);
    await windowObj.Hangar.closeSideChatInstance(`sidechat__${secondCid}`);
    assert.equal(windowObj.Hangar.getPoppedSideChatIds().has(secondCid), false);
    windowObj.Hangar.closeSideChatDrawer({ deleteAll: true, notify: false });
    children.filter((c) => c.className?.includes('agy-tab') && c.dataset?.termTid).at(-1).emit('dblclick', { stopPropagation() {} });
    const clrInp = children.filter((c) => c.className?.includes('rename-input')).at(-1);
    clrInp.value = '   '; clrInp.emit('keydown', { key: 'Enter', stopPropagation() {} });
    assert.equal(windowObj.Hangar.readCustomTermTitles().t1, undefined);
    assert.ok(children.filter((c) => c.className?.includes('agy-tab') && c.dataset?.termTid).at(-1).innerHTML.includes('zsh-osc'));
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
    const activePills = children.filter((c) => c.className?.includes('agy-tab') && c.className?.includes('active'));
    assert.equal(activePills.at(-1)?.dataset?.termTid, 't-spawned-new');
    assert.equal(activePills.at(-1)?.innerHTML.includes('agy-tab-ext-badge'), false);
    const extPill = children.filter((c) => c.dataset?.termTid === 't-ext-tab').at(-1);
    assert.ok(extPill?.innerHTML.includes('agy-tab-ext-badge'));
    const hiddenExtPart = windowObj.Hangar.partitionSplitTabs([], { showExternalTerminals: false }, [{ terminalId: 'term-popped-1', title: 'ext-popped', isExternal: true }]);
    assert.equal(hiddenExtPart.workspaceTabs.some((t) => t.sidecarId === 'terminal__term-popped-1'), false);

    windowObj.Hangar.saveCustomTermTitle('t-spawned-new', 'persisted-term');
    const savedTermState = windowObj.Hangar.serializeTerminalState();
    assert.equal(savedTermState.mainTerminalOpen, true);
    assert.equal(savedSideChatState.threads.length, 2);

    const freshStore = new Map();
    const freshWin = {
      Hangar: {}, document: documentObj, innerWidth: 800, innerHeight: 600, navigator: { platform: 'Win32' }, addEventListener() {}, location: { search: '?token=tok-restarted' },
      localStorage: { getItem: (k) => freshStore.get(k) || null, setItem: (k, v) => freshStore.set(k, v) },
      getSelection: () => ({ isCollapsed: true, toString: () => '' }),
    };
    const freshCtx = vm.createContext({
      window: freshWin, document: documentObj, navigator: freshWin.navigator, localStorage: freshWin.localStorage, URLSearchParams,
      requestAnimationFrame: (fn) => { fn(); return 1; }, cancelAnimationFrame() {}, Date,
      JSON, Math, Array, String, Number, Boolean, Set, Map, Object, encodeURIComponent, setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {},
    });
    vm.runInContext(buildAgyUiJs('all'), freshCtx);
    for (const rel of [
      'ui/core.js',
      'ui/components/tab-bar.js',
      'ui/components/terminal-emulator.js',
      'ui/components/sidechat-store.js',
      'ui/components/sidechat-strip.js',
      'ui/components/sidechat-pane.js',
      'ui/components/terminal-quote.js',
      'ui/components/terminal-groups.js',
      'ui/components/terminal-drag.js',
      'ui/components/terminal-pane.js',
      'ui/components/terminal-tab.js',
    ]) {
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

    // Projectless conversation (workspacePath === '') must not inherit global/last-project sideChatState or popped sidechat__ tabs
    freshWin.Hangar.hydrateSideChatStateFromLayout(
      {
        sideChatState: savedSideChatState,
        sideChatStateByWorkspace: { 'c:/users/arthu/ideaprojects/antigravity-hangar': savedSideChatState },
        tabOrder: ['__sidechat__', `sidechat__${secondCid}`, 'sidechat__sc-popped-9'],
      },
      '',
      'conv-without-project'
    );
    assert.equal(freshWin.Hangar.getSideChatState().isOpen, false);
    assert.equal(freshWin.Hangar.getSideChatState().threads.length, 0);
    assert.equal(freshWin.Hangar.getPoppedSideChatIds().size, 0);
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

      // When parentConversationId is not yet a local LS conversation (501 unimplemented), falls back to standalone StartCascade and replaces legacy sidechat-ts-idx IDs
      const fallbackRpcCalls = [];
      const fallbackStarted = await startTerminalSideChat({
        parentConversationId: 'unstarted-parent-uuid',
        cascadeId: 'sidechat-1793706743834-1',
        rpcFn: async (method, body) => {
          fallbackRpcCalls.push({ method, body });
          if (body.baseTrajectoryIdentifier) throw new Error('501 unimplemented: not a local conversation');
          return { cascadeId: body.cascadeId };
        },
      });
      assert.match(fallbackStarted.cascadeId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      assert.equal(fallbackStarted.parentConversationId, '');
      assert.equal(fallbackRpcCalls.length, 2);
      assert.equal(fallbackRpcCalls[1].body.baseTrajectoryIdentifier, undefined);

      // When StreamAgentStateUpdates returns not_found for a valid UUID, pollChatStream auto-calls StartCascade instead of locking closed=true
      const missingUuid = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
      const autoStartCalls = [];
      const notFoundFrame = encodeConnectFrame({ error: { code: 'not_found', message: 'not_found: trajectory not found' } }, 2);
      pollChatStream({
        conversationId: missingUuid,
        subscriberId: 'sub-heal',
        afterSeq: 0,
        fetchFn: async () => ({ ok: true, body: new ReadableStream({ start(c) { c.enqueue(notFoundFrame); c.close(); } }) }),
        rpcFn: async (method, body) => { autoStartCalls.push({ method, body }); return {}; },
      });
      await new Promise((r) => setTimeout(r, 25));
      assert.equal(autoStartCalls.length, 1);
      assert.deepEqual(autoStartCalls[0], { method: 'StartCascade', body: { cascadeId: missingUuid, trajectoryType: 22, source: 12 } });
      await deleteTerminalSideChat({ cascadeId: missingUuid, rpcFn: mockRpc });

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
      assert.ok(chatHtml.includes('div.shrink-0:has(> .\\@container\\/titlebar)'));
      assert.ok(chatHtml.includes('overview-panel-row-terminal') && chatHtml.includes('hangar-sidechat-open-terminal'));
      const chatScript = chatHtml.match(/<script>([\s\S]*?)<\/script>/)[1], chatWinListeners = {}, chatPosted = [];
      let panelVisible = true;
      const ovHostEl = {
        __reactFiber$chat: {
          memoizedProps: {
            value: {
              breakpoint: 'large',
              get isPanelVisible() { return panelVisible; },
              togglePanel() { panelVisible = !panelVisible; },
            },
          },
          return: null,
        },
      };
      const docAttrs = new Map();
      const chatWin = {
        navigator: { userAgent: 'Windows' }, localStorage: { setItem() {} }, history: { replaceState() {}, pushState() {} }, customElements: { get: () => false, define() {} },
        requestAnimationFrame: () => 1, cancelAnimationFrame() {}, fetch: async () => ({ json: async () => ({}) }),
        location: { origin: 'http://localhost:54824', pathname: '/c/side-cascade-101' }, parent: { postMessage: (msg) => chatPosted.push(msg) },
        addEventListener: (ev, fn) => { (chatWinListeners[ev] = chatWinListeners[ev] || []).push(fn); },
      };
      const chatDoc = {
        documentElement: {
          style: { setProperty() {} },
          setAttribute: (k, v) => docAttrs.set(k, v),
          removeAttribute: (k) => docAttrs.delete(k),
        },
        querySelector: (sel) => (sel === '[data-testid="overview-panel-host"]' ? ovHostEl : null),
        addEventListener() {}, removeEventListener() {},
      };
      vm.runInContext(chatScript, vm.createContext({ window: chatWin, document: chatDoc, navigator: chatWin.navigator, localStorage: chatWin.localStorage, history: chatWin.history, URL, TextEncoder, TextDecoder, Uint8Array, DataView, ReadableStream, JSON, Math, Object, String, Boolean, Number, Map, Date, encodeURIComponent, setTimeout, clearTimeout }));
      for (const fn of chatWinListeners.message || []) fn({ data: { type: 'hangar-sidechat-toggle-overview', open: true } });
      assert.equal(docAttrs.get('data-hangar-overview'), 'open');
      const termRowTarget = { getAttribute: () => null, closest: (s) => (s === '[data-testid="overview-panel-row-terminal"]' ? {} : null) };
      for (const fn of chatWinListeners.click || []) fn({ target: { parentElement: termRowTarget }, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} });
      assert.equal(docAttrs.has('data-hangar-overview'), false);
      assert.equal(panelVisible, false);
      assert.deepEqual(JSON.parse(JSON.stringify(chatPosted.slice(-2))), [
        { type: 'hangar-sidechat-overview-state', payload: { cascadeId: 'side-cascade-101', open: false } },
        { type: 'hangar-sidechat-open-terminal', payload: { cascadeId: 'side-cascade-101' } },
      ]);
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

  it('evictStaleChatStreams aborts and deletes streams idle longer than maxIdleMs and tab-bar renames via apiCall', async () => {
    const baseNow = Date.now();
    pollChatStream({ conversationId: 'stale-conv-1', subscriberId: 'sub-a', afterSeq: 0, fetchFn: null });
    assert.equal(evictStaleChatStreams(baseNow + 60_000, 120_000), 0);
    const evicted = evictStaleChatStreams(baseNow + 180_000, 120_000);
    assert.equal(evicted, 1);
    assert.equal(evictStaleChatStreams(baseNow + 180_000, 120_000), 0);

    const serverSrc = readFileSync(join(REPO_ROOT, 'server.mjs'), 'utf8');
    assert.match(serverSrc, /\/api\/sidechat\/rename/);
    assert.match(serverSrc, /UpdateConversationAnnotations/);

    const tabBarSrc = readFileSync(join(REPO_ROOT, 'ui/components/tab-bar.js'), 'utf8');
    assert.match(tabBarSrc, /ns\.apiCall\?\.\('\/api\/terminal\/rename'|ns\.apiCall\('\/api\/terminal\/rename'/);
    assert.match(tabBarSrc, /ns\.apiCall\?\.\('\/api\/sidechat\/rename'|ns\.apiCall\('\/api\/sidechat\/rename'/);
    assert.equal(tabBarSrc.includes('/exa.language_server_pb.LanguageServerService/UpdateConversationAnnotations'), false);
  });

  it('enforces checkJetboxAuth, strips csrfToken from window.__APP_CONFIG__, escapes </script>, and prevents closed terminal resurrection (HUB-01, HUB-08, HUB-10)', async () => {
    const prevUiTok = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN;
    try {
      process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN = 'secret-ui-tok-999';
      assert.equal(checkJetboxAuth({}, { headers: { origin: 'https://evil.example', 'x-sidecar-token': 'secret-ui-tok-999' } }).ok, false);
      assert.equal(checkJetboxAuth({}, { headers: { origin: 'http://127.0.0.1:51000', 'x-sidecar-token': 'wrong-tok' } }).ok, false);
      assert.equal(checkJetboxAuth({}, { headers: { origin: 'http://127.0.0.1:51000', 'x-sidecar-token': 'secret-ui-tok-999' } }).ok, true);
      assert.equal(checkJetboxAuth({}, { headers: { origin: 'http://127.0.0.1:51000', 'X-Sidecar-Token': ['secret-ui-tok-999'] } }).ok, true);
      assert.equal(checkJetboxAuth({}, { req: { url: 'http://[invalid', headers: { origin: 'http://127.0.0.1:51000' } } }).ok, false);
      assert.equal(checkJetboxAuth({}, { headers: { origin: 'http://localhost:51000' }, url: '/jetbox-terminal?token=secret-ui-tok-999' }).ok, true);
      assert.equal(checkJetboxAuth({}, { headers: { origin: 'http://127.0.0.1:51000', referer: 'http://127.0.0.1:51000/jetbox-terminal?token=secret-ui-tok-999' } }).ok, true);

      const { runWithRequestContext } = await import('antigravity-sidecar-kit/state-sync');
      const asyncStoreAuth = runWithRequestContext(
        { headers: { origin: 'http://127.0.0.1:51000' }, query: { token: 'secret-ui-tok-999' }, url: '/jetbox-terminal?token=secret-ui-tok-999' },
        () => checkJetboxAuth({ cascadeId: 'conv-1', terminalId: 'term-1' })
      );
      assert.equal(asyncStoreAuth.ok, true, 'checkJetboxAuth must resolve token from AsyncLocalStorage when SidecarApp strips data.token and omits ctx');

      const html = buildJetboxTerminalHtml({
        cascadeId: 'conv-1',
        terminalId: '</script><script>alert(1)</script>',
        hostTheme: 'dark',
        csrfToken: 'super-secret-ls-csrf-token-do-not-expose',
        uiToken: 'secret-ui-tok-999',
      });
      assert.equal(html.includes('super-secret-ls-csrf-token-do-not-expose'), false, 'LS csrfToken must never be embedded in HTML');
      assert.equal(html.includes('</script><script>alert(1)'), false, '</script> breakout must be escaped');
      assert.ok(html.includes('\\u003c/script\\u003e'));

      const apis = new Map();
      registerTerminalRoutes({ page() {}, api: (p, fn) => apis.set(p, fn) });
      const unauthorizedRes = await apis.get('/api/terminal/ls-rpc')(
        { method: 'GetSidecars' },
        { headers: { origin: 'https://evil.example' } }
      );
      assert.equal(unauthorizedRes.status, 403);
      await assert.rejects(
        () => apis.get('/api/terminal/ls-rpc')(
          { method: 'GetSidecars/../evil' },
          { headers: { origin: 'http://127.0.0.1:51000', 'x-sidecar-token': 'secret-ui-tok-999' } }
        ),
        /Disallowed Jetbox RPC method/
      );
    } finally {
      if (prevUiTok === undefined) delete process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN;
      else process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN = prevUiTok;
    }

    // HUB-08: Closing a terminal prevents concurrent poll/input/rename/list from resurrecting it
    const closedTid = 'term-closed-resurrect-check';
    await closeWorkspaceTerminal({ terminalId: closedTid, rpcFn: async () => ({}) });
    const polledAfterClose = pollTerminalOutput({ terminalId: closedTid, afterSeq: 0 });
    assert.equal(polledAfterClose.exited, true);
    assert.deepEqual(polledAfterClose.chunks, []);
    await sendTerminalInput({ terminalId: closedTid, input: 'echo should-not-resurrect\r', rpcFn: async () => ({}) });
    await renameWorkspaceTerminal({ terminalId: closedTid, title: 'Ghost Title', rpcFn: async () => ({}) });
    const listedAfterClose = await listWorkspaceTerminals({
      workspacePath: 'C:\\Users\\arthu\\IdeaProjects\\antigravity-sidecar-hub',
      rpcFn: async () => ({ terminals: [] }),
    });
    assert.equal(listedAfterClose.some((t) => t.terminalId === closedTid), false);

    // HUB-10: setup.mjs requiredFiles includes jetbox-proxy, plugin-diagnostics, terminal-manager, and terminal UI files
    const setupSrc = readFileSync(join(REPO_ROOT, 'setup.mjs'), 'utf8');
    for (const reqFile of [
      'lib/jetbox-proxy.mjs',
      'lib/plugin-diagnostics.mjs',
      'lib/terminal-manager.mjs',
      'ui/components/terminal-emulator.js',
      'ui/components/terminal-quote.js',
      'ui/components/terminal-groups.js',
      'ui/components/terminal-tab.js',
    ]) {
      assert.ok(setupSrc.includes(`'${reqFile}'`), `setup.mjs requiredFiles must include ${reqFile}`);
    }

    // HGR-AUD-03: Side-Chat session-strip inline rename routes through /api/sidechat/rename instead of /api/terminal/ls-rpc
    const quoteAndSideChatSrc = [
      'ui/components/terminal-quote.js',
      'ui/components/sidechat-store.js',
      'ui/components/sidechat-strip.js',
      'ui/components/sidechat-pane.js',
    ]
      .map((rel) => readFileSync(join(REPO_ROOT, rel), 'utf8'))
      .join('\n');
    assert.equal(
      quoteAndSideChatSrc.includes("'/api/terminal/ls-rpc', { method: 'UpdateConversationAnnotations'"),
      false,
      'terminal-quote / sidechat modules must not call disallowed UpdateConversationAnnotations on /api/terminal/ls-rpc'
    );
    const sidechatRenameMatches = quoteAndSideChatSrc.match(/\/api\/sidechat\/rename/g) || [];
    assert.ok(sidechatRenameMatches.length >= 1, 'session-strip inline rename handler must call /api/sidechat/rename');
  });

  it('deduplicates cumulative SendTerminalInput buffers, reverts title on ConPTY cursor-positioned prompts, and gates Side Chat quote auto-submit on model readiness', async () => {
    const prevAddr = process.env.ANTIGRAVITY_LS_ADDRESS;
    const prevCsrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
    process.env.ANTIGRAVITY_LS_ADDRESS = '127.0.0.1:59999';
    process.env.ANTIGRAVITY_CSRF_TOKEN = 'test-csrf-tok';
    try {
      const apis = new Map();
      registerTerminalRoutes({ page() {}, api: (p, fn) => apis.set(p, fn) }, { rpcFn: async () => ({}) });
      const lsRpcRoute = apis.get('/api/terminal/ls-rpc');
      const tid = 'term-cum-input-1';
      let streamController = null;
      const created = await createWorkspaceTerminal({
        workspacePath: 'C:\\Users\\arthu\\IdeaProjects\\antigravity-sidecar-hub',
        rpcFn: async () => ({
          terminal: {
            terminalId: tid,
            title: 'pwsh.exe',
            cwd: 'C:\\Users\\arthu\\IdeaProjects\\antigravity-sidecar-hub',
          },
        }),
        fetchFn: async () => ({
          ok: true,
          body: new ReadableStream({
            start(c) {
              streamController = c;
            },
          }),
        }),
      });
      assert.equal(created.terminalId, tid);

      // Cumulative unacknowledged buffers ("d", "di", "dir", "dir\r") with omitted inputOffset (protobuf3 default 0n) must record "dir" (ignored builtin), never "ddidirdir"
      for (const cumulative of ['d', 'di', 'dir', 'dir\r']) {
        await lsRpcRoute(
          {
            method: 'SendTerminalInput',
            body: {
              terminalId: tid,
              inputStreamId: 'stream-1',
              input: Buffer.from(cumulative, 'utf8').toString('base64'),
            },
          },
          { headers: { origin: 'http://127.0.0.1:51000' } }
        );
      }
      assert.equal(pollTerminalOutput({ terminalId: tid, afterSeq: 0 }).title, 'pwsh.exe');

      // Real command sets title, and ConPTY cursor positioning (\x1b[28;1H) before prompt reverts title to pwsh.exe
      const nextOffset = 4;
      for (const cumulative of ['g', 'gi', 'git', 'git status\r']) {
        await lsRpcRoute(
          {
            method: 'SendTerminalInput',
            body: {
              terminalId: tid,
              inputStreamId: 'stream-1',
              inputOffset: nextOffset,
              input: Buffer.from(cumulative, 'utf8').toString('base64'),
            },
          },
          { headers: { origin: 'http://127.0.0.1:51000' } }
        );
      }
      assert.equal(pollTerminalOutput({ terminalId: tid, afterSeq: 0 }).title, 'git');

      streamController.enqueue(
        encodeConnectFrame({
          output: Buffer.from('On branch main\x1b[28;1HPS C:\\Users\\arthu\\IdeaProjects\\antigravity-sidecar-hub> ', 'utf8').toString('base64'),
        })
      );
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(pollTerminalOutput({ terminalId: tid, afterSeq: 0 }).title, 'pwsh.exe');

      await closeWorkspaceTerminal({ terminalId: tid, rpcFn: async () => ({}) });
    } finally {
      if (prevAddr === undefined) delete process.env.ANTIGRAVITY_LS_ADDRESS;
      else process.env.ANTIGRAVITY_LS_ADDRESS = prevAddr;
      if (prevCsrf === undefined) delete process.env.ANTIGRAVITY_CSRF_TOKEN;
      else process.env.ANTIGRAVITY_CSRF_TOKEN = prevCsrf;
    }

    // Verify jetbox-chat quote injection unlocks userFocusAllowed, dispatches drop on editor, and waits for model readiness + trajectory chunk before auto-submitting Enter
    const chatHtml = buildJetboxChatHtml({ cascadeId: 'side-cascade-model-gate', hostTheme: 'dark', csrfToken: 'csrf', uiToken: 'tok' });
    const chatScript = chatHtml.match(/<script>([\s\S]*?)<\/script>/)[1];
    const winListeners = {};
    let modelLabel = 'Select a model';
    let editorFocused = false;
    const editorEvents = [];
    const editorEl = {
      focus() { editorFocused = true; },
      dispatchEvent(ev) { editorEvents.push(ev); return true; },
    };
    const modelBtn = {
      get textContent() { return modelLabel; },
      getAttribute: () => '',
    };
    let scheduledPollFn = null;
    const chatWin = {
      navigator: { userAgent: 'Windows' },
      localStorage: { setItem() {} },
      history: { replaceState() {}, pushState() {} },
      customElements: { get: () => false, define() {} },
      requestAnimationFrame: () => 1,
      cancelAnimationFrame() {},
      Response: globalThis.Response,
      DataTransfer: class { constructor() { this.m = {}; } setData(k, v) { this.m[k] = v; } getData(k) { return this.m[k] || ''; } },
      DragEvent: class { constructor(t, init) { this.type = t; this.dataTransfer = init?.dataTransfer; } },
      InputEvent: class { constructor(t, init) { this.type = t; this.data = init?.data; } },
      KeyboardEvent: class { constructor(t, init) { this.type = t; this.key = init?.key; } },
      fetch: async () => ({
        json: async () => ({
          chunks: [{ seq: 1, frameData: { update: { conversationId: 'side-cascade-model-gate', status: 1 } } }],
          closed: false,
        }),
      }),
      location: { origin: 'http://localhost:54824', pathname: '/c/side-cascade-model-gate' },
      parent: { postMessage() {} },
      addEventListener: (ev, fn) => { (winListeners[ev] = winListeners[ev] || []).push(fn); },
      dispatchEvent() {},
    };
    const chatDoc = {
      documentElement: { style: { setProperty() {} }, setAttribute() {}, removeAttribute() {} },
      querySelector: (sel) => (sel.includes('data-lexical-editor') ? editorEl : null),
      querySelectorAll: (sel) => (sel === 'button' ? [modelBtn] : []),
      execCommand: () => true,
      addEventListener() {},
      removeEventListener() {},
    };
    const pendingTimers = [];
    vm.runInContext(
      chatScript,
      vm.createContext({
        window: chatWin,
        document: chatDoc,
        navigator: chatWin.navigator,
        localStorage: chatWin.localStorage,
        history: chatWin.history,
        DataTransfer: chatWin.DataTransfer,
        DragEvent: chatWin.DragEvent,
        InputEvent: chatWin.InputEvent,
        KeyboardEvent: chatWin.KeyboardEvent,
        URL, TextEncoder, TextDecoder, Uint8Array, DataView, ReadableStream, JSON, Math, Object, String, Boolean, Number, Map, Date, encodeURIComponent,
        setTimeout: (fn, ms) => {
          if (ms === 120 || ms === 260) scheduledPollFn = fn;
          pendingTimers.push({ fn, ms });
          return pendingTimers.length;
        },
        clearTimeout() {},
      })
    );
    for (const fn of winListeners.message || []) {
      fn({
        source: chatWin.parent,
        data: {
          type: 'hangar-inject-terminal-quote',
          payload: {
            terminalId: 'term-quote-1',
            cleanName: 'pwsh',
            selectionContent: 'Directory: C:\\repo',
            promptText: 'this is a test. Hello',
            autoSubmit: true,
          },
        },
      });
    }
    for (const t of [...pendingTimers]) {
      if (t.ms === 45) t.fn();
    }
    for (const t of [...pendingTimers]) {
      if (t.ms === 60) t.fn();
    }
    assert.equal(editorFocused, true, 'injectTerminalQuoteIntoComposer must unlock userFocusAllowed so ed.focus() runs');
    assert.equal(editorEvents.some((e) => e.type === 'drop'), true, 'drop event must be dispatched directly on the Lexical editor element');
    assert.equal(editorEvents.some((e) => e.type === 'keydown' && e.key === 'Enter'), false, 'must not auto-submit Enter while model is still "Select a model"');

    // Once chat-poll delivers a trajectory chunk and model selector resolves to "Gemini 4 Argon High", auto-submit dispatches Enter
    modelLabel = 'Gemini 4 Argon High';
    const chatStreamRes = await chatWin.fetch('/exa.language_server_pb.LanguageServerService/StreamAgentStateUpdates', {
      body: new TextEncoder().encode(JSON.stringify({ conversationId: 'side-cascade-model-gate' })),
    });
    const reader = chatStreamRes.body.getReader();
    if (scheduledPollFn) await scheduledPollFn();
    await reader.read();
    for (const t of [...pendingTimers]) {
      if (t.ms === 40) t.fn();
    }
    assert.equal(editorEvents.some((e) => e.type === 'keydown' && e.key === 'Enter'), true, 'must auto-submit Enter once model and trajectory chunk are ready');
  });

  it('evicts acknowledged chunks in pollChatStream, enforces a 2MB unconsumed byte cap, and preserves seq continuity after idle eviction', async () => {
    const prevAddr = process.env.ANTIGRAVITY_LS_ADDRESS;
    const prevCsrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
    process.env.ANTIGRAVITY_LS_ADDRESS = '127.0.0.1:59998';
    process.env.ANTIGRAVITY_CSRF_TOKEN = 'test-csrf-tok';
    try {
      let streamCtrl = null;
      const mockFetch = async () => ({
        ok: true,
        body: new ReadableStream({
          start(c) {
            streamCtrl = c;
          },
        }),
      });
      pollChatStream({ conversationId: 'conv-ack-evict', subscriberId: 'sub-1', afterSeq: 0, fetchFn: mockFetch });
      await new Promise((r) => setTimeout(r, 10));
      assert.ok(streamCtrl, 'StreamAgentStateUpdates must open');

      // Enqueue 3 frames
      streamCtrl.enqueue(encodeConnectFrame({ step: 1, pad: 'a'.repeat(1024) }));
      streamCtrl.enqueue(encodeConnectFrame({ step: 2, pad: 'b'.repeat(1024) }));
      streamCtrl.enqueue(encodeConnectFrame({ step: 3, pad: 'c'.repeat(1024) }));
      await new Promise((r) => setTimeout(r, 15));

      const firstPoll = pollChatStream({ conversationId: 'conv-ack-evict', subscriberId: 'sub-1', afterSeq: 0, fetchFn: mockFetch });
      assert.deepEqual(firstPoll.chunks.map((c) => c.seq), [1, 2, 3]);

      // Subscriber acknowledges up to seq 2 -> chunks 1 and 2 must be evicted from memory
      const secondPoll = pollChatStream({ conversationId: 'conv-ack-evict', subscriberId: 'sub-1', afterSeq: 2, fetchFn: mockFetch });
      assert.deepEqual(secondPoll.chunks.map((c) => c.seq), [3]);

      const checkRetained = pollChatStream({ conversationId: 'conv-ack-evict', subscriberId: 'sub-1', afterSeq: 0, fetchFn: mockFetch });
      assert.deepEqual(
        checkRetained.chunks.map((c) => c.seq),
        [3],
        'acknowledged chunks (seq <= 2) must be removed from entry.chunks so they do not accumulate in RAM'
      );

      // Push five 600KB frames (~3MB total) without acknowledging -> older frames must be evicted to stay <= 2MB
      const bigPad = 'x'.repeat(600 * 1024);
      for (let i = 4; i <= 8; i++) {
        streamCtrl.enqueue(encodeConnectFrame({ step: i, pad: bigPad }));
      }
      await new Promise((r) => setTimeout(r, 20));
      const cappedPoll = pollChatStream({ conversationId: 'conv-ack-evict', subscriberId: 'sub-1', afterSeq: 0, fetchFn: mockFetch });
      const totalRetainedBytes = JSON.stringify(cappedPoll.chunks).length;
      assert.ok(
        totalRetainedBytes <= 2.2 * 1024 * 1024,
        `unconsumed chat stream buffer must be capped near 2MB, got ${totalRetainedBytes} bytes`
      );
      assert.equal(cappedPoll.chunks.at(-1).seq, 8, 'newest chunk must always be preserved');

      // Evict stale stream, then reconnect with afterSeq: 8 -> next frame must receive seq 9 (> 8)
      evictStaleChatStreams(Date.now() + 300_000, 120_000);
      pollChatStream({ conversationId: 'conv-ack-evict', subscriberId: 'sub-1', afterSeq: 8, fetchFn: mockFetch });
      await new Promise((r) => setTimeout(r, 10));
      streamCtrl.enqueue(encodeConnectFrame({ step: 9 }));
      await new Promise((r) => setTimeout(r, 15));
      const afterReconnect = pollChatStream({ conversationId: 'conv-ack-evict', subscriberId: 'sub-1', afterSeq: 8, fetchFn: mockFetch });
      assert.deepEqual(
        afterReconnect.chunks.map((c) => c.seq),
        [9],
        'reconnected stream after idle eviction must initialize seq from afterSeq so frame 9 is not dropped'
      );
    } finally {
      if (prevAddr === undefined) delete process.env.ANTIGRAVITY_LS_ADDRESS;
      else process.env.ANTIGRAVITY_LS_ADDRESS = prevAddr;
      if (prevCsrf === undefined) delete process.env.ANTIGRAVITY_CSRF_TOKEN;
      else process.env.ANTIGRAVITY_CSRF_TOKEN = prevCsrf;
    }
  });

  it('pauses chat-poll and summaries polling while hidden, wakes immediately on hangar-jetbox-shown, and diffs trajectorySummaries', async () => {
    const chatHtml = buildJetboxChatHtml({ cascadeId: 'side-cascade-vis-diff', hostTheme: 'dark', csrfToken: 'csrf', uiToken: 'tok' });
    assert.ok(chatHtml.includes('.agy-layout-vars') && chatHtml.includes('padding-left: 8px !important'));
    const chatScript = chatHtml.match(/<script>([\s\S]*?)<\/script>/)[1];
    const winListeners = {};
    const fetchCalls = [];
    let currentSummaries = {
      'conv-1': {
        summary: '@[c:\\Users\\arthu\\.gemini\\antigravity\\brain\\343b3ba5\\hangar_ui_ux_a11y_audit.md:L1] show me proof of this issue',
        stepCount: 10,
        lastModifiedTime: '2026-11-06T05:00:00Z',
        status: 1,
      },
      'conv-2': {
        summary: '@[c:\\Users\\arthu\\only_attachment.md:L5]',
        stepCount: 4,
        lastModifiedTime: '2026-11-06T05:01:00Z',
        status: 1,
      },
      'sub-1': {
        summary: 'Subagent Task',
        stepCount: 2,
        lastModifiedTime: '2026-11-06T05:02:00Z',
        status: 'CASCADE_RUN_STATUS_RUNNING',
        trajectoryMetadata: {
          parentConversationId: 'conv-1',
          subagentInfo: { displayName: 'Codebase Researcher' },
        },
      },
    };
    let chatSeq = 0;
    const timers = [];
    const parentPosts = [];
    const removedDocAttrs = [];
    const chatWin = {
      innerWidth: 900,
      navigator: { userAgent: 'Windows' },
      localStorage: { setItem() {} },
      history: { replaceState() {}, pushState() {} },
      customElements: { get: () => false, define() {} },
      requestAnimationFrame: () => 1,
      cancelAnimationFrame() {},
      Response: globalThis.Response,
      fetch: async (url, init) => {
        fetchCalls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
        if (url === '/api/terminal/chat-poll') {
          chatSeq += 1;
          return {
            json: async () => ({
              chunks: chatSeq === 1 ? [{ seq: 1, frameData: { update: { status: 1 } } }] : [],
              closed: false,
            }),
          };
        }
        if (url === '/api/terminal/ls-rpc') {
          return {
            json: async () => ({ trajectorySummaries: JSON.parse(JSON.stringify(currentSummaries)) }),
          };
        }
        return { json: async () => ({}) };
      },
      location: { origin: 'http://localhost:54824', pathname: '/c/side-cascade-vis-diff' },
      parent: { postMessage: (msg) => parentPosts.push(msg) },
      addEventListener: (ev, fn) => { (winListeners[ev] = winListeners[ev] || []).push(fn); },
      dispatchEvent() {},
    };
    const chatDoc = {
      hidden: false,
      documentElement: {
        style: { setProperty() {} },
        setAttribute: (attr, val) => { chatDoc._attrs = chatDoc._attrs || new Map(); chatDoc._attrs.set(attr, val); },
        removeAttribute: (attr) => { chatDoc._attrs?.delete(attr); removedDocAttrs.push(attr); },
      },
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      removeEventListener() {},
    };
    vm.runInContext(
      chatScript,
      vm.createContext({
        window: chatWin,
        document: chatDoc,
        navigator: chatWin.navigator,
        localStorage: chatWin.localStorage,
        history: chatWin.history,
        URL, TextEncoder, TextDecoder, Uint8Array, DataView, ReadableStream, JSON, Math, Object, String, Boolean, Number, Map, Set, Date, encodeURIComponent,
        setTimeout: (fn, ms) => {
          const item = { fn, ms, cleared: false };
          timers.push(item);
          return item;
        },
        clearTimeout: (item) => {
          if (item && typeof item === 'object') item.cleared = true;
        },
      })
    );

    const flushTimers = async (matchMs) => {
      const batch = timers.splice(0, timers.length).filter((t) => !t.cleared && (matchMs === undefined || t.ms === matchMs));
      for (const t of batch) {
        await t.fn();
      }
      for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
    };

    // Start both StreamAgentStateUpdates and JetboxSubscribeToSummaries
    const chatStreamRes = await chatWin.fetch('/exa.language_server_pb.LanguageServerService/StreamAgentStateUpdates', {
      body: new TextEncoder().encode(JSON.stringify({ conversationId: 'side-cascade-vis-diff' })),
    });
    const chatReader = chatStreamRes.body.getReader();
    await chatReader.read();

    // Non-local JetboxSubscribeToSummaries backends (Cloud=2, Enterprise=3) must return an idle stream without polling
    const cloudCallsBefore = fetchCalls.length;
    const cloudSumRes = await chatWin.fetch('/exa.language_server_pb.LanguageServerService/JetboxSubscribeToSummaries', {
      body: new TextEncoder().encode(JSON.stringify({ backend: 2 })),
    });
    let cloudResolved = false;
    cloudSumRes.body.getReader().read().then(() => {
      cloudResolved = true;
    });
    for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
    assert.equal(cloudResolved, false);
    assert.equal(fetchCalls.length, cloudCallsBefore, 'Cloud/Enterprise summary stream must not poll GetAllCascadeTrajectories');

    const sumStreamRes = await chatWin.fetch('/exa.language_server_pb.LanguageServerService/JetboxSubscribeToSummaries', {
      body: new TextEncoder().encode(JSON.stringify({ backend: 1 })),
    });
    const sumReader = sumStreamRes.body.getReader();
    const firstSumChunk = await sumReader.read();
    const firstSumFrames = parseConnectFrames(Buffer.from(firstSumChunk.value)).frames;
    assert.equal(firstSumFrames.length, 1);
    assert.deepEqual(Object.keys(firstSumFrames[0].data.updates), ['conv-1', 'conv-2', 'sub-1']);
    assert.equal(
      firstSumFrames[0].data.updates['sub-1'].notFullyIdle,
      true,
      'running subagent must have notFullyIdle=true synthesized so jetbox-main IC() and hideIdle=true do not filter it out'
    );
    assert.equal(firstSumFrames[0].data.updates['conv-1'].hasRunningSubagents, true);
    assert.equal(firstSumFrames[0].data.updates['conv-1'].hasActiveChildren, true);
    assert.equal(firstSumFrames[0].data.updates['conv-1'].notFullyIdle, true);
    assert.equal(
      firstSumFrames[0].data.updates['conv-1'].summary,
      'show me proof of this issue',
      'raw @[path] tokens must be stripped from summary when prompt text is present'
    );
    assert.equal(firstSumFrames[0].data.updates['conv-2'].notFullyIdle, false);
    assert.equal(
      firstSumFrames[0].data.updates['conv-2'].summary,
      '@only_attachment.md:L5',
      'attachment-only summary must collapse @[full/path/file] to @basename'
    );

    // Second summaries poll with identical data must NOT enqueue a duplicate frame
    let secondReadResolved = false;
    const secondReadProm = sumReader.read().then((res) => {
      secondReadResolved = true;
      return res;
    });
    await flushTimers();
    assert.equal(secondReadResolved, false, 'unchanged trajectorySummaries must not enqueue a redundant Connect frame');

    // Transition sub-1 to IDLE -> both sub-1 and parent conv-1 must be emitted in updates with notFullyIdle=false
    currentSummaries['sub-1'].status = 'CASCADE_RUN_STATUS_IDLE';
    await flushTimers();
    assert.equal(secondReadResolved, true, 'subagent status transition must enqueue a Connect frame');
    const secondSumChunk = await secondReadProm;
    const secondSumFrames = parseConnectFrames(Buffer.from(secondSumChunk.value)).frames;
    assert.deepEqual(
      Object.keys(secondSumFrames[0].data.updates),
      ['conv-1', 'sub-1'],
      'both parent and child summaries must update when subagent finishes running'
    );
    assert.equal(secondSumFrames[0].data.updates['sub-1'].notFullyIdle, false);
    assert.equal(secondSumFrames[0].data.updates['conv-1'].hasRunningSubagents, false);
    assert.equal(secondSumFrames[0].data.updates['conv-1'].notFullyIdle, false);

    // Clicking a subagent node inside overview-panel must clear data-hangar-overview and notify parent toolbar
    for (const fn of winListeners.click || []) {
      fn({
        target: {
          getAttribute: () => 'subagent-node',
          closest: (sel) => (sel.includes('overview-panel') || sel.includes('subagent-node') ? {} : null),
        },
      });
    }
    assert.ok(removedDocAttrs.includes('data-hangar-overview'));
    assert.ok(
      parentPosts.some(
        (m) => m?.type === 'hangar-sidechat-overview-state' && m.payload?.cascadeId === 'side-cascade-vis-diff' && m.payload?.open === false
      )
    );

    // Issue #1: Opening a subagent in the Aux Side Panel (pathname is still /c/side-cascade-vis-diff) must NOT trigger hangar-sidechat-foreign-nav
    const subAuxRes = await chatWin.fetch('/exa.language_server_pb.LanguageServerService/StreamAgentStateUpdates', {
      body: new TextEncoder().encode(JSON.stringify({ conversationId: 'sub-1' })),
    });
    await subAuxRes.body.cancel();
    assert.equal(
      parentPosts.some((m) => m?.type === 'hangar-sidechat-foreign-nav'),
      false,
      'Aux Pane subagent stream must not fire hangar-sidechat-foreign-nav while pathname is still the root Side Chat'
    );
    assert.equal(chatDoc._attrs?.get('data-hangar-foreign-nav'), undefined);

    // Issue #3 & Breadcrumbs: Opening Overview Panel and promoting subagent to Full View (/c/sub-1) must set data-hangar-foreign-nav="true", post hangar-sidechat-foreign-nav (active: true), and auto-close Overview Panel
    for (const fn of winListeners.message || []) {
      fn({ source: chatWin.parent, origin: 'http://localhost:54824', data: { type: 'hangar-sidechat-toggle-overview', open: true } });
    }
    assert.equal(chatDoc._attrs?.get('data-hangar-overview'), 'open');
    parentPosts.length = 0;
    chatWin.history.pushState(null, '', '/c/sub-1');
    assert.equal(chatDoc._attrs?.get('data-hangar-foreign-nav'), 'true', 'Full View promotion must unhide native breadcrumbs via data-hangar-foreign-nav="true"');
    assert.equal(chatDoc._attrs?.has('data-hangar-overview'), false, 'Full View promotion must clear data-hangar-overview');
    assert.ok(
      parentPosts.some(
        (m) => m?.type === 'hangar-sidechat-foreign-nav' && m.payload?.cascadeId === 'sub-1' && m.payload?.expectedCascadeId === 'side-cascade-vis-diff' && m.payload?.active === true
      )
    );
    assert.ok(
      parentPosts.some(
        (m) => m?.type === 'hangar-sidechat-overview-state' && m.payload?.cascadeId === 'side-cascade-vis-diff' && m.payload?.open === false
      ),
      'Full View promotion must notify parent toolbar that Overview Panel closed'
    );

    // Navigating back to parent via native breadcrumb (/c/side-cascade-vis-diff) must clear data-hangar-foreign-nav and post active: false
    parentPosts.length = 0;
    chatWin.history.pushState(null, '', '/c/side-cascade-vis-diff');
    assert.equal(chatDoc._attrs?.has('data-hangar-foreign-nav'), false);
    assert.ok(
      parentPosts.some(
        (m) => m?.type === 'hangar-sidechat-foreign-nav' && m.payload?.expectedCascadeId === 'side-cascade-vis-diff' && m.payload?.active === false
      )
    );

    // Hide Jetbox pane -> neither chat-poll nor GetAllCascadeTrajectories should be called while hidden
    for (const fn of winListeners.message || []) {
      fn({ source: chatWin.parent, origin: 'http://localhost:54824', data: { type: 'hangar-jetbox-hidden' } });
    }
    const callsBeforeHiddenTicks = fetchCalls.length;
    await flushTimers();
    await flushTimers();
    assert.equal(
      fetchCalls.length,
      callsBeforeHiddenTicks,
      'hidden Jetbox iframe must not poll /api/terminal/chat-poll or GetAllCascadeTrajectories'
    );

    // Show Jetbox pane -> immediately wakes without waiting for timer expiry
    for (const fn of winListeners.message || []) {
      fn({ source: chatWin.parent, origin: 'http://localhost:54824', data: { type: 'hangar-jetbox-shown', focus: false } });
    }
    for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
    assert.ok(
      fetchCalls.length > callsBeforeHiddenTicks,
      'hangar-jetbox-shown must wake paused streams immediately'
    );
  });

  it('caps terminal scrollback at 256 KB by default without corrupting UTF-8 boundaries, supports maxScrollbackBytes override, and deduplicates stored chunk payloads', async () => {
    assert.equal(DEFAULT_MAX_SCROLLBACK_BYTES, 262144);
    assert.equal(DEFAULT_HANGAR_CONFIG.layout.maxScrollbackBytes, 262144);

    const prevAddr = process.env.ANTIGRAVITY_LS_ADDRESS;
    const prevCsrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
    process.env.ANTIGRAVITY_LS_ADDRESS = '127.0.0.1:59999';
    process.env.ANTIGRAVITY_CSRF_TOKEN = 'test-csrf';

    // Construct 400 chunks (~1 KB each = ~400 KB total) containing multi-byte UTF-8 characters ('─' = 3 bytes)
    const unit = '─'.repeat(340) + '\n'; // 340 * 3 + 1 = 1021 bytes per chunk
    const frames = [];
    for (let i = 0; i < 400; i++) {
      const line = `[chunk-${String(i).padStart(3, '0')}]${unit}`;
      frames.push(
        encodeConnectFrame({
          output: Buffer.from(line, 'utf8').toString('base64'),
          isScrollback: i === 0,
          ...(i === 0 ? { title: 'pwsh-scroll', cwd: 'C:\\repo' } : {}),
        })
      );
    }
    const streamPayload = Buffer.concat(frames);
    const mockFetch = async () => ({
      ok: true,
      body: new ReadableStream({
        start(c) {
          c.enqueue(streamPayload);
          c.close();
        },
      }),
    });
    const mockRpc = async (method, body) => {
      if (method === 'CreateTerminal') return { terminal: { terminalId: 'term-scroll-cap-1', pid: 501, title: 'pwsh' } };
      if (method === 'CloseTerminal') return {};
      return { body };
    };

    try {
      await createWorkspaceTerminal({
        workspacePath: 'c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub',
        conversationId: 'conv-scroll',
        rpcFn: mockRpc,
        fetchFn: mockFetch,
      });
      await new Promise((r) => setTimeout(r, 35));

      const polled = pollTerminalOutput({ terminalId: 'term-scroll-cap-1', afterSeq: 0, fetchFn: mockFetch });
      const combinedText = polled.chunks.map((c) => c.text).join('');
      const totalBytes = Buffer.byteLength(combinedText, 'utf8');
      assert.ok(
        totalBytes <= DEFAULT_MAX_SCROLLBACK_BYTES,
        `expected retained scrollback (${totalBytes} bytes) <= ${DEFAULT_MAX_SCROLLBACK_BYTES} bytes`
      );
      assert.ok(totalBytes > 200 * 1024, 'expected retained scrollback to keep ~256 KB of recent output');
      assert.ok(!combinedText.includes('\ufffd'), 'UTF-8 truncation must not produce U+FFFD replacement characters');
      assert.ok(combinedText.endsWith(`[chunk-399]${unit}`), 'newest output at tail must be preserved');
      assert.ok(!combinedText.includes('[chunk-000]'), 'oldest chunks beyond 256 KB must be evicted');

      // Verify outputBase64 and rawFrame are derived on read in pollTerminalOutput
      for (const c of polled.chunks) {
        assert.equal(Buffer.from(c.outputBase64, 'base64').toString('utf8'), c.text);
        if (c.text) assert.equal(c.rawFrame.output, c.outputBase64);
      }

      // Verify custom maxScrollbackBytes override trims retained scrollback to <= 4096 bytes
      const cappedPolled = pollTerminalOutput({
        terminalId: 'term-scroll-cap-1',
        afterSeq: 0,
        maxScrollbackBytes: 4096,
        fetchFn: mockFetch,
      });
      const cappedText = cappedPolled.chunks.map((c) => c.text).join('');
      const cappedBytes = Buffer.byteLength(cappedText, 'utf8');
      assert.ok(cappedBytes <= 4096, `expected custom cap (${cappedBytes} bytes) <= 4096 bytes`);
      assert.ok(cappedBytes > 3000, 'expected custom cap to retain ~4 KB tail');
      assert.ok(!cappedText.includes('\ufffd'), 'custom cap must not corrupt multi-byte UTF-8 characters');
      assert.ok(cappedText.endsWith(`[chunk-399]${unit}`), 'custom cap must preserve newest chunk');

      // Verify terminal-manager.mjs does not store outputBase64 or rawFrame inside entry.chunks
      const tmSrc = readFileSync(join(REPO_ROOT, 'lib/terminal-manager.mjs'), 'utf8');
      assert.ok(
        !tmSrc.includes('entry.chunks.push({ seq: entry.seq, text, outputBase64') &&
          !tmSrc.includes('entry.chunks.splice(0, 150, { seq: headSeq, text: mergedText, outputBase64'),
        'entry.chunks must not store duplicate outputBase64/rawFrame copies at rest'
      );

      await closeWorkspaceTerminal({ terminalId: 'term-scroll-cap-1', rpcFn: mockRpc });
    } finally {
      if (prevAddr === undefined) delete process.env.ANTIGRAVITY_LS_ADDRESS;
      else process.env.ANTIGRAVITY_LS_ADDRESS = prevAddr;
      if (prevCsrf === undefined) delete process.env.ANTIGRAVITY_CSRF_TOKEN;
      else process.env.ANTIGRAVITY_CSRF_TOKEN = prevCsrf;
    }
  });

  it('forwards native initial*PageBounds and PROD_UI verbosity, handles >16 MiB frames with zero-parse rawJson passthrough, and proxies /symbols-icons SVGs', async () => {
    const prevAddr = process.env.ANTIGRAVITY_LS_ADDRESS;
    const prevCsrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
    process.env.ANTIGRAVITY_LS_ADDRESS = '127.0.0.1:59997';
    process.env.ANTIGRAVITY_CSRF_TOKEN = 'test-csrf-tok';
    try {
      let capturedUpstreamBody = null;
      const hugeJson = JSON.stringify({ stepCount: 1157, blob: 'z'.repeat(18 * 1024 * 1024) });
      const hugeFrame = encodeConnectFrame(hugeJson, 0);
      const deltaFrame = encodeConnectFrame({ status: 2 }, 0);
      const mockFetch = async (_url, init) => {
        capturedUpstreamBody = parseConnectFrames(Buffer.from(init.body)).frames[0]?.data;
        return {
          ok: true,
          body: new ReadableStream({
            start(c) {
              c.enqueue(hugeFrame.subarray(0, 6 * 1024 * 1024));
              c.enqueue(hugeFrame.subarray(6 * 1024 * 1024));
              c.enqueue(deltaFrame);
              c.close();
            },
          }),
        };
      };

      pollChatStream({
        conversationId: '08a812ff-b19e-4ca6-9721-e7a71876f02d',
        subscriberId: 'sub-big-1',
        trajectoryVerbosity: 'CLIENT_TRAJECTORY_VERBOSITY_PROD_UI',
        initialStepsPageBounds: { startIndex: -50 },
        initialGeneratorMetadatasPageBounds: { startIndex: -1 },
        initialExecutorMetadatasPageBounds: { startIndex: 0, endIndexExclusive: 0 },
        enableLatencyTelemetry: false,
        afterSeq: 0,
        fetchFn: mockFetch,
      });
      await new Promise((r) => setTimeout(r, 35));

      assert.deepEqual(capturedUpstreamBody, {
        conversationId: '08a812ff-b19e-4ca6-9721-e7a71876f02d',
        subscriberId: 'sub-big-1',
        trajectoryVerbosity: 'CLIENT_TRAJECTORY_VERBOSITY_PROD_UI',
        initialStepsPageBounds: { startIndex: -50 },
        initialGeneratorMetadatasPageBounds: { startIndex: -1 },
        initialExecutorMetadatasPageBounds: { startIndex: 0, endIndexExclusive: 0 },
        enableLatencyTelemetry: false,
      });

      const polled = pollChatStream({
        conversationId: '08a812ff-b19e-4ca6-9721-e7a71876f02d',
        subscriberId: 'sub-big-1',
        afterSeq: 0,
        fetchFn: mockFetch,
      });
      // Both seq 1 (18 MiB initial snapshot) and seq 2 (delta) must be retained before first ack
      assert.deepEqual(polled.chunks.map((c) => c.seq), [1, 2]);
      assert.equal(polled.chunks[0].rawJson.length, hugeJson.length);
      assert.equal(Object.keys(polled.chunks[0]).includes('frameData'), false, 'frameData must be non-enumerable so JSON.stringify skips AST serialization');

      // Verify createChatConnectStream in jetbox-bootstrap.js forwards initial*PageBounds and enqueues rawJson directly
      const chatHtml = buildJetboxChatHtml({ cascadeId: '08a812ff-b19e-4ca6-9721-e7a71876f02d', hostTheme: 'dark', uiToken: 'tok' });
      const chatScript = chatHtml.match(/<script>([\s\S]*?)<\/script>/)[1];
      let pollReqBody = null;
      const chatWin = {
        innerWidth: 900,
        navigator: { userAgent: 'Windows' },
        localStorage: { setItem() {} },
        history: { replaceState() {}, pushState() {} },
        customElements: { get: () => false, define() {} },
        requestAnimationFrame: () => 1,
        cancelAnimationFrame() {},
        Response: globalThis.Response,
        fetch: async (url, init) => {
          if (url === '/api/terminal/chat-poll') {
            pollReqBody = JSON.parse(init.body);
            return {
              json: async () => ({
                chunks: [{ seq: 1, rawJson: '{"update":{"conversationId":"08a812ff-b19e-4ca6-9721-e7a71876f02d"}}' }],
                closed: true,
              }),
            };
          }
          return { json: async () => ({}) };
        },
        location: { origin: 'http://localhost:54824', pathname: '/c/08a812ff-b19e-4ca6-9721-e7a71876f02d' },
        parent: { postMessage() {} },
        addEventListener() {},
        dispatchEvent() {},
      };
      const chatDoc = {
        hidden: false,
        documentElement: { style: { setProperty() {} }, setAttribute() {}, removeAttribute() {} },
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener() {},
        removeEventListener() {},
      };
      vm.runInContext(
        chatScript,
        vm.createContext({
          window: chatWin, document: chatDoc, navigator: chatWin.navigator, localStorage: chatWin.localStorage,
          history: chatWin.history, URL, TextEncoder, TextDecoder, Uint8Array, DataView, ReadableStream, JSON, Math, Object, String, Boolean, Number, Map, Set, Date, encodeURIComponent, setTimeout, clearTimeout,
        })
      );
      const streamRes = await chatWin.fetch('/exa.language_server_pb.LanguageServerService/StreamAgentStateUpdates', {
        body: encodeConnectFrame({
          conversationId: '08a812ff-b19e-4ca6-9721-e7a71876f02d',
          subscriberId: 'sub-ui-1',
          trajectoryVerbosity: 'CLIENT_TRAJECTORY_VERBOSITY_PROD_UI',
          initialStepsPageBounds: { startIndex: -50 },
          initialGeneratorMetadatasPageBounds: { startIndex: -1 },
          initialExecutorMetadatasPageBounds: { startIndex: 0, endIndexExclusive: 0 },
        }),
      });
      const reader = streamRes.body.getReader();
      const firstRead = await reader.read();
      assert.deepEqual(pollReqBody, {
        conversationId: '08a812ff-b19e-4ca6-9721-e7a71876f02d',
        subscriberId: 'sub-ui-1',
        trajectoryVerbosity: 'CLIENT_TRAJECTORY_VERBOSITY_PROD_UI',
        initialStepsPageBounds: { startIndex: -50 },
        initialGeneratorMetadatasPageBounds: { startIndex: -1 },
        initialExecutorMetadatasPageBounds: { startIndex: 0, endIndexExclusive: 0 },
        afterSeq: 0,
      });
      const decodedUiFrames = parseConnectFrames(Buffer.from(firstRead.value)).frames;
      assert.equal(decodedUiFrames[0].data.update.conversationId, '08a812ff-b19e-4ca6-9721-e7a71876f02d');

      // Verify /symbols-icons/* route proxies valid file/folder SVGs and blocks path traversal
      const pages = new Map();
      let requestHandler = null;
      const fakeServer = {
        listeners: () => [(_req, res) => { res.writeHead(404); res.end('fallback-404'); }],
        removeAllListeners() {},
        on: (ev, fn) => { if (ev === 'request') requestHandler = fn; },
      };
      const fakeApp = {
        page: (p, fn) => pages.set(p, fn),
        api() {},
        run: async () => fakeServer,
      };
      registerTerminalRoutes(fakeApp, {
        fetchFn: async (url) => ({
          ok: url.endsWith('/symbols-icons/icons/files/js.svg'),
          status: url.endsWith('/symbols-icons/icons/files/js.svg') ? 200 : 404,
          arrayBuffer: async () => new TextEncoder().encode('<svg id="js-icon"></svg>').buffer,
        }),
      });
      assert.ok(pages.has('/symbols-icons/*'));
      const blockedIcon = await pages.get('/symbols-icons/*')('/symbols-icons/icons/files/../secret.svg');
      assert.equal(blockedIcon.status, 404);

      await fakeApp.run();
      assert.equal(typeof requestHandler, 'function');
      let iconStatus = 0;
      let iconHeaders = null;
      let iconBody = '';
      await requestHandler(
        { method: 'GET', url: '/symbols-icons/icons/files/js.svg' },
        {
          writeHead(st, hdrs) { iconStatus = st; iconHeaders = hdrs; },
          end(b) { iconBody = Buffer.from(b).toString('utf8'); },
        }
      );
      assert.equal(iconStatus, 200);
      assert.equal(iconHeaders['Content-Type'], 'image/svg+xml; charset=utf-8');
      assert.equal(iconBody, '<svg id="js-icon"></svg>');
    } finally {
      if (prevAddr === undefined) delete process.env.ANTIGRAVITY_LS_ADDRESS;
      else process.env.ANTIGRAVITY_LS_ADDRESS = prevAddr;
      if (prevCsrf === undefined) delete process.env.ANTIGRAVITY_CSRF_TOKEN;
      else process.env.ANTIGRAVITY_CSRF_TOKEN = prevCsrf;
    }
  });
});
