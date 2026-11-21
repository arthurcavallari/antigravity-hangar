/** @fileoverview Side Question cascade lifecycle (start, promote, rename, delete) and Connect StreamAgentStateUpdates polling. */
import { randomUUID } from 'node:crypto';
import {
  createConnectFrameAccumulator,
  encodeConnectFrame as encodeConnectFrameBuf,
  getLsConfig,
} from 'antigravity-sidecar-kit/rpc';
import { hangarRpc, invalidateStateReads } from './ls-rpc.mjs';
import { closeVcsStreams } from './jetbox-vcs.mjs';

const chatStreams = new Map();
const deletedSideChatIds = new Set();
const hangarOwnedIds = new Set();
const observedLiveIds = new Set();
const autoStartedIds = new Set();
const MAX_DELETED_SIDECHAT_IDS = 256;
const MAX_TRACKED_SIDECHAT_IDS = 512;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function addBoundedId(set, rawId = '', cap = MAX_TRACKED_SIDECHAT_IDS) {
  const clean = String(rawId || '').trim();
  if (!clean) return;
  set.delete(clean);
  set.add(clean);
  while (set.size > cap) {
    const oldest = set.values().next().value;
    if (oldest === undefined) break;
    set.delete(oldest);
  }
}

function markDeletedSideChatId(cid = '') {
  addBoundedId(deletedSideChatIds, cid, MAX_DELETED_SIDECHAT_IDS);
}

export function isDeletedSideChatId(cid = '') {
  return deletedSideChatIds.has(String(cid || '').trim());
}

export function markHangarSideChatId(cid = '') {
  addBoundedId(hangarOwnedIds, cid, MAX_TRACKED_SIDECHAT_IDS);
}

export function markHangarSideChatIds(ids = []) {
  if (!Array.isArray(ids)) return;
  for (const id of ids) {
    markHangarSideChatId(id);
  }
}

export function noteObservedLiveSideChatIds(ids = []) {
  if (!Array.isArray(ids)) return;
  for (const id of ids) {
    addBoundedId(observedLiveIds, id, MAX_TRACKED_SIDECHAT_IDS);
  }
}

export function evictStaleChatStreams(nowMs = Date.now(), maxIdleMs = 120_000) {
  let evicted = 0;
  for (const [k, entry] of chatStreams.entries()) {
    if (nowMs - (entry.lastPolledAt ?? entry.createdAt ?? 0) > maxIdleMs) {
      try {
        entry.abortController?.abort?.();
      } catch {}
      try {
        entry.req?.destroy?.();
      } catch {}
      chatStreams.delete(k);
      evicted += 1;
    }
  }
  return evicted;
}

async function pruneParentSideQuestionAnnotation(parentConversationId = '', cid = '', rpcFn = hangarRpc) {
  const parentId = String(parentConversationId || '').trim().replace(/^hangar:/, '');
  if (!parentId || parentId === '_new' || parentId === cid) return;
  try {
    const res = await rpcFn('GetAllCascadeTrajectories', {});
    const parentSummary = res?.trajectorySummaries?.[parentId];
    const ann = parentSummary?.annotations;
    if (!ann || typeof ann !== 'object') return;
    const rawIds = Array.isArray(ann.sideQuestionCascadeIds)
      ? ann.sideQuestionCascadeIds
      : Array.isArray(ann.side_question_cascade_ids)
        ? ann.side_question_cascade_ids
        : null;
    if (!rawIds || !rawIds.includes(cid)) return;
    const nextIds = rawIds.filter((id) => String(id || '').trim() !== cid);
    if (Array.isArray(ann.sideQuestionCascadeIds)) {
      ann.sideQuestionCascadeIds = nextIds;
    }
    if (ann.sideQuestionTitles && typeof ann.sideQuestionTitles === 'object') {
      delete ann.sideQuestionTitles[cid];
    }
    await rpcFn('UpdateConversationAnnotations', {
      cascadeIds: [parentId],
      cascadeId: parentId,
      annotations: {
        sideQuestionCascadeIds: nextIds,
      },
      mergeAnnotations: true,
    });
  } catch {}
}

