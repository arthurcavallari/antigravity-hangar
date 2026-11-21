// Hangar's terminals carry the workspace as hangar+file:///… so Antigravity's side panel doesn't adopt them
// as native tabs (it lists a workspace's file: URI terminals as tabs), while the shell still starts there.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { registerJetboxProxyRoutes } from '../lib/jetbox-proxy.mjs';
import { createWorkspaceTerminal, listWorkspaceTerminals, registerTerminalRoutes } from '../lib/terminal-manager.mjs';
import {
  fromHangarTerminalUri,
  isHangarOwnedTerminal,
  loadPersistedHangarTerminalIds,
  markHangarTerminalId,
  toHangarTerminalUris,
  withSharedWorkspaceUris,
} from '../lib/terminal-uris.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WS = 'file:///c:/Users/arthu/IdeaProjects/lastwar-client';

describe('terminal workspace URIs', () => {
  it('turns a workspace file: URI into Hangar forms, and back', () => {
    assert.deepEqual(toHangarTerminalUris(WS), {
      workspaceUri: 'hangar+file:///c:/Users/arthu/IdeaProjects/lastwar-client',
      projectId: `hangar:${WS}`,
    });
    assert.deepEqual(toHangarTerminalUris('file:///Users/arthur/My%20Repo'), {
      workspaceUri: 'hangar+file:///Users/arthur/My%20Repo', projectId: 'hangar:file:///Users/arthur/My%20Repo',
    });
    assert.deepEqual(toHangarTerminalUris(''), {});
    assert.deepEqual(toHangarTerminalUris('outside-of-project'), {});
    assert.equal(fromHangarTerminalUri('hangar+file:///c:/Users/arthu/IdeaProjects/lastwar-client'), WS);
    assert.equal(fromHangarTerminalUri(`hangar:${WS}`), WS);
    for (const other of [WS, 'outside-of-project', '75a739a6-6915-4aab-a8c8-285c5439b4f0', '', 'hangar:conv-1']) {
      assert.equal(fromHangarTerminalUri(other), other);
    }
  });

  it('creates terminals with hangar+file: and never the workspace file: URI', async () => {
    const calls = [];
    const rpcFn = async (method, body) => {
      calls.push({ method, body });
      return method === 'CreateTerminal'
        ? { terminal: { terminalId: 'term-uri-1', pid: 1, title: 'pwsh', ...body } }
        : {};
    };
    const fetchFn = async () => ({ ok: false });
    const created = await createWorkspaceTerminal({ workspacePath: 'C:\\Users\\arthu\\IdeaProjects\\lastwar-client', conversationId: 'conv-1', rpcFn, fetchFn });
    const body = calls.find((c) => c.method === 'CreateTerminal').body;
    assert.deepEqual(body, {
      workspaceUri: 'hangar+file:///c:/Users/arthu/IdeaProjects/lastwar-client',
      projectId: `hangar:${WS}`,
      conversationId: 'hangar:conv-1',
    });
    assert.equal(created.workspaceUri, WS, 'Hangar itself still sees the file: URI');
    assert.equal(calls.some((c) => c.method === 'SendTerminalInput' && c.body.input), false, 'no cd is typed into the shell');

    await createWorkspaceTerminal({ workspacePath: 'c:/Users/arthu/IdeaProjects/lastwar-client', conversationId: 'conv-1', splitFromTerminalId: 'term-uri-1', rpcFn, fetchFn });
    const split = calls.filter((c) => c.method === 'CreateTerminal')[1].body;
    assert.equal(split.workspaceUri, 'hangar+file:///c:/Users/arthu/IdeaProjects/lastwar-client');
    assert.equal(split.splitFromTerminalId, 'term-uri-1');
  });

  it("lists Hangar's hangar+file: terminals under their workspace", async () => {
    const rpcFn = async () => ({
      terminals: [
        { terminalId: 't-hangar', title: 'pwsh', conversationId: 'hangar:conv-1', workspaceUri: 'hangar+file:///c:/Users/arthu/IdeaProjects/lastwar-client', projectId: `hangar:${WS}` },
        { terminalId: 't-other', title: 'pwsh', conversationId: 'hangar:conv-2', workspaceUri: 'hangar+file:///c:/other', projectId: 'hangar:file:///c:/other' },
        { terminalId: 't-native', title: 'pwsh', conversationId: 'conv-9', workspaceUri: 'file:///C:/Users/arthu/IdeaProjects/lastwar-client' },
      ],
    });
    const list = await listWorkspaceTerminals({ workspacePath: 'C:\\Users\\arthu\\IdeaProjects\\lastwar-client', rpcFn });
    assert.deepEqual(list.map((t) => t.terminalId), ['t-hangar', 't-native']);
    assert.equal(list[0].workspaceUri, WS);
    assert.equal(list[0].isExternal, false);
  });

  it("rewrites the embedded terminal UI's CreateTerminal to hangar+file:", async () => {
    const sent = [];
    const apis = new Map();
    registerJetboxProxyRoutes({ page() {}, api: (p, fn) => apis.set(p, fn) }, { rpcFn: async (method, body) => { sent.push({ method, body }); return {}; } });
    const rpc = apis.get('/api/terminal/ls-rpc');
    await rpc({ method: 'CreateTerminal', body: { workspaceUri: 'file:///c%3A/Users/arthu/IdeaProjects/lastwar-client', conversationId: 'conv-1' } });
    await rpc({ method: 'CreateTerminal', body: { projectId: 'outside-of-project', conversationId: 'conv-2' } });
    assert.deepEqual(sent[0].body, {
      workspaceUri: 'hangar+file:///c:/Users/arthu/IdeaProjects/lastwar-client', projectId: `hangar:${WS}`, conversationId: 'hangar:conv-1',
    });
    assert.deepEqual(sent[1].body, { projectId: 'outside-of-project', workspaceUri: 'outside-of-project', conversationId: 'hangar:conv-2' }, 'non-workspace ids pass through as before');
  });

  it('shares Hangar terminals with Antigravity when hideHangarTerminals is false while keeping isExternal false inside Hangar', async () => {
    const calls = [];
    const liveTerminals = [];
    let seq = 1;
    const rpcFn = async (method, body) => {
      calls.push({ method, body });
      if (method === 'CreateTerminal') {
        const created = { terminalId: `t-shared-${seq++}`, pid: 100 + seq, title: 'pwsh', ...body };
        liveTerminals.push(created);
        return { terminal: created };
      }
      if (method === 'ListTerminals') {
        return {
          terminals: [
            ...liveTerminals,
            { terminalId: 't-truly-native', pid: 999, title: 'pwsh', conversationId: 'conv-1', workspaceUri: WS },
          ],
        };
      }
      return {};
    };
    const fetchFn = async () => ({ ok: false });

    const createdWs = await createWorkspaceTerminal({
      workspacePath: 'C:\\Users\\arthu\\IdeaProjects\\lastwar-client',
      conversationId: 'conv-1',
      hideHangarTerminals: false,
      rpcFn,
      fetchFn,
    });
    assert.deepEqual(calls[0].body, {
      workspaceUri: WS,
      conversationId: 'conv-1',
    });
    assert.equal(createdWs.workspaceUri, WS);
    assert.equal(createdWs.conversationId, 'conv-1');

    // _new conversationId must not leak into shared CreateTerminal
    await createWorkspaceTerminal({
      workspacePath: 'C:\\Users\\arthu\\IdeaProjects\\lastwar-client',
      conversationId: '_new',
      hideHangarTerminals: false,
      rpcFn,
      fetchFn,
    });
    assert.deepEqual(calls[1].body, {
      workspaceUri: WS,
    });

    // Embedded Jetbox split when getHideHangarTerminals returns false also uses file: URI and marks terminal Hangar-owned
    const apis = new Map();
    registerJetboxProxyRoutes(
      { page() {}, api: (p, fn) => apis.set(p, fn) },
      { rpcFn, getHideHangarTerminals: () => false },
    );
    await apis.get('/api/terminal/ls-rpc')({
      method: 'CreateTerminal',
      body: {
        workspaceUri: 'hangar+file:///c:/Users/arthu/IdeaProjects/lastwar-client',
        projectId: `hangar:${WS}`,
        conversationId: 'hangar:conv-1',
        splitFromTerminalId: 't-shared-1',
      },
    });
    assert.deepEqual(calls[2].body, {
      workspaceUri: WS,
      conversationId: 'conv-1',
      splitFromTerminalId: 't-shared-1',
    });

    const listed = await listWorkspaceTerminals({
      workspacePath: 'C:\\Users\\arthu\\IdeaProjects\\lastwar-client',
      showExternalTerminals: true,
      rpcFn,
    });
    const byId = new Map(listed.map((t) => [t.terminalId, t]));
    assert.equal(byId.get('t-shared-1')?.isExternal, false, 'Hangar-created shared terminal stays isExternal: false');
    assert.equal(byId.get('t-shared-2')?.isExternal, false);
    assert.equal(byId.get('t-shared-3')?.isExternal, false, 'Jetbox split terminal stays isExternal: false');
    assert.equal(byId.get('t-truly-native')?.isExternal, true, 'Native Antigravity terminal stays isExternal: true');

    const hangarOnly = await listWorkspaceTerminals({
      workspacePath: 'C:\\Users\\arthu\\IdeaProjects\\lastwar-client',
      showExternalTerminals: false,
      rpcFn,
    });
    assert.deepEqual(hangarOnly.map((t) => t.terminalId), ['t-shared-1', 't-shared-2', 't-shared-3']);
  });

  it('respects getHideHangarTerminals on /api/terminal/create, retains projectless _new terminals, sets outside-of-project on shared projectless URIs, and persists Hangar terminal ownership', async () => {
    // 1. withSharedWorkspaceUris sets projectId: 'outside-of-project' when no workspace file URI exists and conversationId is present
    assert.deepEqual(
      withSharedWorkspaceUris({ conversationId: 'hangar:conv-projless-1' }),
      { projectId: 'outside-of-project', conversationId: 'conv-projless-1' },
    );

    // 2. /api/terminal/create consults options.getHideHangarTerminals directly without waiting for listWorkspaceTerminals
    const routeApis = new Map();
    const createdBodies = [];
    registerTerminalRoutes(
      { page() {}, api: (p, fn) => routeApis.set(p, fn) },
      { getHideHangarTerminals: () => false, rpcFn: async () => ({}) },
    );
    await routeApis.get('/api/terminal/create')({
      workspacePath: 'C:\\Users\\arthu\\IdeaProjects\\lastwar-client',
      conversationId: 'conv-direct',
      fetchFn: async () => ({ ok: false }),
      rpcFn: async (method, body) => {
        if (method === 'CreateTerminal') {
          createdBodies.push(body);
          return { terminal: { terminalId: 't-route-shared', pid: 400, title: 'pwsh', ...body } };
        }
        return {};
      },
    });
    assert.deepEqual(createdBodies[0], { workspaceUri: WS, conversationId: 'conv-direct' });

    // 3. Projectless _new terminals remain visible on listWorkspaceTerminals({ workspacePath: '', conversationId: '' })
    const liveProjless = [];
    const projlessRpc = async (method, body) => {
      if (method === 'CreateTerminal') {
        const t = { terminalId: `t-pl-${liveProjless.length + 1}`, pid: 500, title: 'pwsh', ...body };
        liveProjless.push(t);
        return { terminal: t };
      }
      if (method === 'ListTerminals') {
        return {
          terminals: [
            ...liveProjless,
            { terminalId: 't-foreign-ws', pid: 501, title: 'pwsh', workspaceUri: WS },
          ],
        };
      }
      return {};
    };
    await createWorkspaceTerminal({ workspacePath: '', conversationId: '', hideHangarTerminals: false, rpcFn: projlessRpc, fetchFn: async () => ({ ok: false }) });
    await createWorkspaceTerminal({ workspacePath: '', conversationId: '_new', hideHangarTerminals: true, rpcFn: projlessRpc, fetchFn: async () => ({ ok: false }) });
    const listedProjless = await listWorkspaceTerminals({ workspacePath: '', conversationId: '', rpcFn: projlessRpc });
    assert.deepEqual(listedProjless.map((t) => t.terminalId), ['t-pl-1', 't-pl-2']);

    // 4. Splitting an existing hidden terminal after toggling hideHangarTerminals to false inherits parent's hidden URI scheme
    const splitCalls = [];
    const splitRpc = async (method, body) => {
      splitCalls.push({ method, body });
      if (method === 'CreateTerminal') {
        return { terminal: { terminalId: `t-split-${splitCalls.length}`, pid: 600, title: 'pwsh', ...body } };
      }
      return {};
    };
    const hiddenParent = await createWorkspaceTerminal({
      workspacePath: 'C:\\Users\\arthu\\IdeaProjects\\lastwar-client',
      conversationId: 'conv-split-1',
      hideHangarTerminals: true,
      rpcFn: splitRpc,
      fetchFn: async () => ({ ok: false }),
    });
    await createWorkspaceTerminal({
      workspacePath: 'C:\\Users\\arthu\\IdeaProjects\\lastwar-client',
      conversationId: 'conv-split-1',
      splitFromTerminalId: hiddenParent.terminalId,
      hideHangarTerminals: false,
      rpcFn: splitRpc,
      fetchFn: async () => ({ ok: false }),
    });
    assert.deepEqual(splitCalls[1].body, {
      workspaceUri: 'hangar+file:///c:/Users/arthu/IdeaProjects/lastwar-client',
      projectId: `hangar:${WS}`,
      conversationId: 'hangar:conv-split-1',
      splitFromTerminalId: hiddenParent.terminalId,
    });

    // 5. Persisted Hangar terminal IDs survive in-memory reset (Hangar restart)
    const dir = mkdtempSync(join(tmpdir(), 'hangar-term-own-'));
    try {
      const storePath = join(dir, 'hangar-terminals.json');
      const emptyPath = join(dir, 'empty.json');
      markHangarTerminalId('t-restart-survive', Date.now(), storePath);
      loadPersistedHangarTerminalIds(emptyPath);
      assert.equal(isHangarOwnedTerminal({ terminalId: 't-restart-survive', workspaceUri: WS }), false);
      loadPersistedHangarTerminalIds(storePath);
      assert.equal(isHangarOwnedTerminal({ terminalId: 't-restart-survive', workspaceUri: WS }), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
