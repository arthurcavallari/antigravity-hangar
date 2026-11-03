/** @fileoverview Thin routing entrypoint for Antigravity Hangar (<= 80 lines). */
import { SidecarApp, Response } from 'sidecar_sdk';
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createShellClientHandler, createAgyCssHandler, createAssetHandler, createShellCssHandler } from 'antigravity-sidecar-kit/server';
import { registerUiRoutes } from 'antigravity-sidecar-kit';
import { exitWithLanguageServer } from 'antigravity-sidecar-kit/lifecycle';
import { registerStateSyncRoutes } from 'antigravity-sidecar-kit/state-sync';
import { UI_SCRIPTS } from './lib/constants.mjs';
import { fetchHangarState, manageChildSidecar } from './lib/state-orchestrator.mjs';
import { updateSidecarRule, updateHangarLayout } from './lib/config-store.mjs';
import { hangarRpc } from './lib/ls-rpc.mjs';
import { inspectSidecarDirectory, installRemoteSidecar, linkLocalSidecar, selfUpdateHangar, uninstallSidecar } from './lib/package-installer.mjs';
import { installRemotePlugin, pluginRequest, previewPluginPort, uninstallPlugin } from './lib/plugin-installer.mjs';
import { inspectInstalledPluginHealth, isAuthorizedSidecarRequest } from './lib/plugin-diagnostics.mjs';
import { fetchRegistry } from './lib/registry-catalog.mjs';
import { registerTerminalRoutes } from './lib/terminal-manager.mjs';

const UI_DIR = join(realpathSync(dirname(fileURLToPath(import.meta.url))), 'ui');
const serveAsset = (rel, type) => createAssetHandler(UI_DIR, rel, type, { ResponseClass: Response });
const app = new SidecarApp();

app.page('/', serveAsset('index.html', 'text/html; charset=utf-8'));
app.page('/index.html', serveAsset('index.html', 'text/html; charset=utf-8'));
app.page('/compiled_tailwind.css', createAgyCssHandler({ ResponseClass: Response }));
app.page('/shell.css', createShellCssHandler({ ResponseClass: Response }));
app.page('/shell.js', createShellClientHandler({ ResponseClass: Response }));
registerUiRoutes(app, { modules: 'all', ResponseClass: Response });
app.page('/styles.css', serveAsset('styles.css', 'text/css; charset=utf-8'));
app.page('/components.css', serveAsset('components.css', 'text/css; charset=utf-8'));
for (const script of UI_SCRIPTS) {
  app.page(`/${script}`, serveAsset(script, 'text/javascript; charset=utf-8'));
}
const withMutate = (fn) => async (data) => {
  const res = await fn(data);
  stateSync.mutate({ lastMutationTs: Date.now() });
  return res;
};
app.api('/api/state', async (d) => fetchHangarState({
  clientWorkspaceUris: Array.isArray(d?.workspaceUris) ? d.workspaceUris : [], conversationId: d?.conversationId ? String(d.conversationId) : '',
}), 'POST');
app.api('/api/rules/update', withMutate((d) => updateSidecarRule(String(d?.sidecarId || ''), { scope: d?.scope, workspaces: d?.workspaces, autoHibernate: d?.autoHibernate })), 'POST');
app.api('/api/layout/update', withMutate((d) => updateHangarLayout(d || {})), 'POST');
app.api('/api/sidecar/manage', withMutate((d) => manageChildSidecar(String(d?.sidecarId || ''), String(d?.action || ''))), 'POST');
app.api('/api/store/registry', async () => fetchRegistry(), 'POST');
app.api('/api/store/inspect', async (d) => inspectSidecarDirectory(String(d?.folderPath || '')), 'POST');
app.api('/api/store/link-local', async (d) => linkLocalSidecar({
  folderPath: String(d?.folderPath || ''), sidecarId: d?.sidecarId ? String(d.sidecarId) : '', scope: d?.scope || 'project', workspaces: Array.isArray(d?.workspaces) ? d.workspaces : [],
}), 'POST');
app.api('/api/store/install', async (d) => installRemoteSidecar({
  sidecarId: d?.sidecarId ? String(d.sidecarId) : '', gitRepo: d?.gitRepo ? String(d.gitRepo) : '', tarballUrl: d?.tarballUrl ? String(d.tarballUrl) : '',
  version: d?.version ? String(d.version) : 'latest', sha256: d?.sha256 ? String(d.sha256) : '', scope: d?.scope || 'project',
  workspaces: Array.isArray(d?.workspaces) ? d.workspaces : [], acceptedTier: d?.acceptedTier ? String(d.acceptedTier) : '',
}), 'POST');
app.api('/api/store/uninstall', async (d) => uninstallSidecar({ sidecarId: String(d?.sidecarId || '') }), 'POST');
app.api('/api/store/port-preview', async (d) => previewPluginPort(pluginRequest(d)), 'POST');
app.api('/api/store/install-plugin', async (d) => installRemotePlugin(pluginRequest(d)), 'POST');
app.api('/api/store/uninstall-plugin', async (d) => uninstallPlugin({ pluginId: String(d?.pluginId || '') }), 'POST');
app.api('/api/plugins/diagnostics', async (d, c) => isAuthorizedSidecarRequest(d, c) ? inspectInstalledPluginHealth() : new Response('{"error":"Unauthorized"}', { status: 401, contentType: 'application/json' }), 'GET');
app.api('/api/store/self-update', async (d) => selfUpdateHangar({
  gitRepo: d?.gitRepo ? String(d.gitRepo) : '', tarballUrl: d?.tarballUrl ? String(d.tarballUrl) : '', version: d?.version ? String(d.version) : 'latest', sha256: d?.sha256 ? String(d.sha256) : '', deferRestart: true,
}), 'POST');
app.api('/api/sidechat/rename', async (ctx) => hangarRpc('UpdateConversationAnnotations', {
  cascadeId: String(ctx?.body?.cascadeId || ctx?.cascadeId || ''), annotations: { title: String(ctx?.body?.title || ctx?.title || '') }, mergeAnnotations: true,
}), 'POST');
registerTerminalRoutes(app, { ResponseClass: Response });
const stateSync = registerStateSyncRoutes(app, {
  sidecarId: 'hangar', initialState: () => ({ status: 'running', lastMutationTs: 0 }),
  mcpTools: [{ name: 'manage_sidecar', description: 'Enable, disable, or restart a child sidecar in Hangar.',
    inputSchema: { type: 'object', properties: { sidecarId: { type: 'string' }, action: { type: 'string' } }, required: ['sidecarId', 'action'] },
    handler: ({ sidecarId, action }) => manageChildSidecar(String(sidecarId || ''), String(action || '')) }],
});
fetchRegistry().catch(() => {});
setInterval(() => fetchRegistry().catch(() => {}), 30 * 60 * 1000).unref();
await app.run();
exitWithLanguageServer({ app });
