import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeWorkspacePath,
  extractWorkspaceName,
  matchesWorkspaceRule,
  resolveActiveWorkspace,
} from '../lib/workspace-resolver.mjs';
import { fetchHangarState } from '../lib/state-orchestrator.mjs';

describe('workspace normalization and rule matching', () => {
  it('normalizes percent-encoded Windows file:// URIs and backslashes', () => {
    assert.equal(normalizeWorkspacePath('file:///c%3A/Projects/App/'), 'c:/Projects/App');
    assert.equal(normalizeWorkspacePath('file:///C:/Users/dev/Repo'), 'c:/Users/dev/Repo');
    assert.equal(normalizeWorkspacePath('C:\\Projects\\services\\'), 'c:/Projects/services');
    assert.equal(extractWorkspaceName('c:/Projects/services'), 'services');
  });

  it('matches exact workspace paths, subdirectories, and wildcard globs', () => {
    assert.equal(matchesWorkspaceRule('c:/Projects/App', ['*']), true);
    assert.equal(matchesWorkspaceRule('c:/Projects/App', ['C:\\Projects\\App']), true);
    assert.equal(matchesWorkspaceRule('c:/Projects/App/packages/api', ['c:/Projects/App']), true);
    assert.equal(
      matchesWorkspaceRule('c:/Users/dev/workspaces/backend-api', ['*backend*', '*service*']),
      true
    );
    assert.equal(
      matchesWorkspaceRule('c:/Users/dev/workspaces/frontend-ui', ['c:/Projects/App']),
      false
    );
  });

  it('resolves active workspace from GetAllCascadeTrajectories sorted by lastUserViewTime and forwards dynamic conversationId into child iframeUrl', async () => {
    const trajectoriesResponse = {
      trajectorySummaries: {
        'conv-old': {
          annotations: { lastUserViewTime: '2026-10-17T05:00:00Z' },
          workspaces: [{ workspaceFolderAbsoluteUri: 'file:///c:/OldProject' }],
        },
        'conv-latest': {
          annotations: { lastUserViewTime: '2026-10-17T07:00:00Z' },
          workspaces: [{ workspaceFolderAbsoluteUri: 'file:///c%3A/Projects/ActiveApp' }],
        },
      },
    };

    const resolved = resolveActiveWorkspace({
      clientWorkspaceUris: ['file:///c:/Fallback'],
      trajectoriesResponse,
      requestedConversationId: 'conv-old',
    });
    assert.equal(resolved.workspacePath, 'c:/Projects/ActiveApp');
    assert.equal(resolved.workspaceName, 'ActiveApp');
    assert.equal(resolved.conversationId, 'conv-latest');

    const hangarState = await fetchHangarState({
      conversationId: 'conv-old',
      rpcFn: async (method) =>
        method === 'GetSidecars'
          ? {
              sidecars: [
                {
                  sidecarId: 'context-monitor',
                  status: 'SIDECAR_STATUS_RUNNING',
                  webPort: 51234,
                  config: { hasWebUi: true },
                },
              ],
            }
          : trajectoriesResponse,
    });
    assert.equal(hangarState.activeWorkspace.conversationId, 'conv-latest');
    assert.equal(hangarState.sidecars[0].iframeUrl, 'http://127.0.0.1:51234/?conversationId=conv-latest');
  });
});