export async function startTerminalSideChat({
  parentConversationId = '',
  cascadeId = '',
  hideFromAntigravity = false,
  rpcFn = hangarRpc,
} = {}) {
  const rawCid = String(cascadeId || '').trim();
  const newId = rawCid && !/^sidechat-\d+-\d+$/.test(rawCid) ? rawCid : randomUUID();
  deletedSideChatIds.delete(newId);
  autoStartedIds.delete(newId);
  markHangarSideChatId(newId);
  const parentId = String(parentConversationId || '').trim().replace(/^hangar:/, '');
  const baseReq = { cascadeId: newId, trajectoryType: 22, source: 12 };
  if (hideFromAntigravity) {
    await rpcFn('StartCascade', baseReq);
    invalidateStateReads('GetAllCascadeTrajectories', 'JetboxSubscribeToSummaries');
    return { ok: true, cascadeId: newId, parentConversationId: '', hiddenFromAntigravity: true };
  }
  if (parentId && parentId !== '_new') {
    try {
      await rpcFn('StartCascade', { ...baseReq, baseTrajectoryIdentifier: { cascadeId: parentId } });
      invalidateStateReads('GetAllCascadeTrajectories', 'JetboxSubscribeToSummaries');
      return { ok: true, cascadeId: newId, parentConversationId: parentId };
    } catch {}
  }
  await rpcFn('StartCascade', baseReq);
  invalidateStateReads('GetAllCascadeTrajectories', 'JetboxSubscribeToSummaries');
  return { ok: true, cascadeId: newId, parentConversationId: '' };
}

export async function promoteTerminalSideChat({
  cascadeId = '',
  parentConversationId = '',
  targetForkWorkspace = 1,
  rpcFn = hangarRpc,
} = {}) {
  const cid = String(cascadeId || '').trim();
  if (!cid) throw new Error('cascadeId is required');
  const forkRes = await rpcFn('ForkConversation', {
    sourceCascadeId: cid,
    forkAtStepIndex: -1,
    targetForkWorkspace: Number(targetForkWorkspace) || 1,
  });
  const newCascadeId = String(forkRes?.newCascadeId || '').trim();
  if (!newCascadeId) {
    throw new Error('Language Server returned no conversation to promote into');
  }
  const warnings = Array.isArray(forkRes?.warnings) ? [...forkRes.warnings] : [];
  markDeletedSideChatId(cid);
  hangarOwnedIds.delete(cid);
  closeTerminalSideChatStreams({ cascadeId: cid });
  const tryDelete = async () => {
    try {
      await rpcFn('DeleteCascadeTrajectory', { cascadeId: cid });
      return true;
    } catch (err) {
      return /not_found|not found/i.test(String(err?.message || ''));
    }
  };
  if (!(await tryDelete()) && !(await tryDelete())) {
    deletedSideChatIds.delete(cid);
    warnings.push('Failed to delete source Side Question trajectory');
  } else {
    await pruneParentSideQuestionAnnotation(parentConversationId, cid, rpcFn);
  }
  invalidateStateReads('GetAllCascadeTrajectories', 'JetboxSubscribeToSummaries');
  return {
    ok: true,
    cascadeId: cid,
    newCascadeId,
    newProjectId: String(forkRes?.newProjectId || ''),
    warnings,
  };
}

export async function deleteTerminalSideChat({
  cascadeId = '',
  parentConversationId = '',
  rpcFn = hangarRpc,
} = {}) {
  const cid = String(cascadeId || '').trim();
  if (!cid) throw new Error('cascadeId is required');
  markDeletedSideChatId(cid);
  hangarOwnedIds.delete(cid);
  closeTerminalSideChatStreams({ cascadeId: cid });
  try {
    await rpcFn('DeleteCascadeTrajectory', { cascadeId: cid });
  } catch (err) {
    if (!/not_found|not found/i.test(String(err?.message || ''))) {
      deletedSideChatIds.delete(cid);
      throw err;
    }
  }
  await pruneParentSideQuestionAnnotation(parentConversationId, cid, rpcFn);
  invalidateStateReads('GetAllCascadeTrajectories', 'JetboxSubscribeToSummaries');
  return { ok: true, cascadeId: cid };
}

export async function renameTerminalSideChat({
  cascadeId = '',
  parentConversationId = '',
  title = '',
  rpcFn = hangarRpc,
} = {}) {
  const cid = String(cascadeId || '').trim();
  if (!cid) throw new Error('cascadeId is required');
  const cleanTitle = String(title ?? '').replace(/\s+/g, ' ').trim();
  const parentId = String(parentConversationId || '').trim().replace(/^hangar:/, '');
  const res = await rpcFn('UpdateConversationAnnotations', {
    cascadeIds: [cid],
    cascadeId: cid,
    annotations: { title: cleanTitle },
    mergeAnnotations: true,
  });
  if (parentId && parentId !== '_new' && parentId !== cid) {
    await rpcFn('UpdateConversationAnnotations', {
      cascadeIds: [parentId],
      cascadeId: parentId,
      annotations: { sideQuestionTitles: { [cid]: cleanTitle } },
      mergeAnnotations: true,
    }).catch(() => null);
  }
  invalidateStateReads('GetAllCascadeTrajectories', 'JetboxSubscribeToSummaries');
  return res ?? { ok: true };
}

