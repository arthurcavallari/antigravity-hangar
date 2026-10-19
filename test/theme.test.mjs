import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeJsonNoBom } from '../lib/config-store.mjs';
import { fetchHostStylesheet, resolveHostTheme } from '../lib/theme.mjs';

describe('host theme seed resolution and Antigravity stylesheet proxy', () => {
  it('resolves Antigravity light/dark theme seeds from config.json and jetski.contrast from app_storage.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hangar-theme-test-'));
    try {
      const agyCfgPath = join(dir, 'config.json');
      const appStoragePath = join(dir, 'app_storage.json');
      writeJsonNoBom(agyCfgPath, {
        userSettings: {
          themeMode: 'THEME_MODE_LIGHT',
          customThemeSeedsLight: { background: '#FAFAFA', primary: '#10b981' },
        },
      });
      writeJsonNoBom(appStoragePath, { 'jetski.contrast': '2' });
      const resolved = resolveHostTheme(agyCfgPath, appStoragePath);
      assert.equal(resolved.themeType, 'light');
      assert.equal(resolved.contrast, 'high');
      assert.equal(resolved.cssVariables['--background'], '#FAFAFA');
      assert.equal(resolved.cssVariables['--primary'], '#10b981');
      assert.equal(resolved.cssVariables['--border'], 'rgba(0, 0, 0, 0.12)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fetchHostStylesheet discovers renamed CSS links, rejects SPA HTML catch-all, and wraps in @layer agy-host', async () => {
    const mockFetch = async (url) => {
      if (url.endsWith('/')) {
        return {
          ok: true,
          headers: new Map([['content-type', 'text/html; charset=utf-8']]),
          text: async () => '<!doctype html><link rel="stylesheet" href="/assets/app-9f8a.css">',
        };
      }
      if (url.endsWith('/assets/app-9f8a.css')) {
        return {
          ok: true,
          headers: new Map([['content-type', 'text/css; charset=utf-8']]),
          text: async () => ':root{--radius-sm:0.25rem}@property --tw-translate-x { syntax: "*"; inherits: false; }',
        };
      }
      return {
        ok: true,
        headers: new Map([['content-type', 'text/html; charset=utf-8']]),
        text: async () => '<!doctype html><html>SPA fallback</html>',
      };
    };

    const css = await fetchHostStylesheet({
      lsAddress: '127.0.0.1:59125',
      fetchFn: mockFetch,
      forceRefresh: true,
    });
    assert.match(css, /^@layer agy-host \{/);
    assert.match(css, /--radius-sm:0\.25rem/);
    assert.match(css, /\}\n@property --tw-translate-x/);

    const htmlRejected = await fetchHostStylesheet({
      lsAddress: '127.0.0.1:59125',
      fetchFn: async () => ({
        ok: true,
        headers: new Map([['content-type', 'text/html; charset=utf-8']]),
        text: async () => '<!doctype html><html>SPA fallback</html>',
      }),
      forceRefresh: true,
    });
    assert.equal(htmlRejected, '');
  });
});
