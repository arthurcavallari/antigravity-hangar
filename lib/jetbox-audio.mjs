/** @fileoverview Proxies Connect server-streaming StreamAudioTranscription sessions for Side Chat voice dictation. */
import {
  createConnectFrameAccumulator,
  encodeConnectFrame as encodeConnectFrameBuf,
  getLsConfig,
} from 'antigravity-sidecar-kit/rpc';
import { invalidateStateReads } from './ls-rpc.mjs';

const audioStreams = new Map();

export function evictStaleAudioStreams(nowMs = Date.now(), maxIdleMs = 90_000) {
  let evicted = 0;
  for (const [k, entry] of audioStreams.entries()) {
    if (nowMs - (entry.lastPolledAt ?? entry.createdAt ?? 0) > maxIdleMs) {
      try { entry.abortController?.abort?.(); } catch {}
      audioStreams.delete(k);
      evicted += 1;
    }
  }
  return evicted;
}

export function closeAudioStream(streamKey = '') {
  const key = String(streamKey || '').trim();
  if (!key) return { ok: true, closed: true };
  const entry = audioStreams.get(key);
  if (entry) {
    entry.closed = true;
    try { entry.abortController?.abort?.(); } catch {}
    entry.onChunk?.();
    entry.onChunk = null;
    audioStreams.delete(key);
  }
  return { ok: true, closed: true };
}

export function pollAudioStream({
  streamKey = '',
  body = {},
  afterSeq = 0,
  action = '',
  fetchFn = globalThis.fetch,
} = {}) {
  const now = Date.now();
  evictStaleAudioStreams(now);
  const key = String(streamKey || '').trim();
  if (!key) return { streamKey: '', chunks: [], seq: 0, closed: true, errorCode: 2 };
  if (action === 'close') {
    closeAudioStream(key);
    return { streamKey: key, chunks: [], seq: 0, closed: true, errorCode: 0 };
  }
  const minSeq = Math.max(0, Number(afterSeq) || 0);
  let entry = audioStreams.get(key);
  if (!entry) {
    if (minSeq > 0) {
      return { streamKey: key, chunks: [], seq: minSeq, closed: true, errorCode: 0 };
    }
    entry = {
      key,
      seq: 0,
      chunks: [],
      connecting: false,
      connected: false,
      closed: false,
      errorCode: 0,
      abortController: null,
      onChunk: null,
      createdAt: now,
      lastPolledAt: now,
    };
    audioStreams.set(key, entry);
  } else {
    entry.lastPolledAt = now;
  }
  const { lsAddress: lsAddr, csrfToken: csrf } = getLsConfig();
  if (!entry.connecting && !entry.connected && !entry.closed && lsAddr && csrf && typeof fetchFn === 'function') {
    entry.connecting = true;
    const ac = new AbortController();
    entry.abortController = ac;
    const reqPayload = body && typeof body === 'object' ? body : {};
    (async () => {
      let reader = null;
      try {
        const res = await fetchFn(
          `http://${lsAddr}/exa.language_server_pb.LanguageServerService/StreamAudioTranscription`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/connect+json',
              'Connect-Protocol-Version': '1',
              'x-codeium-csrf-token': csrf,
            },
            body: encodeConnectFrameBuf(reqPayload),
            signal: ac.signal,
          },
        );
        entry.connecting = false;
        if (!res?.ok || !res.body) {
          invalidateStateReads();
          entry.errorCode = 2;
          entry.closed = true;
          return;
        }
        entry.connected = true;
        reader = res.body.getReader();
        const acc = createConnectFrameAccumulator({ maxFrameBytes: Infinity });
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const frame of acc.push(value)) {
            if (frame.flags === 0 && frame.data && typeof frame.data === 'object') {
              entry.seq += 1;
              entry.chunks.push({ seq: entry.seq, data: frame.data });
              while (entry.chunks.length > 128) entry.chunks.shift();
              entry.onChunk?.();
              entry.onChunk = null;
            } else if ((frame.flags & 2) === 2) {
              if (frame.data?.error) entry.errorCode = 2;
              entry.closed = true;
            }
          }
          if (entry.closed) break;
        }
        entry.closed = true;
      } catch {
        if (!ac.signal.aborted) {
          invalidateStateReads();
          entry.errorCode = 2;
        }
        entry.closed = true;
      } finally {
        try { reader?.releaseLock(); } catch {}
        entry.connecting = false;
        entry.connected = false;
        entry.onChunk?.();
        entry.onChunk = null;
      }
    })();
  }
  while (minSeq > 0 && entry.chunks.length > 0 && entry.chunks[0].seq <= minSeq) {
    entry.chunks.shift();
  }
  const chunks = entry.chunks.filter((c) => c.seq > minSeq).map((c) => ({ seq: c.seq, data: c.data }));
  if (entry.closed && chunks.length === 0) {
    audioStreams.delete(key);
  }
  return {
    streamKey: key,
    seq: entry.seq,
    closed: entry.closed,
    errorCode: entry.errorCode,
    chunks,
  };
}

export async function awaitAudioPoll(data = {}, { fetchFn = globalThis.fetch } = {}) {
  const first = pollAudioStream({ ...data, fetchFn });
  if (first.chunks.length > 0 || first.closed) return first;
  const entry = audioStreams.get(first.streamKey);
  if (entry && (entry.connecting || entry.connected)) {
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 200);
      entry.onChunk = () => {
        clearTimeout(t);
        resolve();
      };
    });
    return pollAudioStream({ ...data, fetchFn });
  }
  return first;
}