export function closeTerminalSideChatStreams({
  cascadeId = '',
  cascadeIds = [],
  subscriberId = '',
  all = false,
  markDeleted = false,
} = {}) {
  const targetIds = new Set(
    [cascadeId, ...(Array.isArray(cascadeIds) ? cascadeIds : [])]
      .map((id) => String(id || '').trim())
      .filter(Boolean)
  );
  if (markDeleted) {
    for (const id of targetIds) {
      markDeletedSideChatId(id);
      hangarOwnedIds.delete(id);
    }
  }
  const sub = String(subscriberId || '').trim();
  let closedCount = 0;
  for (const [k, entry] of chatStreams.entries()) {
    const match =
      Boolean(all) ||
      (targetIds.size > 0 && targetIds.has(entry.conversationId) && (!sub || entry.subscriberId === sub)) ||
      (!targetIds.size && Boolean(sub) && entry.subscriberId === sub);
    if (match) {
      try {
        entry.abortController?.abort?.();
      } catch {}
      try {
        entry.req?.destroy?.();
      } catch {}
      chatStreams.delete(k);
      closedCount += 1;
    }
  }
  const vcsClosed = closeVcsStreams({ cascadeId, cascadeIds, all: Boolean(all && !sub) });
  return { ok: true, closedCount: closedCount + (vcsClosed?.closedCount || 0) };
}

