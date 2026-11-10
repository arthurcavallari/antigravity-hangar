// Hangar's terminals carry the workspace as hangar+file:///… so Antigravity's side panel doesn't adopt them
// as native tabs (it lists a workspace's file: URI terminals as tabs), while the shell still starts there.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { registerJetboxProxyRoutes } from '../lib/jetbox-proxy.mjs';
import { createWorkspaceTerminal, listWorkspaceTerminals } from '../lib/terminal-manager.mjs';
import { fromHangarTerminalUri, toHangarTerminalUris } from '../lib/terminal-uris.mjs';

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
});
