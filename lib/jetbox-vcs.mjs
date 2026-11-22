/** @fileoverview Proxies Connect server-streaming WatchVersionControlState sessions for Side Question Review & File Viewer panes. */
import {
  createConnectFrameAccumulator,
  encodeConnectFrame as encodeConnectFrameBuf,
  getLsConfig,
} from 'antigravity-sidecar-kit/rpc';
import { invalidateStateReads } from './ls-rpc.mjs';

const vcsStreams = new Map();
const EMPTY_VCS_STATE_JSON = '{"state":{}}';

export function evictStaleVcsStreams(nowMs = Date.now(), maxIdleMs = 120_000) {
  let evicted = 0;
  for (const [k, entry] of vcsStreams.entries()) {
    if (nowMs - (entry.lastPolledAt ?? entry.createdAt ?? 0) > maxIdleMs) {
      try {
        entry.abortController?.abort?.();
      } catch {}
      vcsStreams.delete(k);
      evicted += 1;
    }
  }
  return evicted;
}

export function closeVcsStreams({ streamKey = '', cascadeId = '', cascadeIds = [], all = false } = {}) {
  const key = String(streamKey || '').trim();
  const targetIds = new Set(
    [cascadeId, ...(Array.isArray(cascadeIds) ? cascadeIds : [])]
      .map((id) => String(id || '').trim())
      .filter(Boolean)
  );
  let closedCount = 0;
  for (const [k, entry] of vcsStreams.entries()) {
    const match =
      Boolean(all) ||
      (key && k === key) ||
      (targetIds.size > 0 && entry.conversationId && targetIds.has(entry.conversationId));
    if (match) {
      entry.closed = true;
      try {
        entry.abortController?.abort?.();
      } catch {}
      entry.onChunk?.();
      entry.onChunk = null;
      vcsStreams.delete(k);
      closedCount += 1;
    }
  }
  return { ok: true, closedCount };
}

function pushFallbackEmptyState(entry) {
  if (entry.seq === 0) {
    entry.seq = 1;
    entry.chunks.push({ seq: 1, rawJson: EMPTY_VCS_STATE_JSON });
  }
}

export function pollVcsStream({
  streamKey = '',
  body = {},
  conversationId = '',
  afterSeq = 0,
  action = '',
  fetchFn = globalThis.fetch,
} = {}) {
  const now = Date.now();
  evictStaleVcsStreams(now);
  const key = String(streamKey || '').trim();
  if (!key) return { streamKey: '', chunks: [], seq: 0, closed: true, errorCode: 2 };
  if (action === 'close') {
    closeVcsStreams({ streamKey: key });
    return { streamKey: key, chunks: [], seq: 0, closed: true, errorCode: 0 };
  }
  const minSeq = Math.max(0, Number(afterSeq) || 0);
  const reqPayload = body && typeof body === 'object' ? body : {};
  const canReconnect = Boolean(reqPayload.workspaceUri || reqPayload.conversationId);
  let entry = vcsStreams.get(key);
  if (!entry) {
    if (minSeq > 0 && !canReconnect) {
      return { streamKey: key, chunks: [], seq: minSeq, closed: true, errorCode: 0 };
    }
    entry = {
      key,
      conversationId: String(conversationId || reqPayload.conversationId || '').trim(),
      seq: minSeq,
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
    vcsStreams.set(key, entry);
  } else {
    entry.lastPolledAt = now;
  }

  const { lsAddress: lsAddr, csrfToken: csrf } = getLsConfig();
  if (!entry.connecting && !entry.connected && !entry.closed) {
    if (!lsAddr || !csrf || typeof fetchFn !== 'function') {
      pushFallbackEmptyState(entry);
      entry.closed = true;
    } else {
      entry.connecting = true;
      const ac = new AbortController();
      entry.abortController = ac;
      (async () => {
        let reader = null;
        try {
          const res = await fetchFn(
            `http://${lsAddr}/exa.language_server_pb.LanguageServerService/WatchVersionControlState`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/connect+json',
                'Connect-Protocol-Version': '1',
                'x-codeium-csrf-token': csrf,
              },
              body: encodeConnectFrameBuf(reqPayload),
              signal: ac.signal,
            }
          );
          entry.connecting = false;
          if (!res?.ok || !res.body) {
            invalidateStateReads();
            if (entry.seq === 0) {
              pushFallbackEmptyState(entry);
            } else {
              entry.errorCode = 2;
            }
            entry.closed = true;
            return;
          }
          entry.connected = true;
          reader = res.body.getReader();
          const acc = createConnectFrameAccumulator({ maxFrameBytes: Infinity, rawOnly: true });
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            for (const frame of acc.push(value)) {
              if (frame.flags === 0 && frame.raw?.length) {
                entry.seq += 1;
                entry.chunks.push({ seq: entry.seq, rawJson: frame.raw.toString('utf8') });
                while (entry.chunks.length > 32) {
                  entry.chunks.shift();
                }
                entry.onChunk?.();
                entry.onChunk = null;
              } else if ((frame.flags & 2) === 2) {
                const errCode = String(frame.data?.error?.code || '');
                const errMsg = String(frame.data?.error?.message || '');
                if (errCode === 'unimplemented' || /unimplemented/i.test(errMsg)) {
                  entry.errorCode = 12;
                } else if (frame.data?.error) {
                  if (entry.seq === 0) {
                    pushFallbackEmptyState(entry);
                  } else {
                    entry.errorCode = 2;
                  }
                }
                entry.closed = true;
              }
            }
            if (entry.closed) break;
          }
          entry.closed = true;
        } catch {
          if (!ac.signal.aborted) {
            invalidateStateReads();
            if (entry.seq === 0) {
              pushFallbackEmptyState(entry);
            } else {
              entry.errorCode = 2;
            }
          }
          entry.closed = true;
        } finally {
          try {
            reader?.releaseLock();
          } catch {}
          entry.connecting = false;
          entry.connected = false;
          entry.onChunk?.();
          entry.onChunk = null;
        }
      })();
    }
  }

  while (minSeq > 0 && entry.chunks.length > 0 && entry.chunks[0].seq <= minSeq) {
    entry.chunks.shift();
  }
  const chunks = entry.chunks
    .filter((c) => c.seq > minSeq)
    .map((c) => ({ seq: c.seq, rawJson: c.rawJson }));
  if (entry.closed) {
    vcsStreams.delete(key);
  }
  return {
    streamKey: key,
    seq: entry.seq,
    closed: entry.closed,
    errorCode: entry.errorCode,
    chunks,
  };
}

export async function awaitVcsPoll(data = {}, { fetchFn = globalThis.fetch } = {}) {
  const first = pollVcsStream({ ...data, fetchFn });
  if (first.chunks.length > 0 || first.closed || Number(data?.afterSeq) > 0) {
    return first;
  }
  const entry = vcsStreams.get(first.streamKey);
  if (entry && (entry.connecting || entry.connected)) {
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 200);
      entry.onChunk = () => {
        clearTimeout(t);
        resolve();
      };
    });
    return pollVcsStream({ ...data, fetchFn });
  }
  return first;
}