export function pollChatStream({
  conversationId = '',
  subscriberId = 'sidechat',
  trajectoryVerbosity = 'CLIENT_TRAJECTORY_VERBOSITY_PROD_UI',
  initialStepsPageBounds = { startIndex: -50 },
  initialGeneratorMetadatasPageBounds = { startIndex: -1 },
  initialExecutorMetadatasPageBounds = { startIndex: 0, endIndexExclusive: 0 },
  enableLatencyTelemetry,
  disableRehydration,
  afterSeq = 0,
  fetchFn = globalThis.fetch,
  rpcFn = hangarRpc,
} = {}) {
  const now = Date.now();
  evictStaleChatStreams(now);
  const cid = String(conversationId || '').trim();
  if (!cid) return { chunks: [], seq: 0, closed: false };
  const subId = String(subscriberId || 'sidechat').trim();
  const minSeq = Math.max(0, Number(afterSeq) || 0);
  const resolvedVerbosity =
    typeof trajectoryVerbosity === 'string' && trajectoryVerbosity.trim()
      ? /^\d+$/.test(trajectoryVerbosity.trim())
        ? Number(trajectoryVerbosity)
        : trajectoryVerbosity.trim()
      : Number(trajectoryVerbosity) || 'CLIENT_TRAJECTORY_VERBOSITY_PROD_UI';
  const key = `${cid}:${subId}`;
  if (isDeletedSideChatId(cid)) {
    return { conversationId: cid, subscriberId: subId, seq: minSeq, closed: true, chunks: [] };
  }
  let entry = chatStreams.get(key);
  const wasMissingWithOffset = !entry && minSeq > 0;
  if (!entry) {
    entry = {
      key,
      conversationId: cid,
      subscriberId: subId,
      seq: minSeq,
      totalBytes: 0,
      chunks: [],
      connecting: false,
      connected: false,
      closed: false,
      autoStarted: false,
      nextRetryAt: 0,
      abortController: null,
      createdAt: now,
      lastPolledAt: now,
    };
    chatStreams.set(key, entry);
  } else {
    entry.lastPolledAt = now;
  }
  const { lsAddress: lsAddr, csrfToken: csrf } = getLsConfig();
  if (
    !entry.connecting &&
    !entry.connected &&
    !entry.closed &&
    Date.now() >= entry.nextRetryAt &&
    lsAddr &&
    csrf &&
    typeof fetchFn === 'function'
  ) {
    entry.connecting = true;
    entry.nextRetryAt = Date.now() + 1200;
    const ac = new AbortController();
    entry.abortController = ac;
    (async () => {
      let reader = null;
      let autoStartRetrying = false;
      try {
        const res = await fetchFn(
          `http://${lsAddr}/exa.language_server_pb.LanguageServerService/StreamAgentStateUpdates`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/connect+json',
              'Connect-Protocol-Version': '1',
              'x-codeium-csrf-token': csrf,
            },
            body: encodeConnectFrameBuf({
              conversationId: cid,
              subscriberId: subId,
              trajectoryVerbosity: resolvedVerbosity,
              ...(initialStepsPageBounds ? { initialStepsPageBounds } : {}),
              ...(initialGeneratorMetadatasPageBounds ? { initialGeneratorMetadatasPageBounds } : {}),
              ...(initialExecutorMetadatasPageBounds ? { initialExecutorMetadatasPageBounds } : {}),
              ...(enableLatencyTelemetry !== undefined ? { enableLatencyTelemetry } : {}),
              ...(disableRehydration !== undefined ? { disableRehydration } : {}),
            }),
            signal: ac.signal,
          }
        );
        entry.connecting = false;
        if (!res.ok || !res.body) {
          invalidateStateReads();
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
              addBoundedId(observedLiveIds, cid, MAX_TRACKED_SIDECHAT_IDS);
              const bytes = frame.raw.length;
              entry.seq += 1;
              entry.chunks.push({ seq: entry.seq, raw: frame.raw, bytes });
              entry.totalBytes = (entry.totalBytes || 0) + bytes;
              const cap = (entry.chunks[0]?.seq === 1 ? entry.chunks[0].bytes : 0) + 2_097_152;
              while (entry.chunks.length > 1 && (entry.chunks.length > 240 || entry.totalBytes > cap)) {
                entry.totalBytes = Math.max(0, entry.totalBytes - (entry.chunks.shift()?.bytes || 0));
              }
              entry.onChunk?.();
              entry.onChunk = null;
            } else if ((frame.flags & 2) === 2 && frame.data?.error) {
              const isNotFound =
                frame.data.error.code === 'not_found' ||
                /not_found|not found/i.test(String(frame.data.error.message || ''));
              const canColdStart =
                isNotFound &&
                hangarOwnedIds.has(cid) &&
                entry.seq === 0 &&
                !observedLiveIds.has(cid) &&
                !autoStartedIds.has(cid) &&
                !isDeletedSideChatId(cid) &&
                UUID_RE.test(cid);
              if (canColdStart) {
                addBoundedId(autoStartedIds, cid, MAX_TRACKED_SIDECHAT_IDS);
                entry.autoStarted = true;
                autoStartRetrying = true;
                entry.nextRetryAt = 0;
                await rpcFn('StartCascade', { cascadeId: cid, trajectoryType: 22, source: 12 }).catch(() => {});
              } else {
                entry.closed = true;
              }
            }
          }
        }
        if (!autoStartRetrying) entry.closed = true;
      } catch {
        if (!ac.signal.aborted) {
          invalidateStateReads();
          entry.closed = true;
        }
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
  if (wasMissingWithOffset) {
    return { conversationId: cid, subscriberId: subId, seq: minSeq, closed: true, chunks: [] };
  }
  while (minSeq > 0 && entry.chunks.length > 0 && entry.chunks[0].seq <= minSeq) {
    entry.totalBytes = Math.max(0, (entry.totalBytes || 0) - (entry.chunks.shift()?.bytes || 0));
  }
  if (minSeq > 0 && entry.seq > minSeq && (!entry.chunks.length || entry.chunks[0].seq > minSeq + 1)) {
    try {
      entry.abortController?.abort?.();
    } catch {}
    chatStreams.delete(key);
    return { conversationId: cid, subscriberId: subId, seq: minSeq, closed: true, chunks: [] };
  }
  const outChunks = entry.chunks
    .filter((c) => c.seq > minSeq)
    .map((c) => {
      const rawJson = (c.rawJson ??= c.raw.toString('utf8'));
      const out = { seq: c.seq, rawJson };
      Object.defineProperty(out, 'frameData', {
        enumerable: false,
        configurable: true,
        get: () => (c._parsed ??= JSON.parse(rawJson)),
      });
      return out;
    });
  if (entry.closed && outChunks.length === 0) chatStreams.delete(key);
  return { conversationId: cid, subscriberId: subId, seq: entry.seq, closed: entry.closed, chunks: outChunks };
}

export async function awaitChatPoll(data = {}, { fetchFn = globalThis.fetch, rpcFn = hangarRpc } = {}) {
  const opts = { ...data, fetchFn, rpcFn };
  const first = pollChatStream(opts);
  const entry =
    !first.chunks.length && !first.closed && !(Number(data?.afterSeq) > 0)
      ? chatStreams.get(`${first.conversationId}:${first.subscriberId}`)
      : null;
  if (entry && (entry.connecting || entry.connected)) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 180);
      entry.onChunk = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    return pollChatStream(opts);
  }
  return first;
}
