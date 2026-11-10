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

import { pathToFileURL } from 'node:url';
import { normalizeWorkspacePath } from 'antigravity-sidecar-kit/workspace';

export const HANGAR_URI_SCHEME = 'hangar+file:';
export const HANGAR_PROJECT_PREFIX = 'hangar:';

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
  return { workspaceUri: `${HANGAR_URI_SCHEME}${uri.slice('file:'.length)}`, projectId: `${HANGAR_PROJECT_PREFIX}${uri}` };
}

/**
 * A CreateTerminal body from the embedded terminal UI, with its workspace file: URI (in either field, any
 * encoding) moved to the Hangar forms. Bodies without one keep mirroring workspaceUri and projectId.
 */
export function withHangarWorkspaceUris(body = {}) {
  const out = { ...body };
  const fileUri = [out.workspaceUri, out.projectId].map(fromHangarTerminalUri).find((u) => /^file:\/\//i.test(u));
  if (fileUri) Object.assign(out, toHangarTerminalUris(toWorkspaceFileUri(fileUri)));
  else if (out.workspaceUri && !out.projectId) out.projectId = out.workspaceUri;
  else if (out.projectId && !out.workspaceUri) out.workspaceUri = out.projectId;
  return out;
}

/** Back to the file: URI from either Hangar form; anything else is returned as is. */
export function fromHangarTerminalUri(value = '') {
  let raw = String(value || '').trim();
  if (raw.startsWith(HANGAR_PROJECT_PREFIX) && /^hangar:file:\/\//i.test(raw)) raw = raw.slice(HANGAR_PROJECT_PREFIX.length);
  return raw.toLowerCase().startsWith(HANGAR_URI_SCHEME) ? `file:${raw.slice(HANGAR_URI_SCHEME.length)}` : raw;
}
