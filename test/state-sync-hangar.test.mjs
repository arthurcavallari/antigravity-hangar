import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createShellClientHandler, createShellCssHandler } from 'antigravity-sidecar-kit/server';
import { fetchHangarState } from '../lib/state-orchestrator.mjs';

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
    assert.match(quoteJs, /sideChatPickBtn\.setAttribute\?\.\('aria-label',\s*'Choose Side Question thread'\)/);
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

  it('enforces readable multi-line CSS and JS formatting and complete requiredFiles manifests across Hangar modules', async () => {
    for (const cssRel of [
      'ui/styles.css',
      'ui/components.css',
      'ui/jetbox/jetbox-shared.css',
      'ui/jetbox/jetbox-chat.css',
      'ui/jetbox/jetbox-terminal.css',
    ]) {
      const css = readFileSync(join(ROOT, cssRel), 'utf8');
      const packedCss = css.split(/\r?\n/).filter((l) => (l.match(/;/g) || []).length >= 3);
      assert.deepEqual(packedCss, [], `${cssRel} contains packed multi-property single-line rules`);
    }

    for (const rel of [
      'server.mjs',
      'setup.mjs',
      'lib/jetbox-sidechat.mjs',
      'lib/jetbox-proxy.mjs',
      'lib/jetbox-rpc-policy.mjs',
      'lib/jetbox-audio.mjs',
      'lib/ls-rpc.mjs',
      'lib/terminal-uris.mjs',
      'lib/terminal-manager.mjs',
      'ui/app.js',
      'ui/core.js',
      'ui/jetbox/jetbox-bootstrap.js',
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
        .filter((l) => {
          if (l.includes('for (')) return false;
          const stripped = l.replace(/'[^']*'|"[^"]*"|`[^`]*`|\/(?![/*])(?:\\.|[^/\\\r\n])+\/[gimsuy]*/g, '""');
          return (stripped.match(/;/g) || []).length >= 2;
        });
      assert.deepEqual(multiStmt, [], `${rel} contains packed multi-statement lines`);
    }

    const { HANGAR_REQUIRED_FILES } = await import('../lib/constants.mjs');
    const setupSrc = readFileSync(join(ROOT, 'setup.mjs'), 'utf8');
    const setupArrMatch = setupSrc.match(/requiredFiles:\s*\[([\s\S]*?)\]/);
    assert.ok(setupArrMatch, 'setup.mjs must declare literal requiredFiles array');
    const setupFiles = Array.from(setupArrMatch[1].matchAll(/'([^']+)'/g), (m) => m[1]);
    assert.deepEqual([...HANGAR_REQUIRED_FILES].sort(), [...setupFiles].sort(), 'HANGAR_REQUIRED_FILES must stay in sync with setup.mjs requiredFiles');
  });

  it('SH-15: steps up UI typography tokens for 2.31.0 and syncs jetski.fontSize to --app-font-scale', async () => {
    const stylesCss = readFileSync(join(ROOT, 'ui', 'styles.css'), 'utf8');
    const compCss = readFileSync(join(ROOT, 'ui', 'components.css'), 'utf8');
    assert.match(stylesCss, /html,\s*body\s*\{[\s\S]*?font-size:\s*var\(--text-base,\s*0\.875rem\);/);
    assert.match(stylesCss, /\.empty-split-zone\s*\{[\s\S]*?font-size:\s*var\(--text-compact,\s*0\.8125rem\);/);
    assert.match(compCss, /\.manager-card-title\s*\{[\s\S]*?font-size:\s*var\(--text-base,\s*0\.875rem\);/);
    assert.match(compCss, /\.manager-card-desc\s*\{[\s\S]*?font-size:\s*var\(--text-sm,\s*0\.75rem\);/);

    const tmp = mkdtempSync(join(tmpdir(), 'hangar-sh15-'));
    try {
      const appStoragePath = join(tmp, 'app_storage.json');
      writeFileSync(appStoragePath, JSON.stringify({ 'jetski.fontSize': '16' }), 'utf8');
      const state16 = await fetchHangarState({
        configPath: join(tmp, 'hangar.json'),
        sidecarsDir: join(tmp, 'sidecars'),
        packagesDir: join(tmp, 'packages'),
        pluginsDir: join(tmp, 'plugins'),
        appStoragePath,
        rpcFn: async () => ({ sidecars: [], trajectorySummaries: {}, plugins: [], terminals: [] }),
      });
      assert.equal(state16.theme.cssVariables['--app-font-scale'], '1.142857');
      assert.equal(state16.theme.cssVariables['--font-size'], '16px');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('SH-16: aligns dark surface fallbacks with Onyx (#070708 / #131317 / #2f71e3) and 0.5px card hairline borders', () => {
    const stylesCss = readFileSync(join(ROOT, 'ui', 'styles.css'), 'utf8');
    const compCss = readFileSync(join(ROOT, 'ui', 'components.css'), 'utf8');
    const jbSharedCss = readFileSync(join(ROOT, 'ui', 'jetbox', 'jetbox-shared.css'), 'utf8');
    const jbTermCss = readFileSync(join(ROOT, 'ui', 'jetbox', 'jetbox-terminal.css'), 'utf8');
    assert.match(stylesCss, /--hub-bg:\s*var\(--agy-canvas,\s*var\(--background,\s*#070708\)\)/i);
    assert.match(stylesCss, /--hub-card:\s*var\(--agy-card,\s*var\(--card,\s*#131317\)\)/i);
    assert.match(stylesCss, /--hub-primary:\s*var\(--agy-accent,\s*var\(--primary,\s*#2f71e3\)\)/i);
    assert.match(compCss, /\.workspace-suggestions\s*\{[\s\S]*?border:\s*0\.5px solid var\(--hub-card-border\);[\s\S]*?background:\s*var\(--hub-card\);/);
    assert.match(compCss, /\.hub-shell \.agy-card:not\(\.agy-card-highlight\)\s*\{[\s\S]*?border:\s*0\.5px solid var\(--hub-card-border\);[\s\S]*?background:\s*var\(--hub-card\);/);
    assert.ok(jbSharedCss.includes('#070708'));
    assert.ok(jbTermCss.includes('#070708'));
  });

  it('SH-04: Hangar.notifyAgent and _submitQuoteToMain pass workspace fallback and create new-conversation on _new panes', async () => {
    const { StateSync } = await import('antigravity-sidecar-kit/state-sync');
    const agentApiCalls = [];
    const sync = new StateSync({
      sidecarId: 'hangar',
      initialState: () => ({ status: 'running' }),
      agentApiFn: async (args, opts) => {
        agentApiCalls.push({ args, opts });
        if (args[0] === 'start-conversation') {
          throw new Error('unknown subcommand "start-conversation"');
        }
        return { conversationId: 'conv-new-1' };
      },
    });

    const toasts = [];
    const sandbox = {
      window: null,
      document: {
        documentElement: {
          dataset: {},
          classList: { contains: () => false },
          style: { setProperty() {}, getPropertyValue: () => '' },
          toggleAttribute() {},
        },
        querySelectorAll: () => [],
      },
      location: { search: '?conversationId=_new', origin: 'http://127.0.0.1:43100' },
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      sidecar: {
        conversationId: '_new',
        getWorkspaceUris: async () => ['file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-hub'],
        fetch: async (_url, init) => {
          const out = await sync.handleNotify(JSON.parse(init.body));
          return { ok: (out.status || 200) < 400, status: out.status || 200, json: async () => out };
        },
      },
      URL,
      URLSearchParams,
    };
    sandbox.window = sandbox;
    vm.runInNewContext(createShellClientHandler()().body, sandbox);
    vm.runInNewContext(readFileSync(join(ROOT, 'ui', 'core.js'), 'utf8'), sandbox);
    vm.runInNewContext(readFileSync(join(ROOT, 'ui', 'components', 'sidechat-store.js'), 'utf8'), sandbox);
    sandbox.Hangar.formatTerminalAgentMessage = (p, note) => `${p.selectionContent}\n${note}`;
    sandbox.Hangar.showTerminalQuoteToast = (_r, text, isErr = false) => toasts.push({ text, isErr });

    const fixRes = await sandbox.Hangar.notifyAgent('Fix sidecar', '_new', 'Sidecar Error: context-monitor');
    assert.equal(fixRes.ok, true);

    const sendBtn = { disabled: false, textContent: 'Send to Main' };
    const input = { value: 'Explain trace', style: {} };
    await sandbox.Hangar._submitQuoteToMain(
      { _payload: { cleanName: 'zsh', selectionContent: 'ECONNREFUSED' }, _convId: '_new' },
      {},
      sendBtn,
      'Send to Main',
      input,
      () => {},
      () => {}
    );

    assert.equal(agentApiCalls.length, 2);
    assert.equal(agentApiCalls[0].args[0], 'new-conversation');
    assert.match(String(agentApiCalls[0].opts.workspace), /antigravity-sidecar-hub/);
    assert.equal(agentApiCalls[1].args[0], 'new-conversation');
    assert.deepEqual(toasts, [{ text: 'Sent quote from "zsh" to Main Chat', isErr: false }]);
  });

  it('closes Hangar SSE EventSource and propagates visibility to child iframes when hidden via CSS, document.hidden, or sidecar-visibility', () => {
    const createdEventSources = [];
    const observers = [];
    const winListeners = new Map();
    const docListeners = new Map();
    const deckVisibilityCalls = [];
    const addL = (m, t, fn) => {
      const s = m.get(t) || new Set();
      s.add(fn);
      m.set(t, s);
    };
    const emit = (m, t, ev) => {
      for (const fn of [...(m.get(t) || [])]) fn(ev);
    };

    class MockEventSource {
      constructor(url) {
        this.url = url;
        this.closed = false;
        createdEventSources.push(this);
      }
      addEventListener() {}
      close() {
        this.closed = true;
      }
    }

    class MockIntersectionObserver {
      constructor(cb) {
        this.cb = cb;
        observers.push(this);
      }
      observe(target) {
        this.target = target;
      }
      disconnect() {}
    }

    const parentWin = {};
    const document = {
      readyState: 'complete',
      hidden: false,
      documentElement: {
        dataset: {},
        classList: { contains: () => false },
        style: { setProperty() {}, getPropertyValue: () => '' },
        toggleAttribute() {},
      },
      getElementById: () => null,
      querySelectorAll: () => [],
      addEventListener: (t, fn) => addL(docListeners, t, fn),
      removeEventListener: (t, fn) => docListeners.get(t)?.delete(fn),
    };
    const window = {
      parent: parentWin,
      document,
      EventSource: MockEventSource,
      location: {
        href: 'http://localhost:53083/?token=tok1&conversationId=conv-1',
        search: '?token=tok1&conversationId=conv-1',
        origin: 'http://localhost:53083',
      },
      addEventListener: (t, fn) => addL(winListeners, t, fn),
      removeEventListener: (t, fn) => winListeners.get(t)?.delete(fn),
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ sidecars: [], layout: {} }) }),
    };

    const ctx = vm.createContext({
      window,
      document,
      EventSource: MockEventSource,
      IntersectionObserver: MockIntersectionObserver,
      URL,
      URLSearchParams,
      sessionStorage: { getItem: () => '', setItem() {} },
      console,
      setTimeout: (fn) => {
        fn();
        return 1;
      },
      clearTimeout() {},
      setInterval: () => 0,
    });

    vm.runInContext(createShellClientHandler()().body, ctx, { filename: 'shell.js' });
    vm.runInContext(readFileSync(join(ROOT, 'ui', 'core.js'), 'utf8'), ctx, { filename: 'core.js' });
    window.Hangar.partitionSplitTabs = () => ({ workspaceTabs: [], topTabs: [], bottomTabs: [], topSet: new Set() });
    window.Hangar.syncDeckVisibility = () => deckVisibilityCalls.push(window.Hangar.isHostHidden());
    vm.runInContext(readFileSync(join(ROOT, 'ui', 'app.js'), 'utf8'), ctx, { filename: 'app.js' });

    assert.equal(createdEventSources.length, 1);
    assert.equal(createdEventSources[0].closed, false);

    // 1. Background conversation hidden via IntersectionObserver -> closes Hangar SSE socket
    for (const o of observers) o.cb([{ isIntersecting: false }]);
    assert.equal(createdEventSources[0].closed, true);
    assert.equal(window.Hangar.isHostHidden(), true);

    for (const o of observers) o.cb([{ isIntersecting: true }]);
    assert.equal(createdEventSources.length, 2);
    assert.equal(createdEventSources[1].closed, false);
    assert.equal(window.Hangar.isHostHidden(), false);

    // 2. Host sidecar-visibility: false -> closes Hangar SSE socket AND notifies child iframe deck
    const beforeDeckCalls = deckVisibilityCalls.length;
    emit(winListeners, 'message', {
      source: parentWin,
      data: { type: 'sidecar-visibility', payload: { visible: false } },
    });
    assert.equal(createdEventSources[1].closed, true);
    assert.equal(window.Hangar.isHostHidden(), true);
    assert.equal(deckVisibilityCalls.at(-1), true);
    assert.ok(deckVisibilityCalls.length > beforeDeckCalls);

    emit(winListeners, 'message', {
      source: parentWin,
      data: { type: 'sidecar-visibility', payload: { visible: true } },
    });
    assert.equal(createdEventSources.length, 3);
    assert.equal(createdEventSources[2].closed, false);
    assert.equal(window.Hangar.isHostHidden(), false);
    assert.equal(deckVisibilityCalls.at(-1), false);
  });
});
