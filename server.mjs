/**
 * @fileoverview Thin routing entrypoint for Antigravity Hangar (<= 80 lines).
 */

import { SidecarApp, Response } from 'sidecar_sdk';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchHangarState, manageChildSidecar } from './lib/state-orchestrator.mjs';
import { updateSidecarRule, updateHangarLayout } from './lib/config-store.mjs';
import { fetchHostStylesheet } from './lib/theme.mjs';
import { inspectSidecarDirectory, installRemoteSidecar, linkLocalSidecar, uninstallSidecar } from './lib/package-installer.mjs';
import { fetchRegistry } from './lib/registry-catalog.mjs';

const __dirname = realpathSync(dirname(fileURLToPath(import.meta.url)));
const UI_DIR = join(__dirname, 'ui');
const UI_TOKEN = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || '';
const BOOT_TS = Date.now();

const serveAsset = (relPath, contentType) => () => {
  const raw = readFileSync(join(UI_DIR, relPath), 'utf-8');
  const body =
    relPath.endsWith('.html') && UI_TOKEN
      ? raw.replace(/(src|href)="(\/[^"?]+)"/g, `$1="$2?token=${encodeURIComponent(UI_TOKEN)}&v=${BOOT_TS}"`)
      : raw;
  return new Response(body, { contentType });
};

const serveAgyCss = async () =>
  new Response(await fetchHostStylesheet(), { contentType: 'text/css; charset=utf-8' });

const app = new SidecarApp();

// Static UI asset routes
app.page('/', serveAsset('index.html', 'text/html; charset=utf-8'));
app.page('/index.html', serveAsset('index.html', 'text/html; charset=utf-8'));
app.page('/compiled_tailwind.css', serveAgyCss);
app.page('/styles.css', serveAsset('styles.css', 'text/css; charset=utf-8'));
app.page('/components.css', serveAsset('components.css', 'text/css; charset=utf-8'));
app.page('/core.js', serveAsset('core.js', 'text/javascript; charset=utf-8'));
app.page('/app.js', serveAsset('app.js', 'text/javascript; charset=utf-8'));
app.page('/components/tab-bar.js', serveAsset('components/tab-bar.js', 'text/javascript; charset=utf-8'));
app.page('/components/project-popover.js', serveAsset('components/project-popover.js', 'text/javascript; charset=utf-8'));
app.page('/components/marketplace-panes.js', serveAsset('components/marketplace-panes.js', 'text/javascript; charset=utf-8'));
app.page('/components/extensions-tab.js', serveAsset('components/extensions-tab.js', 'text/javascript; charset=utf-8'));
app.page('/components/iframe-deck.js', serveAsset('components/iframe-deck.js', 'text/javascript; charset=utf-8'));

// Authenticated JSON API routes
app.api('/api/state', async (data) => fetchHangarState({
  clientWorkspaceUris: Array.isArray(data?.workspaceUris) ? data.workspaceUris : [],
  conversationId: data?.conversationId ? String(data.conversationId) : '',
}), 'POST');
app.api('/api/rules/update', async (data) => updateSidecarRule(String(data?.sidecarId || ''), {
  scope: data?.scope, workspaces: data?.workspaces, autoHibernate: data?.autoHibernate,
}), 'POST');
app.api('/api/layout/update', async (data) => updateHangarLayout(data || {}), 'POST');
app.api('/api/sidecar/manage', async (data) => manageChildSidecar(String(data?.sidecarId || ''), String(data?.action || '')), 'POST');
app.api('/api/store/registry', async () => fetchRegistry(), 'POST');
app.api('/api/store/inspect', async (data) => inspectSidecarDirectory(String(data?.folderPath || '')), 'POST');
app.api('/api/store/link-local', async (data) => linkLocalSidecar({
  folderPath: String(data?.folderPath || ''),
  sidecarId: data?.sidecarId ? String(data.sidecarId) : '',
  scope: data?.scope || 'project',
  workspaces: Array.isArray(data?.workspaces) ? data.workspaces : [],
}), 'POST');
app.api('/api/store/install', async (data) => installRemoteSidecar({
  sidecarId: data?.sidecarId ? String(data.sidecarId) : '',
  gitRepo: data?.gitRepo ? String(data.gitRepo) : '',
  tarballUrl: data?.tarballUrl ? String(data.tarballUrl) : '',
  version: data?.version ? String(data.version) : 'latest',
  sha256: data?.sha256 ? String(data.sha256) : '',
  scope: data?.scope || 'project',
  workspaces: Array.isArray(data?.workspaces) ? data.workspaces : [],
}), 'POST');
app.api('/api/store/uninstall', async (data) => uninstallSidecar({ sidecarId: String(data?.sidecarId || '') }), 'POST');

await app.run();
