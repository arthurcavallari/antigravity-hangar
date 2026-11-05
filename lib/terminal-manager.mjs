/**
 * @fileoverview Manages Antigravity Language Server PTY terminals (ListTerminals,
 * CreateTerminal, SendTerminalInput, StreamTerminalOutput, CloseTerminal) with
 * 5-byte Connect envelope framing and per-terminal output buffering.
 */

import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { pathToFileURL } from 'node:url';
import { callLsRpc, encodeConnectFrame, getLsConfig, parseConnectFrames } from 'antigravity-sidecar-kit/rpc';
import { normalizeWorkspacePath } from 'antigravity-sidecar-kit/workspace';
import { checkJetboxAuth, registerJetboxProxyRoutes } from './jetbox-proxy.mjs';
import { hangarRpc, invalidateStateReads } from './ls-rpc.mjs';

export { encodeConnectFrame, parseConnectFrames };

const terminalStreams = new Map();
const terminalSeenOrder = new Map();
const closedTerminalIds = new Set();
const MAX_CLOSED_TERMINAL_IDS = 256;
let nextTerminalSeenSeq = 1;
const OSC_TITLE_RE = /\x1b\](?:0|2);([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
const CURSOR_CSI_NEWLINE_RE = /\x1b\[(?:\d+(?:;\d+)?[Hf]|\d+[ABCDGdJ])/g;
const ANSI_STRIP_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b./g;
const PROMPT_RE = /(?:^|[\r\n])\s*(?:PS (?:[A-Za-z]:\\|\/|~)[^>]*>|PS>|[A-Za-z]:\\[^>]*>|[\w.-]+@[\w.-]+[^\r\n]*[$%#])\s*$/;
const SHELL_BUILTINS = new Set(['cd', 'set-location', 'sl', 'chdir', 'cls', 'clear', 'clear-host', 'ls', 'dir', 'get-childitem', 'gci', 'pwd', 'get-location', 'gl', 'echo', 'write-output', 'write-host', 'cat', 'type', 'get-content', 'gc', 'exit', 'true', 'false']);
export const HANGAR_CONVERSATION_PREFIX = 'hangar:';

function extractCommandTitle(rawLine = '') {
  const cleaned = String(rawLine || '').replace(/^\s*(?:&\s*)?/, '').trim();
  if (!cleaned || cleaned.startsWith('#')) return '';
  const m = cleaned.match(/^(?:"([^"]+)"|'([^']+)'|([^\s;|>&]+))/);
  const first = (m?.[1] || m?.[2] || m?.[3] || '').trim();
  if (!first || /^[A-Za-z_]\w*=/.test(first)) return '';
  const base = first.split(/[\\/]/).pop() || first;
  const noExt = base.replace(/\.(?:exe|cmd|bat|ps1|sh)$/i, '').toLowerCase();
  if (!noExt || SHELL_BUILTINS.has(noExt) || SHELL_BUILTINS.has(base.toLowerCase())) return '';
  return base;
}

export function toHangarConversationId(conversationId = '') {
  const raw = String(conversationId || '').trim() || '_new';
  return raw.startsWith(HANGAR_CONVERSATION_PREFIX) ? raw : `${HANGAR_CONVERSATION_PREFIX}${raw}`;
}

export function fromHangarConversationId(conversationId = '') {
  const raw = String(conversationId || '').trim();
  const stripped = raw.startsWith(HANGAR_CONVERSATION_PREFIX) ? raw.slice(HANGAR_CONVERSATION_PREFIX.length) : raw;
  return stripped === '_new' ? '' : stripped;
}

export function toWorkspaceFileUri(workspacePathOrUri = '') {
  const raw = String(workspacePathOrUri || '').trim();
  if (!raw) return '';
  if (/^file:\/\//i.test(raw)) {
    try {
      const decoded = decodeURIComponent(raw).replace(/\/+$/, '');
      return decoded.replace(/^file:\/\/\/([A-Z]):/, (_, d) => `file:///${d.toLowerCase()}:`);
    } catch {
      return raw.replace(/\/+$/, '');
    }
  }
  try {
    const norm = normalizeWorkspacePath(raw) || raw;
    if (/^[a-zA-Z]:(?:[\\/]|$)/.test(norm)) {
      const slash = norm.replace(/\\/g, '/').replace(/\/+$/, '');
      return encodeURI(`file:///${slash[0].toLowerCase()}${slash.slice(1)}`);
    }
    return pathToFileURL(norm)
      .href.replace(/\/+$/, '')
      .replace(/^file:\/\/\/([A-Z]):/, (_, d) => `file:///${d.toLowerCase()}:`);
  } catch {
    return '';
  }
}

function getOrCreateStreamEntry(terminalId) {
  let entry = terminalStreams.get(terminalId);
  if (!entry) {
    entry = {
      terminalId, inputStreamId: `hangar-${randomUUID().slice(0, 8)}`, createdAtMs: Date.now(), nextRetryAt: 0,
      decoder: new StringDecoder('utf8'), ackedOffset: 0, inputStreamOffsets: new Map(), inputChain: Promise.resolve(), seq: 0, chunks: [], cols: 0, rows: 0,
      title: '', baseTitle: '', customTitle: '', cwd: '', atPrompt: true, cmdRunning: false, cmdBuf: '',
      exitCode: null, exited: false, connecting: false, connected: false, abortController: null,
    };
    terminalStreams.set(terminalId, entry);
  }
  return entry;
}

function appendOutputChunk(entry, frameData) {
  if (!frameData || typeof frameData !== 'object') return;
  if (typeof frameData.title === 'string' && frameData.title) {
    entry.title = frameData.title;
    if (!entry.baseTitle) entry.baseTitle = frameData.title;
  }
  if (typeof frameData.cwd === 'string' && frameData.cwd) entry.cwd = frameData.cwd;
  if (typeof frameData.exitCode === 'number') {
    entry.exitCode = frameData.exitCode;
    entry.exited = true;
  }
  if (typeof frameData.output === 'string' && frameData.output.length > 0) {
    if (frameData.isScrollback && entry.chunks.some((c) => !c.isScrollback)) {
      entry.chunks = [];
      entry.decoder = new StringDecoder('utf8');
    }
    let text = entry.decoder.write(Buffer.from(frameData.output, 'base64'));
    let outB64 = frameData.output;
    let oscMatch;
    let oscTitle = '';
    let titleChanged = false;
    OSC_TITLE_RE.lastIndex = 0;
    while ((oscMatch = OSC_TITLE_RE.exec(text)) !== null) {
      if (oscMatch[1]?.trim()) oscTitle = oscMatch[1].trim();
    }
    const promptCandidate = text.replace(CURSOR_CSI_NEWLINE_RE, '\n').replace(ANSI_STRIP_RE, '');
    const hasPrompt = PROMPT_RE.test(promptCandidate);
    if (oscTitle) {
      entry.title = oscTitle;
      titleChanged = true;
      if (hasPrompt || !entry.baseTitle) entry.baseTitle = oscTitle;
      else entry.cmdRunning = true;
    }
    if (hasPrompt) {
      entry.atPrompt = true;
      entry.cmdBuf = '';
      if (!oscTitle && entry.cmdRunning) {
        entry.cmdRunning = false;
        const revertTitle = entry.baseTitle || 'pwsh';
        if (entry.title !== revertTitle) {
          entry.title = revertTitle;
          titleChanged = true;
        }
      }
    }
    if (!frameData.isScrollback && text.includes('\x1b[3J')) {
      const idx3 = text.lastIndexOf('\x1b[3J');
      const idx2 = text.lastIndexOf('\x1b[2J', idx3);
      const clrIdx = idx2 >= 0 && idx3 - idx2 <= 8 ? idx2 : idx3;
      entry.chunks = [];
      if (clrIdx > 0) {
        text = text.slice(clrIdx);
        outB64 = Buffer.from(text, 'utf8').toString('base64');
      }
    }
    entry.seq += 1;
    const rawFrame = titleChanged && !frameData.title ? { ...frameData, title: entry.title } : frameData;
    entry.chunks.push({ seq: entry.seq, text, outputBase64: outB64, isScrollback: Boolean(frameData.isScrollback), rawFrame });
    if (entry.chunks.length > 350) {
      const mergedText = entry.chunks.slice(0, 150).map((c) => c.text).join('');
      const mergedB64 = Buffer.from(mergedText, 'utf8').toString('base64');
      const headSeq = entry.chunks[149].seq;
      entry.chunks.splice(0, 150, { seq: headSeq, text: mergedText, outputBase64: mergedB64, isScrollback: true, rawFrame: { output: mergedB64, isScrollback: true } });
    }
  } else if (frameData.title || frameData.cwd) {
    entry.seq += 1;
    entry.chunks.push({ seq: entry.seq, text: '', outputBase64: '', isScrollback: false, rawFrame: frameData });
  }
}

export function ensureTerminalStream(terminalId, { fetchFn = globalThis.fetch } = {}) {
  if (!terminalId || closedTerminalIds.has(terminalId)) return null;
  const entry = getOrCreateStreamEntry(terminalId);
  if (entry.connecting || entry.connected || entry.exited || Date.now() < entry.nextRetryAt) return entry;
  const { lsAddress: lsAddr, csrfToken: csrf } = getLsConfig();
  if (!lsAddr || !csrf || typeof fetchFn !== 'function') return entry;
  entry.connecting = true;
  entry.nextRetryAt = Date.now() + 1500;
  const ac = new AbortController();
  entry.abortController = ac;

  (async () => {
    let reader = null;
    try {
      const res = await fetchFn(`http://${lsAddr}/exa.language_server_pb.LanguageServerService/StreamTerminalOutput`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/connect+json', 'Connect-Protocol-Version': '1', 'x-codeium-csrf-token': csrf },
        body: encodeConnectFrame({ terminalId }),
        signal: ac.signal,
      });
      entry.connecting = false;
      if (!res.ok || !res.body) return;
      entry.connected = true;
      reader = res.body.getReader();
      let carry = Buffer.alloc(0);
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        carry = Buffer.concat([carry, Buffer.from(value)]);
        const parsed = parseConnectFrames(carry);
        carry = parsed.rest;
        for (const frame of parsed.frames) {
          if (frame.flags === 0) appendOutputChunk(entry, frame.data);
          else if ((frame.flags & 2) === 2 && frame.data?.error) entry.exited = true;
        }
      }
    } catch { /* Stream closed or aborted */ } finally {
      try {
        reader?.releaseLock();
      } catch { }
      entry.connecting = false;
      entry.connected = false;
    }
  })();
  return entry;
}

export async function listWorkspaceTerminals({ workspacePath = '', workspaceUri = '', conversationId = '', showExternalTerminals = true, rpcFn = callLsRpc } = {}) {
  const res = await rpcFn('ListTerminals', {}).catch(() => null);
  const rawList = Array.isArray(res?.terminals) ? res.terminals : [];
  if (Array.isArray(res?.terminals)) {
    const liveIds = new Set(rawList.map((t) => t?.terminalId).filter(Boolean));
    for (const tid of liveIds) {
      if (!terminalSeenOrder.has(tid)) terminalSeenOrder.set(tid, nextTerminalSeenSeq++);
    }
    const now = Date.now();
    for (const [tid, entry] of terminalStreams.entries()) {
      if (!liveIds.has(tid) && now - entry.createdAtMs > 5000) {
        try { entry.abortController?.abort(); } catch { }
        terminalStreams.delete(tid);
        terminalSeenOrder.delete(tid);
      }
    }
  }
  const targetNorm = normalizeWorkspacePath(workspacePath || workspaceUri);
  const hangarCid = toHangarConversationId(conversationId);
  const filtered = rawList.filter((t) => {
    if (!t?.terminalId || closedTerminalIds.has(t.terminalId)) return false;
    const isExternal = !String(t.conversationId || '').startsWith(HANGAR_CONVERSATION_PREFIX);
    if (!showExternalTerminals && isExternal) return false;
    if (!targetNorm) return true;
    const stream = terminalStreams.get(t.terminalId);
    const tWsNorm = normalizeWorkspacePath(t.projectId || t.workspaceUri || stream?.workspaceUri || '');
    const tCwdNorm = normalizeWorkspacePath(t.cwd || stream?.cwd || '');
    if (tWsNorm && tWsNorm === targetNorm) return true;
    if (tCwdNorm && (tCwdNorm === targetNorm || tCwdNorm.startsWith(`${targetNorm}/`))) return true;
    if (conversationId && conversationId !== '_new' && (t.conversationId === conversationId || t.conversationId === hangarCid)) return true;
    return !tWsNorm && !tCwdNorm;
  });
  filtered.sort((a, b) => (terminalSeenOrder.get(a.terminalId) ?? 0) - (terminalSeenOrder.get(b.terminalId) ?? 0));
  return filtered.map((t) => {
    const stream = terminalStreams.get(t.terminalId);
    if (stream && t.title && !stream.baseTitle) stream.baseTitle = t.title;
    const isExternal = !String(t.conversationId || '').startsWith(HANGAR_CONVERSATION_PREFIX);
    return {
      terminalId: String(t.terminalId), pid: Number(t.pid || 0),
      title: stream?.customTitle || stream?.title || t.title || 'terminal', cwd: stream?.cwd || t.cwd || workspacePath || '',
      workspaceUri: t.workspaceUri || t.projectId || stream?.workspaceUri || toWorkspaceFileUri(workspacePath || workspaceUri),
      conversationId: fromHangarConversationId(t.conversationId || ''), splitGroupId: t.splitGroupId || '',
      isExternal, exited: Boolean(stream?.exited), exitCode: stream?.exitCode ?? null,
    };
  });
}

export async function createWorkspaceTerminal({
  workspacePath = '', workspaceUri = '', conversationId = '', splitFromTerminalId = '',
  cols = 0, rows = 0, rpcFn = callLsRpc, fetchFn = globalThis.fetch,
} = {}) {
  const resolvedUri = toWorkspaceFileUri(workspaceUri || workspacePath);
  const reqBody = {};
  const targetDir = normalizeWorkspacePath(workspacePath || workspaceUri);
  const hangarCid = toHangarConversationId(conversationId);
  if (resolvedUri) {
    reqBody.workspaceUri = resolvedUri;
    reqBody.projectId = resolvedUri;
  }
  if (hangarCid) reqBody.conversationId = hangarCid;
  if (splitFromTerminalId) reqBody.splitFromTerminalId = String(splitFromTerminalId);
  const res = await rpcFn('CreateTerminal', reqBody);
  invalidateStateReads('ListTerminals');
  const term = res?.terminal;
  if (!term?.terminalId) throw new Error('Language Server CreateTerminal did not return a terminal');
  closedTerminalIds.delete(term.terminalId);
  const entry = ensureTerminalStream(term.terminalId, { fetchFn });
  if (entry) {
    if (term.title && !entry.baseTitle) {
      entry.baseTitle = term.title;
      if (!entry.title) entry.title = term.title;
    }
    if (resolvedUri) entry.workspaceUri = resolvedUri;
    if (targetDir && !entry.cwd) entry.cwd = targetDir;
  }
  if (cols > 0 && rows > 0) {
    const rCols = Math.round(cols);
    const rRows = Math.round(rows);
    if (entry) {
      entry.cols = rCols;
      entry.rows = rRows;
    }
    await rpcFn('SendTerminalInput', { terminalId: term.terminalId, resize: { cols: rCols, rows: rRows } }).catch(() => { });
  }
  return {
    ...term,
    workspaceUri: term.workspaceUri || term.projectId || resolvedUri,
    conversationId: fromHangarConversationId(term.conversationId || hangarCid),
  };
}

export function recordTerminalInput(terminalId = '', data = '', inputStreamId = '', inputOffset = undefined) {
  if (!terminalId || closedTerminalIds.has(terminalId) || typeof data !== 'string' || !data) return;
  const entry = getOrCreateStreamEntry(terminalId);
  let slice = data;
  if (inputStreamId) {
    const rawBuf = Buffer.from(data, 'utf8');
    const offset = Math.max(0, Number(inputOffset) || 0);
    const end = offset + rawBuf.length;
    const prevEnd = entry.inputStreamOffsets.get(inputStreamId) ?? offset;
    if (end <= prevEnd) return;
    if (offset < prevEnd) {
      slice = rawBuf.subarray(prevEnd - offset).toString('utf8');
    }
    entry.inputStreamOffsets.set(inputStreamId, end);
    if (entry.inputStreamOffsets.size > 16) {
      const oldest = entry.inputStreamOffsets.keys().next().value;
      if (oldest !== undefined) entry.inputStreamOffsets.delete(oldest);
    }
  }
  for (let i = 0; i < slice.length; i++) {
    const ch = slice[i];
    if (ch === '\x03') {
      entry.cmdBuf = '';
      entry.atPrompt = true;
      continue;
    }
    if (!entry.atPrompt) continue;
    if (ch === '\r' || ch === '\n') {
      const cmd = extractCommandTitle(entry.cmdBuf.trim());
      entry.cmdBuf = '';
      if (cmd) {
        entry.atPrompt = false;
        entry.cmdRunning = true;
        entry.title = cmd;
        entry.seq += 1;
        entry.chunks.push({ seq: entry.seq, text: '', outputBase64: '', isScrollback: false, rawFrame: { title: cmd } });
      }
    } else if (ch === '\x7f' || ch === '\b') {
      entry.cmdBuf = entry.cmdBuf.slice(0, -1);
    } else if (ch === '\x1b') {
      const next = slice[i + 1];
      if (next === '[') {
        i += 2;
        while (i < slice.length && (slice.charCodeAt(i) < 0x40 || slice.charCodeAt(i) > 0x7e)) i++;
      } else if (next === ']') {
        i += 2;
        while (i < slice.length && slice[i] !== '\x07' && !(slice[i] === '\x1b' && slice[i + 1] === '\\')) i++;
        if (slice[i] === '\x1b') i++;
      } else if (next !== undefined) {
        i += 1;
      }
    } else if (ch >= ' ' && ch !== '\t') {
      entry.cmdBuf += ch;
    }
  }
}

export async function sendTerminalInput({
  terminalId = '', data = '', cols = 0, rows = 0, rpcFn = callLsRpc, fetchFn = globalThis.fetch,
} = {}) {
  if (!terminalId) throw new Error('terminalId is required');
  if (closedTerminalIds.has(terminalId)) return { ok: false, ackedOffset: 0, closed: true };
  const entry = ensureTerminalStream(terminalId, { fetchFn });
  if (cols > 0 && rows > 0) {
    const rCols = Math.round(cols);
    const rRows = Math.round(rows);
    if (rCols !== entry.cols || rRows !== entry.rows) {
      entry.cols = rCols;
      entry.rows = rRows;
      await rpcFn('SendTerminalInput', { terminalId, resize: { cols: rCols, rows: rRows } });
    }
  }
  if (typeof data === 'string' && data.length > 0) {
    recordTerminalInput(terminalId, data);
    const b64 = Buffer.from(data, 'utf8').toString('base64');
    const task = entry.inputChain.then(async () => {
      const res = await rpcFn('SendTerminalInput', {
        terminalId, inputStreamId: entry.inputStreamId, inputOffset: String(entry.ackedOffset), input: b64,
      });
      const nextAck = Number(res?.ackedOffset);
      entry.ackedOffset = (Number.isFinite(nextAck) && nextAck >= entry.ackedOffset)
        ? nextAck : entry.ackedOffset + Buffer.byteLength(data, 'utf8');
    });
    entry.inputChain = task.catch(() => { });
    await task;
  }
  return { ok: true, ackedOffset: entry.ackedOffset };
}

export function pollTerminalOutput({ terminalId = '', afterSeq = 0, fetchFn = globalThis.fetch } = {}) {
  if (!terminalId || closedTerminalIds.has(terminalId)) return { terminalId: String(terminalId || ''), chunks: [], seq: 0, title: '', cwd: '', exited: Boolean(terminalId && closedTerminalIds.has(terminalId)), exitCode: terminalId && closedTerminalIds.has(terminalId) ? 0 : null };
  const entry = ensureTerminalStream(terminalId, { fetchFn });
  const minSeq = Number(afterSeq) || 0;
  return {
    terminalId, seq: entry.seq, title: entry.customTitle || entry.title, cwd: entry.cwd, exited: entry.exited, exitCode: entry.exitCode,
    chunks: entry.chunks.filter((c) => c.seq > minSeq).map((c) => ({
      seq: c.seq, text: c.text, outputBase64: c.outputBase64, isScrollback: c.isScrollback, rawFrame: c.rawFrame,
    })),
  };
}

export async function renameWorkspaceTerminal({
  terminalId = '',
  title = '',
  rpcFn = callLsRpc,
} = {}) {
  if (!terminalId) throw new Error('terminalId is required');
  const cleanTitle = String(title || '').trim();
  if (!closedTerminalIds.has(terminalId)) {
    const entry = getOrCreateStreamEntry(terminalId);
    entry.customTitle = cleanTitle;
  }
  await rpcFn('RenameTerminal', { terminalId, title: cleanTitle }).catch(() => { });
  invalidateStateReads('ListTerminals');
  return { ok: true, terminalId, title: cleanTitle };
}

export async function closeWorkspaceTerminal({
  terminalId = '',
  rpcFn = callLsRpc,
} = {}) {
  if (!terminalId) throw new Error('terminalId is required');
  closedTerminalIds.add(terminalId);
  if (closedTerminalIds.size > MAX_CLOSED_TERMINAL_IDS) {
    const oldest = closedTerminalIds.values().next().value;
    if (oldest !== undefined) closedTerminalIds.delete(oldest);
  }
  const existing = terminalStreams.get(terminalId);
  if (existing) {
    existing.exited = true;
    try { existing.abortController?.abort(); } catch { }
    terminalStreams.delete(terminalId);
  }
  terminalSeenOrder.delete(terminalId);
  await rpcFn('CloseTerminal', { terminalId, force: true });
  invalidateStateReads('ListTerminals');
  return { ok: true, terminalId };
}

export function registerTerminalRoutes(app, options = {}) {
  const ResponseClass = options.ResponseClass;
  const guard = (fn) => async (data, ctx) => {
    const auth = checkJetboxAuth(data, ctx, { requireToken: true });
    if (!auth.ok) {
      const payload = { ok: false, error: auth.error, status: auth.status };
      return ResponseClass ? new ResponseClass(JSON.stringify(payload), { status: auth.status, contentType: 'application/json; charset=utf-8' }) : payload;
    }
    return fn(data, ctx);
  };
  app.api('/api/terminal/list', guard((data) => listWorkspaceTerminals(data || {})), 'POST');
  app.api('/api/terminal/create', guard((data) => createWorkspaceTerminal(data || {})), 'POST');
  app.api('/api/terminal/input', guard((data) => sendTerminalInput(data || {})), 'POST');
  app.api('/api/terminal/poll', guard((data) => pollTerminalOutput(data || {})), 'POST');
  app.api('/api/terminal/rename', guard((data) => renameWorkspaceTerminal(data || {})), 'POST');
  app.api('/api/terminal/close', guard((data) => closeWorkspaceTerminal(data || {})), 'POST');
  registerJetboxProxyRoutes(app, { rpcFn: hangarRpc, ...options, onTerminalInput: recordTerminalInput });
}
