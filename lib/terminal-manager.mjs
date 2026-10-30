/**
 * @fileoverview Manages Antigravity Language Server PTY terminals (ListTerminals,
 * CreateTerminal, SendTerminalInput, StreamTerminalOutput, CloseTerminal) with
 * 5-byte Connect envelope framing and per-terminal output buffering.
 */

import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { pathToFileURL } from 'node:url';
import { callLsRpc, getLsConfig } from 'antigravity-sidecar-kit/rpc';
import { normalizeWorkspacePath } from 'antigravity-sidecar-kit/workspace';
import { registerJetboxProxyRoutes } from './jetbox-proxy.mjs';

const terminalStreams = new Map();

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
    return pathToFileURL(norm)
      .href.replace(/\/+$/, '')
      .replace(/^file:\/\/\/([A-Z]):/, (_, d) => `file:///${d.toLowerCase()}:`);
  } catch {
    return '';
  }
}

export function encodeConnectFrame(obj, flags = 0) {
  const jsonBytes = Buffer.from(JSON.stringify(obj), 'utf8');
  const frame = Buffer.alloc(5 + jsonBytes.length);
  frame.writeUInt8(flags & 0xff, 0);
  frame.writeUInt32BE(jsonBytes.length, 1);
  jsonBytes.copy(frame, 5);
  return frame;
}

export function parseConnectFrames(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  const frames = [];
  let offset = 0;
  while (offset + 5 <= buf.length) {
    const flags = buf.readUInt8(offset);
    const length = buf.readUInt32BE(offset + 1);
    if (offset + 5 + length > buf.length) break;
    const slice = buf.subarray(offset + 5, offset + 5 + length);
    offset += 5 + length;
    let data = null;
    try {
      data = JSON.parse(slice.toString('utf8'));
    } catch {
      data = { raw: slice.toString('utf8') };
    }
    frames.push({ flags, data });
  }
  return { frames, rest: buf.subarray(offset) };
}

function getOrCreateStreamEntry(terminalId) {
  let entry = terminalStreams.get(terminalId);
  if (!entry) {
    entry = {
      terminalId, inputStreamId: `hangar-${randomUUID().slice(0, 8)}`, createdAtMs: Date.now(), nextRetryAt: 0,
      decoder: new StringDecoder('utf8'), ackedOffset: 0, inputChain: Promise.resolve(), seq: 0, chunks: [], cols: 0, rows: 0,
      title: '', customTitle: '', cwd: '', exitCode: null, exited: false, connecting: false, connected: false, abortController: null,
    };
    terminalStreams.set(terminalId, entry);
  }
  return entry;
}

