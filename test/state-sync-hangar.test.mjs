import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createAgysClientHandler, createShellCssHandler } from 'antigravity-sidecar-kit/server';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('Hangar launch.mjs, AGYS shell contrast engine, StateSync routes, and Fix with Agent UI', () => {
  it('sidecar.json uses launch.mjs and server.mjs stays within the 80-line ceiling with AGYS + StateSync routes', () => {
    const sidecarJson = JSON.parse(readFileSync(join(ROOT, 'sidecar.json'), 'utf8'));
    assert.deepEqual(sidecarJson.args, ['launch.mjs']);
    assert.equal(existsSync(join(ROOT, 'launch.mjs')), true);

    const serverSrc = readFileSync(join(ROOT, 'server.mjs'), 'utf8');
    const serverLines = serverSrc.split(/\r?\n/).filter((_, i, a) => i < a.length - 1 || a[i] !== '').length;
    assert.ok(serverLines <= 80, `server.mjs must be <= 80 lines (got ${serverLines})`);
    assert.match(serverSrc, /app\.page\('\/shell\.css'/);
    assert.match(serverSrc, /app\.page\('\/agys-client\.js'/);
    assert.match(serverSrc, /registerStateSyncRoutes\(app/);
    assert.match(serverSrc, /name:\s*'manage_sidecar'/);
  });

  it('ui/styles.css uses --agys-ink-soft (88% contrast) and @media (forced-colors: active) fallbacks', () => {
    const css = readFileSync(join(ROOT, 'ui', 'styles.css'), 'utf8');
    assert.match(css, /--hub-muted:\s*var\(--agys-ink-soft,\s*color-mix\(in srgb,\s*var\(--hub-fg\)\s*88%/);
    assert.match(css, /@media\s*\(forced-colors:\s*active\)/);

    const shellCss = createShellCssHandler()().body;
    assert.match(shellCss, /--agys-ink-soft:\s*color-mix\(in srgb,\s*var\(--agys-ink\)\s*88%,\s*var\(--agys-canvas\)\)/);
  });

  it('AGYS_CLIENT_JS computes relative luminance, caches theme in sessionStorage, and notifies agent on errored sidecars', async () => {
    const storage = new Map();
    const attrs = new Map();
    const styleProps = new Map();
    const postedCalls = [];

    const docEl = {
      dataset: {},
      classList: { contains: () => false },
      style: {
        setProperty: (k, v) => styleProps.set(k, v),
        getPropertyValue: (k) => styleProps.get(k) || '',
      },
      toggleAttribute: (name, force) => attrs.set(name, Boolean(force)),
    };

    const sandbox = {
      window: null,
      document: { documentElement: docEl },
      sessionStorage: {
        getItem: (k) => storage.get(k) ?? null,
        setItem: (k, v) => storage.set(k, String(v)),
      },
      fetch: async (url, init) => {
        postedCalls.push({ url, body: JSON.parse(init.body) });
        return { ok: true, json: async () => ({ ok: true }) };
      },
      URL,
      URLSearchParams,
    };
    sandbox.window = sandbox;

    const clientJs = createAgysClientHandler()().body;
    vm.runInNewContext(clientJs, sandbox);

    assert.equal(typeof sandbox.Hangar.applyAgysThemeFromPayload, 'function');
    const isDark = sandbox.Hangar.applyAgysThemeFromPayload({
      themeType: 'dark',
      cssVariables: { '--background': '#101114', '--foreground': '#e6e8ec' },
    });
    assert.equal(isDark, true);
    assert.equal(docEl.dataset.theme, 'dark');
    assert.equal(attrs.get('data-follow-host'), true);
    assert.ok(storage.get('agys.theme.v1')?.includes('#101114'));

    const isDarkForLight = sandbox.Hangar.applyAgysThemeFromPayload({
      themeType: 'light',
      cssVariables: { '--background': '#fbfbfa', '--foreground': '#1f2124' },
    });
    assert.equal(isDarkForLight, false);
    assert.equal(docEl.dataset.theme, 'light');

    await sandbox.Hangar.notifyAgent('Sidecar error diagnostic', 'conv-42', 'Sidecar Error: demo');
    assert.equal(postedCalls.length, 1);
    assert.equal(postedCalls[0].url, '/api/notify');
    assert.equal(postedCalls[0].body.conversationId, 'conv-42');

    sandbox.sidecar = { conversationId: 'conv-from-sdk', fetch: sandbox.fetch };
    await sandbox.Hangar.notifyAgent('Fallback conv diagnostic', '', 'Sidecar Error: fallback');
    assert.equal(postedCalls.length, 2);
    assert.equal(postedCalls[1].body.conversationId, 'conv-from-sdk');

    const extSrc = readFileSync(join(ROOT, 'ui', 'components', 'extensions-tab.js'), 'utf8');
    assert.match(extSrc, /data-role="fix-agent-btn"/);
    assert.match(extSrc, /ns\.notifyAgent\?\.\(msg,\s*convId/);
  });
});
