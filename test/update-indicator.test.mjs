// The update count behind the Extensions tab's blue dot and the top-bar button's dot: Hangar, sidecars and
// plugins Hangar installed, each counted once; and the button's dot and spoken label.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function loadTabBar() {
  const window = { Hangar: {} };
  const ctx = vm.createContext({ window });
  vm.runInContext(readFileSync(new URL('../ui/components/tab-bar.js', import.meta.url), 'utf8'), ctx, { filename: 'tab-bar.js' });
  return window.Hangar;
}

function fakeButton() {
  const classes = new Set();
  const attrs = {};
  return {
    title: '',
    classList: {
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
      contains: (c) => classes.has(c),
    },
    setAttribute: (k, v) => { attrs[k] = String(v); },
    getAttribute: (k) => attrs[k] ?? null,
  };
}

describe('update indicator', () => {
  const ns = loadTabBar();

  it('counts Hangar, sidecars and plugins with updates, each once', () => {
    const count = ns.countUpdates({
      hangar: { updateAvailable: true },
      sidecars: [
        { sidecarId: 'context-monitor', updateAvailable: true },
        { sidecarId: 'from-registry' },
        { sidecarId: 'current' },
      ],
      registryPackages: [
        { id: 'from-registry', updateAvailable: true },
        { id: 'agy-plugin-porter', kind: 'plugin', updateAvailable: true },
        { id: 'anthropic-code-review', kind: 'plugin', updateAvailable: false },
        { id: 'not-installed-sidecar', updateAvailable: true },
      ],
      plugins: [
        { pluginId: 'agy-plugin-porter', updateError: { version: '0.3.1', message: 'folder in use' } },
        { pluginId: 'tob-sharp-edges', updateError: { version: '1.1.4', message: 'port failed' } },
        { pluginId: 'anthropic-code-review', updateError: null },
      ],
    });
    // Hangar 1, sidecars 2 (context-monitor, from-registry), plugins 2 (porter once, tob-sharp-edges's failure)
    assert.equal(count, 5);
    assert.equal(ns.countUpdates({}), 0);
    assert.equal(ns.countUpdates({ registryPackages: [{ id: 'p', kind: 'plugin', updateAvailable: true }] }), 1, 'a plugin update alone counts');
  });

  it('marks the top-bar button with a dot and says the count, then clears both', () => {
    const btn = fakeButton();
    ns.syncUpdateIndicator(btn, 2);
    assert.equal(btn.classList.contains('has-update'), true);
    assert.equal(btn.title, 'Extensions (2 updates available)');
    assert.equal(btn.getAttribute('aria-label'), 'Extensions (2 updates available)');
    ns.syncUpdateIndicator(btn, 1);
    assert.equal(btn.getAttribute('aria-label'), 'Extensions (1 update available)');
    ns.syncUpdateIndicator(btn, 0);
    assert.equal(btn.classList.contains('has-update'), false);
    assert.equal(btn.getAttribute('aria-label'), 'Extensions');
    assert.doesNotThrow(() => ns.syncUpdateIndicator(null, 3));
  });

  it('draws the dot only on a top-bar button that has updates', () => {
    const css = readFileSync(new URL('../ui/styles.css', import.meta.url), 'utf8');
    assert.match(css, /\.chrome-actions \.agy-icon-btn\.has-update::after\s*\{[^}]*border-radius:\s*9999px;[^}]*background:\s*var\(--status-info-dot/s);
    assert.match(readFileSync(new URL('../ui/app.js', import.meta.url), 'utf8'), /plugins: state\.plugins,\s*hangar: state\.hangar,\s*bottomActiveTabId/, 'the tab bar gets the installed plugins');
  });
});
