import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createShellClientHandler, createShellCssHandler } from 'antigravity-sidecar-kit/server';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('Hangar launch.mjs, AGY shell contrast engine, StateSync routes, and Fix with Agent UI', () => {
  it('sidecar.json uses launch.mjs and server.mjs stays within the 130-line ceiling with AGY + StateSync routes', () => {
    const sidecarJson = JSON.parse(readFileSync(join(ROOT, 'sidecar.json'), 'utf8'));
    assert.deepEqual(sidecarJson.args, ['launch.mjs']);
    assert.equal(existsSync(join(ROOT, 'launch.mjs')), true);

    const serverSrc = readFileSync(join(ROOT, 'server.mjs'), 'utf8');
    const serverLines = serverSrc.split(/\r?\n/).filter((_, i, a) => i < a.length - 1 || a[i] !== '').length;
    assert.ok(serverLines <= 130, `server.mjs must be <= 130 lines (got ${serverLines})`);
    assert.match(serverSrc, /app\.page\('\/shell\.css'/);
    assert.match(serverSrc, /app\.page\('\/shell\.js'/);
    assert.match(serverSrc, /registerStateSyncRoutes\(app/);
    assert.match(serverSrc, /name:\s*'manage_sidecar'/);
  });

  it('ui/styles.css uses --agy-ink-soft (88% contrast) and @media (forced-colors: active) fallbacks', () => {
    const css = readFileSync(join(ROOT, 'ui', 'styles.css'), 'utf8');
    assert.match(css, /--hub-muted:\s*var\(--agy-ink-soft,\s*color-mix\(in srgb,\s*var\(--hub-fg\)\s*88%/);
    assert.match(css, /@media\s*\(forced-colors:\s*active\)/);

    const shellCss = createShellCssHandler()().body;
    assert.match(shellCss, /--agy-ink-soft:\s*color-mix\(in srgb,\s*var\(--agy-ink\)\s*88%,\s*var\(--agy-canvas\)\)/);

    const compCss = readFileSync(join(ROOT, 'ui', 'components.css'), 'utf8');
    assert.match(compCss, /\.term-quote-kbd\s*\{\s*opacity:\s*0\.55;/);
    assert.match(compCss, /\.term-mini-kbd\s*\{\s*opacity:\s*0\.6;/);
    assert.doesNotMatch(compCss, /\.term-(?:quote|mini)-kbd\s*\{[^}]*--hub-muted/);
    assert.match(compCss, /:is\(\.term-shell > \.agy-toast,\s*\.term-quote-toast\)\s*\{[^}]*top:\s*auto;\s*bottom:\s*12px;/s);
    assert.match(compCss, /:is\(\.term-shell > \.agy-toast,\s*\.term-quote-toast\)\.error\s*\{[^}]*--agy-bad/s);

    const quoteJs = readFileSync(join(ROOT, 'ui', 'components', 'terminal-quote.js'), 'utf8');
    assert.match(quoteJs, /class="term-quote-kbd" aria-hidden="true"/);
    assert.match(quoteJs, /class="term-mini-kbd" aria-hidden="true"/);
    assert.match(quoteJs, /setAttribute\?\.\('aria-keyshortcuts'/);
    assert.doesNotMatch(quoteJs, /term-quote-kbd[^"]*opacity-50/);
    assert.match(quoteJs, /mini\.setAttribute\?\.\('role',\s*'dialog'\)/);
    assert.match(quoteJs, /mini\.setAttribute\?\.\('aria-label',\s*'Ask about terminal output'\)/);
    assert.match(quoteJs, /closeBtn\.setAttribute\?\.\('aria-label',\s*'Cancel \(Esc\)'\)/);
    assert.match(quoteJs, /input\.setAttribute\?\.\('aria-label',\s*'Ask about terminal output'\)/);
    assert.match(quoteJs, /sideChatPickBtn\.setAttribute\?\.\('aria-label',\s*'Choose Side Chat thread'\)/);
    assert.match(quoteJs, /mini\._prevFocus\?\.focus\?\.\(\)/);
    assert.match(quoteJs, /toast\.setAttribute\?\.\('role',\s*isErr\s*\?\s*'alert'\s*:\s*'status'\)/);
    assert.match(quoteJs, /toast\.setAttribute\?\.\('aria-live',\s*isErr\s*\?\s*'assertive'\s*:\s*'polite'\)/);
    assert.match(quoteJs, /askBtn\.setAttribute\?\.\('aria-keyshortcuts',\s*isMac\s*\?\s*'Shift\+Meta\+L'\s*:\s*'Alt\+Shift\+L'\)/);

    const storeJs = readFileSync(join(ROOT, 'ui', 'components', 'sidechat-store.js'), 'utf8');
    assert.match(storeJs, /showTerminalQuoteToast\(hostObj\._toastRoot\s*\|\|\s*root,\s*err\?\.message\s*\|\|\s*'Failed to send to Agent',\s*true\)/);

    const emuJs = readFileSync(join(ROOT, 'ui', 'components', 'terminal-emulator.js'), 'utf8');
    assert.match(emuJs, /screen\.setAttribute\?\.\('role',\s*'log'\)/);
    assert.match(emuJs, /screen\.setAttribute\?\.\('aria-label',\s*'Terminal output'\)/);
    assert.match(emuJs, /onQuoteShortcut\?\.\(selText,\s*Boolean\(e\.shiftKey\)\)/);

    const bootJs = readFileSync(join(ROOT, 'ui', 'jetbox', 'jetbox-bootstrap.js'), 'utf8');
    assert.match(bootJs, /triggerJetboxQuote\(ctx,\s*Boolean\(e\.shiftKey\)\)/);

    const termTabJs = readFileSync(join(ROOT, 'ui', 'components', 'terminal-tab.js'), 'utf8');
    assert.match(termTabJs, /data-action="split"[\s\S]*?aria-label="Split Terminal"[\s\S]*?aria-pressed="false"/);
    assert.match(termTabJs, /popoutBtn\?\.setAttribute\?\.\('aria-pressed',\s*String\(isPopped\)\)/);
    assert.match(termTabJs, /splitBtn\?\.setAttribute\?\.\('aria-pressed',\s*String\(isSplit\)\)/);

    const termPaneJs = readFileSync(join(ROOT, 'ui', 'components', 'terminal-pane.js'), 'utf8');
    assert.match(termPaneJs, /data-role="pane-close"\s+aria-label="Close Split Pane"/);
  });

  it('AGY_CLIENT_JS computes relative luminance, caches theme in sessionStorage, and notifies agent on errored sidecars', async () => {
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

    const clientJs = createShellClientHandler()().body;
    vm.runInNewContext(clientJs, sandbox);

    assert.equal(typeof sandbox.AgyShell.applyAgyThemeFromPayload, 'function');
    const isDark = sandbox.AgyShell.applyAgyThemeFromPayload({
      themeType: 'dark',
      cssVariables: { '--background': '#101114', '--foreground': '#e6e8ec' },
    });
    assert.equal(isDark, true);
    assert.equal(docEl.dataset.theme, 'dark');
    assert.equal(attrs.get('data-follow-host'), true);
    assert.ok(storage.get('agy.theme.v1')?.includes('#101114'));

    const isDarkForLight = sandbox.AgyShell.applyAgyThemeFromPayload({
      themeType: 'light',
      cssVariables: { '--background': '#fbfbfa', '--foreground': '#1f2124' },
    });
    assert.equal(isDarkForLight, false);
    assert.equal(docEl.dataset.theme, 'light');

    await sandbox.AgyShell.notifyAgent('Sidecar error diagnostic', 'conv-42', 'Sidecar Error: demo');
    assert.equal(postedCalls.length, 1);
    assert.equal(postedCalls[0].url, '/api/notify');
    assert.equal(postedCalls[0].body.conversationId, 'conv-42');

    sandbox.sidecar = { conversationId: 'conv-from-sdk', fetch: sandbox.fetch };
    await sandbox.AgyShell.notifyAgent('Fallback conv diagnostic', '', 'Sidecar Error: fallback');
    assert.equal(postedCalls.length, 2);
    assert.equal(postedCalls[1].body.conversationId, 'conv-from-sdk');

    const extSrc =
      readFileSync(join(ROOT, 'ui', 'components', 'extensions-tab.js'), 'utf8') +
      readFileSync(join(ROOT, 'ui', 'components', 'installed-pane.js'), 'utf8');
    assert.match(extSrc, /data-role="fix-agent-btn"/);
    assert.match(extSrc, /ns\.notifyAgent\?\.\(msg,\s*convId/);
  });

  it('enforces readable multi-line CSS and JS formatting across Hangar UI modules', () => {
    for (const cssRel of ['ui/styles.css', 'ui/components.css']) {
      const css = readFileSync(join(ROOT, cssRel), 'utf8');
      const packedCss = css.split(/\r?\n/).filter((l) => (l.match(/;/g) || []).length >= 3);
      assert.deepEqual(packedCss, [], `${cssRel} contains packed multi-property single-line rules`);
    }

    for (const rel of [
      'ui/app.js',
      'ui/core.js',
      'ui/components/tab-bar.js',
      'ui/components/iframe-deck.js',
      'ui/components/layout-controller.js',
      'ui/components/extensions-tab.js',
      'ui/components/installed-pane.js',
      'ui/components/marketplace-panes.js',
      'ui/components/plugin-panes.js',
      'ui/components/terminal-tab.js',
      'ui/components/terminal-pane.js',
      'ui/components/terminal-drag.js',
      'ui/components/terminal-groups.js',
      'ui/components/terminal-quote.js',
      'ui/components/terminal-emulator.js',
      'ui/components/sidechat-pane.js',
      'ui/components/sidechat-store.js',
      'ui/components/sidechat-strip.js',
    ]) {
      const src = readFileSync(join(ROOT, rel), 'utf8');
      const commaDecls = src
        .split(/\r?\n/)
        .filter((l) => /^\s*(let|const)\s+[A-Za-z0-9_$]+\s*=\s*[^,;(]+,\s*[A-Za-z0-9_$]+\s*=/.test(l));
      assert.deepEqual(commaDecls, [], `${rel} contains comma-chained variable declarations`);
      const multiStmt = src
        .split(/\r?\n/)
        .filter((l) => !l.includes('for (') && (l.match(/;/g) || []).length >= 3);
      assert.deepEqual(multiStmt, [], `${rel} contains packed multi-statement lines`);
    }
  });
});
