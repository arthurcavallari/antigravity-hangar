/**
 * @fileoverview Workspace URI normalization, active workspace resolution, and glob matching.
 */

export function normalizeWorkspacePath(uriOrPath = '') {
  if (!uriOrPath || typeof uriOrPath !== 'string') return '';
  let clean = uriOrPath.trim();
  try {
    clean = decodeURIComponent(clean);
  } catch {
    // Keep original string if percent-decoding fails
  }
  clean = clean
    .replace(/^file:\/\/\/?/i, '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');

  // Normalize Windows drive letter casing (e.g. C:/Projects -> c:/Projects)
  if (/^[A-Za-z]:/.test(clean)) {
    clean = clean[0].toLowerCase() + clean.slice(1);
  }
  return clean;
}

export function extractWorkspaceName(normalizedPath = '') {
  if (!normalizedPath) return 'No Workspace';
  const parts = normalizedPath.split('/').filter(Boolean);
  return parts[parts.length - 1] || normalizedPath;
}

function globToRegExp(pattern = '') {
  const normalizedPattern = normalizeWorkspacePath(pattern).toLowerCase();
  if (!normalizedPattern || normalizedPattern === '*') {
    return /^.*$/;
  }
  const escaped = normalizedPattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

export function matchesWorkspaceRule(activeWorkspacePath = '', patterns = []) {
  const list = Array.isArray(patterns) ? patterns : [];
  if (list.length === 0) return false;
  if (list.some((p) => String(p).trim() === '*')) return true;

  const activeNorm = normalizeWorkspacePath(activeWorkspacePath).toLowerCase();
  if (!activeNorm) return false;

  for (const rawPattern of list) {
    const trimmed = String(rawPattern || '').trim();
    if (!trimmed) continue;
    if (trimmed === '*') return true;

    const normPat = normalizeWorkspacePath(trimmed).toLowerCase();
    // Exact path or parent directory match (e.g., rule 'c:/projects/app' matches 'c:/projects/app/web')
    if (activeNorm === normPat || activeNorm.startsWith(`${normPat}/`)) {
      return true;
    }
    if (trimmed.includes('*') && globToRegExp(trimmed).test(activeNorm)) {
      return true;
    }
  }
  return false;
}

export function extractTrajectoryWorkspace(trajectorySummary = {}) {
  const wsList =
    trajectorySummary?.workspaces ||
    trajectorySummary?.trajectoryMetadata?.workspaces ||
    [];
  for (const ws of wsList) {
    const uri = ws?.workspaceFolderAbsoluteUri || ws?.gitRootAbsoluteUri;
    if (uri) return normalizeWorkspacePath(uri);
  }
  const metaUris = trajectorySummary?.trajectoryMetadata?.workspaceUris || [];
  if (metaUris.length > 0 && metaUris[0]) {
    return normalizeWorkspacePath(metaUris[0]);
  }
  return '';
}

export function resolveActiveWorkspace({
  clientWorkspaceUris = [],
  trajectoriesResponse = {},
  requestedConversationId = '',
} = {}) {
  const summaries = trajectoriesResponse?.trajectorySummaries || {};
  const entries = Object.entries(summaries);

  const parseMs = (iso) => {
    const ms = iso ? Date.parse(iso) : 0;
    return Number.isFinite(ms) ? ms : 0;
  };

  // 1. Sort root trajectories by Date.parse(lastUserViewTime) -> lastUserInputTime -> lastModifiedTime
  const candidates = entries
    .filter(([id, s]) => {
      const rootId = s.trajectoryMetadata?.rootConversationId;
      return Boolean(s.annotations?.lastUserViewTime) || !rootId || rootId === id;
    })
    .map(([id, s]) => {
      const wsPath = extractTrajectoryWorkspace(s);
      const viewMs = parseMs(s.annotations?.lastUserViewTime);
      const inputMs = parseMs(s.lastUserInputTime);
      const modMs = parseMs(s.lastModifiedTime || s.createdTime);
      return {
        id,
        wsPath,
        viewMs,
        inputMs,
        modMs,
      };
    })
    .filter((c) => Boolean(c.wsPath))
    .sort((a, b) => {
      const pa = a.viewMs || a.modMs;
      const pb = b.viewMs || b.modMs;
      if (pa !== pb) return pb - pa;
      if (a.inputMs !== b.inputMs) return b.inputMs - a.inputMs;
      if (a.modMs !== b.modMs) return b.modMs - a.modMs;
      return a.id.localeCompare(b.id);
    });

  // 2. When host pushes clientWorkspaceUris via window.sidecar.onWorkspaceChange, prefer
  // the most recently viewed trajectory inside that active workspace
  const clientPaths = (Array.isArray(clientWorkspaceUris) ? clientWorkspaceUris : [])
    .map(normalizeWorkspacePath)
    .filter(Boolean);

  if (clientPaths.length > 0) {
    const clientMatch = candidates.find((c) => {
      const wsLower = c.wsPath.toLowerCase();
      return clientPaths.some((cp) => {
        const cpLower = cp.toLowerCase();
        return wsLower === cpLower || wsLower.startsWith(`${cpLower}/`) || cpLower.startsWith(`${wsLower}/`);
      });
    });
    if (clientMatch) {
      return {
        workspacePath: clientMatch.wsPath,
        workspaceName: extractWorkspaceName(clientMatch.wsPath),
        source: 'host_push',
        conversationId: clientMatch.id,
      };
    }
  }

  // 3. Prefer the most recently viewed trajectory across chat tabs when view timestamps exist
  if (candidates.length > 0 && (candidates[0].viewMs > 0 || candidates[0].inputMs > 0)) {
    const top = candidates[0];
    return {
      workspacePath: top.wsPath,
      workspaceName: extractWorkspaceName(top.wsPath),
      source: 'trajectory',
      conversationId: top.id,
    };
  }

  // 4. Fallback to boot requestedConversationId if no trajectory has view/input timestamps
  if (requestedConversationId && summaries[requestedConversationId]) {
    const directWs = extractTrajectoryWorkspace(summaries[requestedConversationId]);
    if (directWs) {
      return {
        workspacePath: directWs,
        workspaceName: extractWorkspaceName(directWs),
        source: 'conversation',
        conversationId: requestedConversationId,
      };
    }
  }

  if (candidates.length > 0) {
    const top = candidates[0];
    return {
      workspacePath: top.wsPath,
      workspaceName: extractWorkspaceName(top.wsPath),
      source: 'trajectory',
      conversationId: top.id,
    };
  }

  if (clientPaths.length > 0) {
    return {
      workspacePath: clientPaths[0],
      workspaceName: extractWorkspaceName(clientPaths[0]),
      source: 'host_push',
      conversationId: requestedConversationId || '',
    };
  }

  return {
    workspacePath: '',
    workspaceName: 'Global',
    source: 'none',
    conversationId: requestedConversationId || '',
  };
}
