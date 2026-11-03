import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

function fakeClassList() {
  const set = new Set();
  return {
    has: (c) => set.has(c),
    toggle: (c, on) => (on ? set.add(c) : set.delete(c)),
    add: (c) => set.add(c),
    remove: (c) => set.delete(c),
  };
}

describe('Hangar workspace layout scoping, hidden cadence, and AgyUI integration', () => {
  it('Hangar polls at the hidden cadence while Antigravity hides its view with CSS', async () => {
    let [now, intervalTick, observer, stateCalls] = [0, null, null, 0];
    const window = {
      location: { search: '' },
      addEventListener() {},
      Hangar: {
        partitionSplitTabs: () => ({ workspaceTabs: [], topTabs: [], bottomTabs: [], topSet: new Set() }),
        apiCall: async (path) => {
          if (path === '/api/state') stateCalls++;
          return { sidecars: [], layout: {} };
        },
      },
    };
    const document = { hidden: false, documentElement: {}, getElementById: () => null, addEventListener() {} };
    const ctx = vm.createContext({
      window, document, URLSearchParams,
      sessionStorage: { getItem: () => '', setItem() {} },
      console, Date: { now: () => now }, setTimeout,
      setInterval: (fn) => {
        intervalTick ??= fn;
        return 0;
      },
      IntersectionObserver: class {
        constructor(cb) { observer = { cb }; }
        observe(target) { observer.target = target; }
      },
    });
    vm.runInContext(readFileSync(join(UI_DIR, 'app.js'), 'utf8'), ctx, { filename: 'app.js' });
    await flush();
    assert.equal(stateCalls, 1);
    assert.equal(observer.target, document.documentElement);

    observer.cb([{ isIntersecting: false }]);
    for (let i = 0; i < 19; i++) {
      now += 3000;
      intervalTick();
      await flush();
    }
    assert.equal(stateCalls, 1, 'no 3s polls while hidden');
    now += 3000;
    intervalTick();
    await flush();
    assert.equal(stateCalls, 2, 'one poll per minute keeps hibernation working');

    observer.cb([{ isIntersecting: true }]);
    await flush();
    assert.equal(stateCalls, 3);
    now += 3000;
    intervalTick();
    await flush();
    assert.equal(stateCalls, 4);
  });

  it('scopes the selected tab and workspace layout per project so selecting Extensions in project1 does not select it in project2', async () => {
    const sharedSession = new Map();
    const sessionStorage = {
      getItem: (k) => sharedSession.get(k) || '',
      setItem: (k, v) => sharedSession.set(k, String(v)),
      removeItem: (k) => sharedSession.delete(k),
    };
    let sharedLayout = {
      pinnedTopSidecarId: 'context-monitor',
      topSplitTabIds: ['context-monitor'],
      tabOrder: [],
      splitViewEnabled: false,
    };
    let currentWsPath = 'C:\\Proj\\One';
    let onWorkspaceChange = null;
    let lastTabBarProps = null;

    const window = {
      location: { search: '?conversationId=conv-proj-1' },
      addEventListener() {},
      sidecar: {
        onWorkspaceChange: (cb) => {
          onWorkspaceChange = cb;
        },
      },
      Hangar: {
        EXTENSIONS_TAB_ID: '__extensions__',
        TERMINAL_TAB_ID: '__terminal__',
        SIDECHAT_TAB_ID: '__sidechat__',
        renderTabBar: (props) => {
          lastTabBarProps = props;
        },
        apiCall: async (path, body) => {
          if (path === '/api/state') {
            return {
              activeWorkspace: { workspacePath: currentWsPath, workspaceName: currentWsPath.split('\\').pop() },
              sidecars: [{ sidecarId: 'context-monitor', displayName: 'Context Monitor', matchesWorkspace: true, isRunning: true }],
              terminals: [],
              layout: JSON.parse(JSON.stringify(sharedLayout)),
            };
          }
          if (path === '/api/layout/update') {
            const prevWsLayouts = sharedLayout.workspaceLayouts || {};
            sharedLayout = { ...sharedLayout, ...body };
            if (body.workspaceLayouts) sharedLayout.workspaceLayouts = { ...prevWsLayouts, ...body.workspaceLayouts };
            return { ok: true, layout: sharedLayout };
          }
          return {};
        },
      },
    };
    window.parent = {};
    const document = { hidden: false, getElementById: () => null, addEventListener() {}, querySelectorAll: () => [] };
    const ctx = vm.createContext({
      window, document, URLSearchParams, sessionStorage, console, Date, setTimeout,
      setInterval: () => 0,
    });
    for (const rel of ['core.js', 'components/tab-bar.js', 'components/layout-controller.js']) {
      vm.runInContext(readFileSync(join(UI_DIR, rel), 'utf8'), ctx, { filename: rel });
    }
    window.Hangar.renderTabBar = (props) => {
      lastTabBarProps = props;
    };
    vm.runInContext(readFileSync(join(UI_DIR, 'app.js'), 'utf8'), ctx, { filename: 'app.js' });
    await flush();

    assert.equal(lastTabBarProps.layout.pinnedTopSidecarId, 'context-monitor');
    await lastTabBarProps.onSelectTopSplitTab('__extensions__');
    await flush();
    assert.equal(lastTabBarProps.layout.pinnedTopSidecarId, '__extensions__');
    assert.equal(sharedLayout.workspaceLayouts['c:/proj/one'].pinnedTopSidecarId, '__extensions__');
    assert.equal(sharedSession.get('hangar.activeTabId:c:/proj/one'), '__extensions__');

    currentWsPath = 'C:\\Proj\\Two';
    onWorkspaceChange(['file:///c%3A/Proj/Two']);
    await flush();
    assert.equal(lastTabBarProps.layout.pinnedTopSidecarId, 'context-monitor');

    currentWsPath = 'C:\\Proj\\One';
    onWorkspaceChange(['file:///c%3A/Proj/One']);
    await flush();
    assert.equal(lastTabBarProps.layout.pinnedTopSidecarId, '__extensions__');
  });

  it('preserves exact SVG icons, host theme precedence, and container-scoped toasts when AgyUI is loaded', async () => {
    const { buildAgyUiJs } = await import('antigravity-sidecar-kit');
    const inlineProps = new Map();
    const docBodyChildren = [];
    const customContainerChildren = [];
    const documentElement = {
      dataset: {},
      style: {
        setProperty: (k, v) => inlineProps.set(k, v),
        removeProperty: (k) => inlineProps.delete(k),
      },
    };
    const makeEl = (tag) => ({
      tagName: tag.toUpperCase(),
      className: '',
      textContent: '',
      dataset: {},
      style: {},
      classList: fakeClassList(),
      children: [],
      appendChild(c) {
        this.children.push(c);
        return c;
      },
      remove() {},
      querySelector: () => null,
      addEventListener() {},
    });
    const document = {
      documentElement,
      head: { appendChild() {} },
      body: { style: {}, classList: fakeClassList(), appendChild: (c) => docBodyChildren.push(c) },
      getElementById: () => null,
      createElement: (tag) => makeEl(tag),
    };
    const window = { document, addEventListener() {}, innerHeight: 800, Hangar: {} };
    const ctx = vm.createContext({ window, document, URL, setTimeout: () => 0, clearTimeout: () => {} });
    vm.runInContext(buildAgyUiJs('all'), ctx, { filename: 'ui.js' });
    for (const rel of ['core.js', 'components/tab-bar.js', 'components/iframe-deck.js']) {
      vm.runInContext(readFileSync(join(UI_DIR, rel), 'utf8'), ctx, { filename: rel });
    }

    const splitVertSvg = window.Hangar.iconSvg('splitscreen_vertical_add', 15);
    const codeBlocksSvg = window.Hangar.iconSvg('code_blocks', 15);
    assert.notEqual(splitVertSvg, codeBlocksSvg);
    assert.match(splitVertSvg, /M180-160q-24\.75 0-42\.37-17\.63Q120-195\.25 120-220v-520/);
    assert.match(window.Hangar.iconSvg('play_arrow', 15), /M340-236\.16V-723\.84L723\.07-480L340-236\.16Z/);
    assert.match(window.Hangar.iconSvg('keep', 16), /M620-471\.54L691\.54-400v60H510v220L480-90/);
    assert.match(window.Hangar.iconSvg('globe', 16), /M480-80q-82 0-155-31\.5t-127\.5-86/);
    assert.match(window.Hangar.iconSvg('pause', 16), /M530-220V-740H740v520H530Zm-310,0V-740H430v520H220Z/);

    window.Hangar.applyThemePayload(
      {
        themeType: 'light',
        cssVariables: {
          '--background': '#fafafa',
          '--foreground': '#111111',
          '--agy-canvas': '#181818',
          '--agy-ink-soft': 'rgba(17, 17, 17, 0.6)',
        },
      },
      true
    );
    assert.equal(document.body.classList.has('theme-light'), true);
    assert.equal(inlineProps.get('--background'), '#fafafa');
    assert.equal(inlineProps.has('--agy-canvas'), false);
    assert.equal(inlineProps.has('--agy-ink-soft'), false);

    window.Hangar.applyThemePayload(
      {
        themeType: 'dark',
        cssVariables: { '--background': '#181818', '--foreground': '#ffffff', '--agy-canvas': '#181818' },
      },
      false
    );
    assert.equal(document.body.classList.has('theme-light'), true);
    assert.equal(inlineProps.get('--background'), '#fafafa');

    const hostContainer = {
      querySelector: () => null,
      appendChild: (c) => customContainerChildren.push(c),
    };
    window.AgyUI.showToast('Sent to Side Chat', { container: hostContainer });
    assert.equal(customContainerChildren.length, 1);
    assert.equal(docBodyChildren.length, 0);
  });
});
