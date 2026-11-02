/**
 * @fileoverview Thin routing entrypoint for Antigravity Hangar (<= 80 lines).
 */
import { SidecarApp, Response } from 'sidecar_sdk';
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createShellClientHandler, createAgyCssHandler, createAssetHandler, createShellCssHandler } from 'antigravity-sidecar-kit/server';
import { registerUiRoutes } from 'antigravity-sidecar-kit';
import { exitWithLanguageServer } from 'antigravity-sidecar-kit/lifecycle';
import { registerStateSyncRoutes } from 'antigravity-sidecar-kit/state-sync';
import { fetchHangarState, manageChildSidecar } from './lib/state-orchestrator.mjs';
import { updateSidecarRule, updateHangarLayout } from './lib/config-store.mjs';
import { inspectSidecarDirectory, installRemoteSidecar, linkLocalSidecar, selfUpdateHangar, uninstallSidecar } from './lib/package-installer.mjs';
import { installRemotePlugin, pluginRequest, previewPluginPort, uninstallPlugin } from './lib/plugin-installer.mjs';
import { fetchRegistry } from './lib/registry-catalog.mjs';
import { registerTerminalRoutes } from './lib/terminal-manager.mjs';

const __dirname = realpathSync(dirname(fileURLToPath(import.meta.url)));
const UI_DIR = join(__dirname, 'ui');
const serveAsset = (relPath, contentType) => createAssetHandler(UI_DIR, relPath, contentType, { ResponseClass: Response });
const app = new SidecarApp();

app.page('/', serveAsset('index.html', 'text/html; charset=utf-8')); app.page('/index.html', serveAsset('index.html', 'text/html; charset=utf-8'));
app.page('/compiled_tailwind.css', createAgyCssHandler({ ResponseClass: Response }));
app.page('/shell.css', createShellCssHandler({ ResponseClass: Response }));
app.page('/shell.js', createShellClientHandler({ ResponseClass: Response }));
registerUiRoutes(app, { modules: 'all', ResponseClass: Response });
app.page('/styles.css', serveAsset('styles.css', 'text/css; charset=utf-8')); app.page('/components.css', serveAsset('components.css', 'text/css; charset=utf-8'));
const SCRIPTS = ['core.js', 'app.js', 'components/tab-bar.js', 'components/marketplace-panes.js',
  'components/plugin-panes.js', 'components/extensions-tab.js', 'components/iframe-deck.js',
  'components/terminal-emulator.js', 'components/terminal-quote.js', 'components/terminal-groups.js', 'components/terminal-tab.js'];
for (const script of SCRIPTS) app.page(`/${script}`, serveAsset(script, 'text/javascript; charset=utf-8'));

app.api('/api/state', async (data) => fetchHangarState({
  clientWorkspaceUris: Array.isArray(data?.workspaceUris) ? data.workspaceUris : [],
  conversationId: data?.conversationId ? String(data.conversationId) : '',
}), 'POST');
app.api('/api/rules/update', async (data) => {
  const res = await updateSidecarRule(String(data?.sidecarId || ''), { scope: data?.scope, workspaces: data?.workspaces, autoHibernate: data?.autoHibernate });
  stateSync.mutate({ lastMutationTs: Date.now() }); return res;
}, 'POST');
app.api('/api/layout/update', async (data) => {
  const res = await updateHangarLayout(data || {}); stateSync.mutate({ lastMutationTs: Date.now() }); return res;
}, 'POST');
app.api('/api/sidecar/manage', async (data) => {
  const res = await manageChildSidecar(String(data?.sidecarId || ''), String(data?.action || ''));
  stateSync.mutate({ lastMutationTs: Date.now() }); return res;
}, 'POST');
app.api('/api/store/registry', async () => fetchRegistry(), 'POST');
app.api('/api/store/inspect', async (data) => inspectSidecarDirectory(String(data?.folderPath || '')), 'POST');
app.api('/api/store/link-local', async (data) => linkLocalSidecar({
  folderPath: String(data?.folderPath || ''), sidecarId: data?.sidecarId ? String(data.sidecarId) : '',
  scope: data?.scope || 'project', workspaces: Array.isArray(data?.workspaces) ? data.workspaces : [],
}), 'POST');
app.api('/api/store/install', async (data) => installRemoteSidecar({
  sidecarId: data?.sidecarId ? String(data.sidecarId) : '', gitRepo: data?.gitRepo ? String(data.gitRepo) : '',
  tarballUrl: data?.tarballUrl ? String(data.tarballUrl) : '', version: data?.version ? String(data.version) : 'latest',
  sha256: data?.sha256 ? String(data.sha256) : '', scope: data?.scope || 'project',
  workspaces: Array.isArray(data?.workspaces) ? data.workspaces : [], acceptedTier: data?.acceptedTier ? String(data.acceptedTier) : '',
}), 'POST');
app.api('/api/store/uninstall', async (data) => uninstallSidecar({ sidecarId: String(data?.sidecarId || '') }), 'POST');
app.api('/api/store/port-preview', async (data) => previewPluginPort(pluginRequest(data)), 'POST');
app.api('/api/store/install-plugin', async (data) => installRemotePlugin(pluginRequest(data)), 'POST');
app.api('/api/store/uninstall-plugin', async (data) => uninstallPlugin({ pluginId: String(data?.pluginId || '') }), 'POST');
app.api('/api/store/self-update', async (data) => selfUpdateHangar({
  gitRepo: data?.gitRepo ? String(data.gitRepo) : '', tarballUrl: data?.tarballUrl ? String(data.tarballUrl) : '',
  version: data?.version ? String(data.version) : 'latest', sha256: data?.sha256 ? String(data.sha256) : '', deferRestart: true,
}), 'POST');
registerTerminalRoutes(app, { ResponseClass: Response });
const stateSync = registerStateSyncRoutes(app, {
  sidecarId: 'hangar', initialState: () => ({ status: 'running', lastMutationTs: 0 }),
  mcpTools: [{ name: 'manage_sidecar', description: 'Enable, disable, or restart a child sidecar in Hangar.',
    inputSchema: { type: 'object', properties: { sidecarId: { type: 'string' }, action: { type: 'string' } }, required: ['sidecarId', 'action'] },
    handler: ({ sidecarId, action }) => manageChildSidecar(String(sidecarId || ''), String(action || '')) }],
});
fetchRegistry().catch(() => {});
setInterval(() => { fetchRegistry().catch(() => {}); }, 30 * 60 * 1000).unref();
await app.run();
exitWithLanguageServer({ app });