function appendOutputChunk(entry, frameData) {
  if (!frameData || typeof frameData !== 'object') return;
  if (typeof frameData.title === 'string' && frameData.title) entry.title = frameData.title;
  if (typeof frameData.cwd === 'string' && frameData.cwd) entry.cwd = frameData.cwd;
  if (typeof frameData.exitCode === 'number') { entry.exitCode = frameData.exitCode; entry.exited = true; }
  if (typeof frameData.output === 'string' && frameData.output.length > 0) {
    if (frameData.isScrollback && entry.chunks.some((c) => !c.isScrollback)) {
      entry.chunks = [];
      entry.decoder = new StringDecoder('utf8');
    }
    const rawText = entry.decoder.write(Buffer.from(frameData.output, 'base64'));
    const text = rawText
      .replace(/\x1b\[H(?:\r?\n)+\x1b\[H/g, '\x1b[H')
      .replace(/(?:\x1b\[K\r?\n)+(?:\x1b\[K)?(?=(?:\x1b\[\?25[lh]|\x1b\[m)*\x1b\[(?:\d+;\d+)?H)/g, '\x1b[K\x1b[J');
    const outputBase64 = text === rawText ? frameData.output : Buffer.from(text, 'utf8').toString('base64');
    entry.seq += 1;
    entry.chunks.push({ seq: entry.seq, text, outputBase64, isScrollback: Boolean(frameData.isScrollback), rawFrame: frameData });
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
  if (!terminalId) return null;
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
      try { reader?.releaseLock(); } catch {}
      entry.connecting = false; entry.connected = false;
    }
  })();
  return entry;
}

export async function listWorkspaceTerminals({ workspacePath = '', workspaceUri = '', conversationId = '', rpcFn = callLsRpc } = {}) {
  const res = await rpcFn('ListTerminals', {}).catch(() => null);
  const rawList = Array.isArray(res?.terminals) ? res.terminals : [];
  if (Array.isArray(res?.terminals)) {
    const liveIds = new Set(rawList.map((t) => t?.terminalId).filter(Boolean));
    const now = Date.now();
    for (const [tid, entry] of terminalStreams.entries()) {
      if (!liveIds.has(tid) && now - entry.createdAtMs > 5000) {
        try { entry.abortController?.abort(); } catch {}
        terminalStreams.delete(tid);
      }
    }
  }
  const targetNorm = normalizeWorkspacePath(workspacePath || workspaceUri);
  const filtered = rawList.filter((t) => {
    if (!t?.terminalId) return false;
    if (!targetNorm) return true;
    const tWsNorm = normalizeWorkspacePath(t.workspaceUri || ''), tCwdNorm = normalizeWorkspacePath(t.cwd || '');
    if (tWsNorm && tWsNorm === targetNorm) return true;
    if (tCwdNorm && (tCwdNorm === targetNorm || tCwdNorm.startsWith(`${targetNorm}/`))) return true;
    if (conversationId && conversationId !== '_new' && t.conversationId === conversationId) return true;
    return !tWsNorm && !tCwdNorm;
  });
  return filtered.map((t) => {
    const stream = terminalStreams.get(t.terminalId);
    return {
      terminalId: String(t.terminalId), pid: Number(t.pid || 0),
      title: stream?.customTitle || stream?.title || t.title || 'terminal', cwd: stream?.cwd || t.cwd || workspacePath || '',
      workspaceUri: t.workspaceUri || toWorkspaceFileUri(workspacePath || workspaceUri),
      conversationId: t.conversationId || '', splitGroupId: t.splitGroupId || '',
      exited: Boolean(stream?.exited), exitCode: stream?.exitCode ?? null,
    };
  });
}

export async function createWorkspaceTerminal({
  workspacePath = '', workspaceUri = '', conversationId = '', splitFromTerminalId = '',
  cols = 0, rows = 0, rpcFn = callLsRpc, fetchFn = globalThis.fetch,
} = {}) {
  const resolvedUri = toWorkspaceFileUri(workspaceUri || workspacePath), reqBody = {};
  if (resolvedUri) reqBody.workspaceUri = resolvedUri;
  if (conversationId && conversationId !== '_new') reqBody.conversationId = String(conversationId);
  if (splitFromTerminalId) reqBody.splitFromTerminalId = String(splitFromTerminalId);
  const res = await rpcFn('CreateTerminal', reqBody);
  const term = res?.terminal;
  if (!term?.terminalId) throw new Error('Language Server CreateTerminal did not return a terminal');
  const entry = ensureTerminalStream(term.terminalId, { fetchFn });
  if (cols > 0 && rows > 0) {
    const rCols = Math.round(cols), rRows = Math.round(rows);
    if (entry) { entry.cols = rCols; entry.rows = rRows; }
    await rpcFn('SendTerminalInput', { terminalId: term.terminalId, resize: { cols: rCols, rows: rRows } }).catch(() => {});
  }
  return term;
}

export async function sendTerminalInput({
  terminalId = '', data = '', cols = 0, rows = 0, rpcFn = callLsRpc, fetchFn = globalThis.fetch,
} = {}) {
  if (!terminalId) throw new Error('terminalId is required');
  const entry = ensureTerminalStream(terminalId, { fetchFn });
  if (cols > 0 && rows > 0) {
    const rCols = Math.round(cols), rRows = Math.round(rows);
    if (rCols !== entry.cols || rRows !== entry.rows) {
      entry.cols = rCols; entry.rows = rRows;
      await rpcFn('SendTerminalInput', { terminalId, resize: { cols: rCols, rows: rRows } });
    }
  }
  if (typeof data === 'string' && data.length > 0) {
    const b64 = Buffer.from(data, 'utf8').toString('base64');
    const task = entry.inputChain.then(async () => {
      const res = await rpcFn('SendTerminalInput', {
        terminalId, inputStreamId: entry.inputStreamId, inputOffset: String(entry.ackedOffset), input: b64,
      });
      const nextAck = Number(res?.ackedOffset);
      entry.ackedOffset = (Number.isFinite(nextAck) && nextAck >= entry.ackedOffset)
        ? nextAck : entry.ackedOffset + Buffer.byteLength(data, 'utf8');
    });
    entry.inputChain = task.catch(() => {});
    await task;
  }
  return { ok: true, ackedOffset: entry.ackedOffset };
}

export function pollTerminalOutput({ terminalId = '', afterSeq = 0, fetchFn = globalThis.fetch } = {}) {
  if (!terminalId) return { chunks: [], seq: 0, exited: false };
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
  const entry = getOrCreateStreamEntry(terminalId);
  entry.customTitle = cleanTitle;
  await rpcFn('RenameTerminal', { terminalId, title: cleanTitle }).catch(() => {});
  return { ok: true, terminalId, title: cleanTitle };
}

export async function closeWorkspaceTerminal({
  terminalId = '',
  rpcFn = callLsRpc,
} = {}) {
  if (!terminalId) throw new Error('terminalId is required');
  const existing = terminalStreams.get(terminalId);
  if (existing) {
    try { existing.abortController?.abort(); } catch {}
    terminalStreams.delete(terminalId);
  }
  await rpcFn('CloseTerminal', { terminalId, force: true });
  return { ok: true, terminalId };
}

export function registerTerminalRoutes(app, options = {}) {
  app.api('/api/terminal/list', (data) => listWorkspaceTerminals(data || {}), 'POST');
  app.api('/api/terminal/create', (data) => createWorkspaceTerminal(data || {}), 'POST');
  app.api('/api/terminal/input', (data) => sendTerminalInput(data || {}), 'POST');
  app.api('/api/terminal/poll', (data) => pollTerminalOutput(data || {}), 'POST');
  app.api('/api/terminal/rename', (data) => renameWorkspaceTerminal(data || {}), 'POST');
  app.api('/api/terminal/close', (data) => closeWorkspaceTerminal(data || {}), 'POST');
  registerJetboxProxyRoutes(app, options);
}
