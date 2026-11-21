/**
 * @fileoverview The workspace URIs on Hangar's terminals.
 *
 * CreateTerminal starts the shell in its workspace_uri's folder; no other field sets it. But a terminal
 * whose workspaceUri is the workspace's file: URI also joins the workspace's terminal list, and
 * Antigravity's side panel turns every group in that list into a native tab (split or not). So Hangar
 * sends the same URI under a scheme of its own: the Language Server still starts the shell in its
 * folder and keeps the URI as sent, and only file: URIs match the panel's workspace query (seen live
 * in 2.30.0). The projectId carries the file: URI behind the hangar: prefix, as in 51a276d.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HANGAR_DATA_DIR } from 'antigravity-sidecar-kit/config';
import { normalizeWorkspacePath } from 'antigravity-sidecar-kit/workspace';

export const HANGAR_URI_SCHEME = 'hangar+file:';
export const HANGAR_PROJECT_PREFIX = 'hangar:';
export const HANGAR_CONVERSATION_PREFIX = 'hangar:';

const DEFAULT_HANGAR_TERMINALS_PATH = join(HANGAR_DATA_DIR, 'hangar-terminals.json');
const hangarCreatedTerminalIds = new Map();
const terminalHiddenSchemeById = new Map();
const MAX_TRACKED_HANGAR_TERMINALS = 512;
let hydratedDefaultPath = false;

export function loadPersistedHangarTerminalIds(storePath = DEFAULT_HANGAR_TERMINALS_PATH) {
  hangarCreatedTerminalIds.clear();
  if (storePath === DEFAULT_HANGAR_TERMINALS_PATH) {
    hydratedDefaultPath = true;
  }
  if (!storePath || !existsSync(storePath)) return;
  try {
    const parsed = JSON.parse(readFileSync(storePath, 'utf8'));
    const entries = parsed?.terminals && typeof parsed.terminals === 'object' ? Object.entries(parsed.terminals) : [];
    for (const [tid, ts] of entries) {
      const clean = String(tid || '').trim();
      if (clean) {
        hangarCreatedTerminalIds.set(clean, Number(ts) || 0);
      }
    }
  } catch {}
}

function ensureDefaultTerminalIdsLoaded() {
  if (!hydratedDefaultPath) {
    loadPersistedHangarTerminalIds(DEFAULT_HANGAR_TERMINALS_PATH);
  }
}

function persistHangarTerminalIds(storePath = DEFAULT_HANGAR_TERMINALS_PATH) {
  if (!storePath) return;
  try {
    mkdirSync(dirname(storePath), { recursive: true });
    const terminals = Object.fromEntries(hangarCreatedTerminalIds.entries());
    writeFileSync(storePath, `${JSON.stringify({ terminals }, null, 2)}\n`, 'utf8');
  } catch {}
}

export function markHangarTerminalId(terminalId = '', nowMs = Date.now(), storePath = DEFAULT_HANGAR_TERMINALS_PATH) {
  if (storePath === DEFAULT_HANGAR_TERMINALS_PATH) {
    ensureDefaultTerminalIdsLoaded();
  }
  const tid = String(terminalId || '').trim();
  if (!tid) return;
  hangarCreatedTerminalIds.delete(tid);
  hangarCreatedTerminalIds.set(tid, nowMs);
  while (hangarCreatedTerminalIds.size > MAX_TRACKED_HANGAR_TERMINALS) {
    const oldest = hangarCreatedTerminalIds.keys().next().value;
    if (oldest === undefined) break;
    hangarCreatedTerminalIds.delete(oldest);
  }
  persistHangarTerminalIds(storePath);
}

export function forgetHangarTerminalId(terminalId = '', storePath = DEFAULT_HANGAR_TERMINALS_PATH) {
  if (storePath === DEFAULT_HANGAR_TERMINALS_PATH) {
    ensureDefaultTerminalIdsLoaded();
  }
  const tid = String(terminalId || '').trim();
  if (tid) terminalHiddenSchemeById.delete(tid);
  if (tid && hangarCreatedTerminalIds.delete(tid)) {
    persistHangarTerminalIds(storePath);
  }
}

export function recordTerminalHiddenScheme(terminalId = '', isHidden = true) {
  const tid = String(terminalId || '').trim();
  if (!tid) return;
  terminalHiddenSchemeById.delete(tid);
  terminalHiddenSchemeById.set(tid, Boolean(isHidden));
  while (terminalHiddenSchemeById.size > MAX_TRACKED_HANGAR_TERMINALS) {
    const oldest = terminalHiddenSchemeById.keys().next().value;
    if (oldest === undefined) break;
    terminalHiddenSchemeById.delete(oldest);
  }
}

export function getTerminalHiddenScheme(terminalId = '') {
  const tid = String(terminalId || '').trim();
  return tid && terminalHiddenSchemeById.has(tid) ? terminalHiddenSchemeById.get(tid) : undefined;
}

export function pruneHangarTerminalIds(liveIds, nowMs = Date.now(), graceMs = 5000, storePath = DEFAULT_HANGAR_TERMINALS_PATH) {
  if (!(liveIds instanceof Set)) return;
  if (storePath === DEFAULT_HANGAR_TERMINALS_PATH) {
    ensureDefaultTerminalIdsLoaded();
  }
  let changed = false;
  for (const [tid, createdAt] of hangarCreatedTerminalIds.entries()) {
    if (!liveIds.has(tid) && nowMs - createdAt > graceMs) {
      hangarCreatedTerminalIds.delete(tid);
      terminalHiddenSchemeById.delete(tid);
      changed = true;
    }
  }
  if (changed) {
    persistHangarTerminalIds(storePath);
  }
}

export function isHangarOwnedTerminal(t) {
  if (!t || typeof t !== 'object') return false;
  ensureDefaultTerminalIdsLoaded();
  const tid = String(t.terminalId || '').trim();
  const cid = String(t.conversationId || '').trim();
  const ws = String(t.workspaceUri || '').trim();
  const pid = String(t.projectId || '').trim();
  return (
    cid.startsWith(HANGAR_CONVERSATION_PREFIX) ||
    ws.toLowerCase().startsWith(HANGAR_URI_SCHEME) ||
    pid.startsWith(HANGAR_PROJECT_PREFIX) ||
    Boolean(tid && hangarCreatedTerminalIds.has(tid))
  );
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

/** The CreateTerminal fields for a workspace's file: URI: { workspaceUri, projectId }, or {} without one. */
export function toHangarTerminalUris(fileUri = '') {
  const uri = String(fileUri || '').trim();
  if (!/^file:\/\//i.test(uri)) return {};
  return {
    workspaceUri: `${HANGAR_URI_SCHEME}${uri.slice('file:'.length)}`,
    projectId: `${HANGAR_PROJECT_PREFIX}${uri}`,
  };
}

/**
 * A CreateTerminal body from the embedded terminal UI, with its workspace file: URI (in either field, any
 * encoding) moved to the Hangar forms. Bodies without one keep mirroring workspaceUri and projectId.
 */
export function withHangarWorkspaceUris(body = {}) {
  const out = { ...body };
  const fileUri = [out.workspaceUri, out.projectId].map(fromHangarTerminalUri).find((u) => /^file:\/\//i.test(u));
  if (fileUri) {
    Object.assign(out, toHangarTerminalUris(toWorkspaceFileUri(fileUri)));
  } else if (out.workspaceUri && !out.projectId) {
    out.projectId = out.workspaceUri;
  } else if (out.projectId && !out.workspaceUri) {
    out.workspaceUri = out.projectId;
  }
  return out;
}

/** Back to the file: URI from either Hangar form; anything else is returned as is. */
export function fromHangarTerminalUri(value = '') {
  let raw = String(value || '').trim();
  if (raw.startsWith(HANGAR_PROJECT_PREFIX) && /^hangar:file:\/\//i.test(raw)) {
    raw = raw.slice(HANGAR_PROJECT_PREFIX.length);
  }
  return raw.toLowerCase().startsWith(HANGAR_URI_SCHEME)
    ? `file:${raw.slice(HANGAR_URI_SCHEME.length)}`
    : raw;
}

/**
 * Normalizes a CreateTerminal body when Hangar terminals are shared with Antigravity (hideHangarTerminals: false).
 * Restores hangar+file: / hangar:file: URIs back to file: workspaceUri and strips hangar: / _new conversationIds.
 */
export function withSharedWorkspaceUris(body = {}) {
  const out = { ...body };
  const fileUri = [out.workspaceUri, out.projectId].map(fromHangarTerminalUri).find((u) => /^file:\/\//i.test(u));
  if (fileUri) {
    out.workspaceUri = toWorkspaceFileUri(fileUri);
    if (String(out.projectId || '').startsWith(HANGAR_PROJECT_PREFIX) || /^file:\/\//i.test(String(out.projectId || ''))) {
      delete out.projectId;
    }
  } else if (String(out.projectId || '').startsWith(HANGAR_PROJECT_PREFIX)) {
    delete out.projectId;
  }
  const rawCid = String(out.conversationId || '').trim();
  const cleanCid = rawCid.startsWith(HANGAR_CONVERSATION_PREFIX)
    ? rawCid.slice(HANGAR_CONVERSATION_PREFIX.length)
    : rawCid;
  if (!cleanCid || cleanCid === '_new') {
    delete out.conversationId;
  } else {
    out.conversationId = cleanCid;
    if (!fileUri && !out.workspaceUri && !out.projectId) {
      out.projectId = 'outside-of-project';
    }
  }
  return out;
}
