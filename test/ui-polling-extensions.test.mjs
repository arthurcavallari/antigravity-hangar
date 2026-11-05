import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { buildAgyUiJs } from 'antigravity-sidecar-kit/ui';

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

describe('Hangar Extensions tab and Settings pane', () => {
  it('renders Auto-Sleep, active workspace, and workspace suggestions inside Extensions tab without top-left popover', async () => {
    const indexHtml = readFileSync(join(UI_DIR, 'index.html'), 'utf8');
    assert.equal(indexHtml.includes('workspace-pill'), false);
    assert.equal(indexHtml.includes('project-popover'), false);

    const { window, document, CustomEvent, HTMLElement, DocumentFragment, Node } = parseHTML('<!DOCTYPE html><html><body></body></html>');
    const CSS = { escape: (s) => String(s) };
    window.CSS = CSS;
    const ctx = vm.createContext({ window, document, CustomEvent, HTMLElement, DocumentFragment, Node, CSS });
    vm.runInContext(buildAgyUiJs('all'), ctx, { filename: 'ui.js' });
    for (const rel of ['core.js', 'components/marketplace-panes.js', 'components/installed-pane.js', 'components/extensions-tab.js']) {
      vm.runInContext(readFileSync(join(UI_DIR, rel), 'utf8'), ctx, { filename: rel });
    }

    const storeViewEl = document.createElement('section');
    document.body.appendChild(storeViewEl);
    const toggledHib = [];
    const savedWorkspaces = [];
    const appliedSuggestions = [];
    const sidecars = [
      {
        sidecarId: 'context-monitor', displayName: 'Context & Budget Monitor', statusBadge: 'RUNNING',
        isRunning: true, isErrored: false, scope: 'project', workspaces: ['C:/Proj/App'],
        autoHibernate: true, autoHibernateLocked: false, installedVersion: '1.3.0', source: 'local',
      },
      {
        sidecarId: 'my-plugin/pane', displayName: 'Plugin Pane', statusBadge: 'RUNNING',
        isRunning: true, isErrored: false, scope: 'project', workspaces: [],
        autoHibernate: false, autoHibernateLocked: true, installedVersion: '1.0.0', source: 'plugin:my-plugin',
      },
    ];

    window.Hangar.renderExtensionsTab({
      storeViewEl,
      sidecars,
      hangar: {
        installedVersion: '1.2.5',
        latestVersion: '1.2.5',
        updateAvailable: false,
        funding: 'https://github.com/sponsors/arthurcavallari',
      },
      registryPackages: [
        {
          id: 'context-monitor',
          name: 'Context & Quota Monitor',
          latestVersion: '1.4.0',
          capabilityTier: 'TIER_1_TELEMETRY',
          author: { name: 'Arthur Cavallari', verified: true },
          funding: 'https://github.com/sponsors/arthurcavallari',
          categories: ['telemetry'],
        },
        {
          id: 'unfunded-pkg',
          name: 'Unfunded Sidecar',
          latestVersion: '1.0.0',
          capabilityTier: 'TIER_1_TELEMETRY',
          funding: 'javascript:alert(1)',
          categories: ['devops'],
        },
      ],
      suggestions: [{ sidecarId: 'docker-ui', name: 'Docker UI', reason: 'Detected docker-compose.yml', actionType: 'install' }],
      activeWorkspace: { workspaceName: 'App', workspacePath: 'C:/Proj/App' },
      onToggleAutoHibernate: async (sc) => toggledHib.push(sc.sidecarId),
      onSaveWorkspaces: async (sc, next) => savedWorkspaces.push([sc.sidecarId, next]),
      onApplySuggestion: async (sug) => appliedSuggestions.push(sug.sidecarId),
    });

    assert.equal(storeViewEl.innerHTML.includes('&lt;svg'), false);
    assert.equal(storeViewEl.innerHTML.includes('&amp;amp;'), false);
    assert.ok(storeViewEl.querySelectorAll('svg').length >= 4);
    const headerSponsor = storeViewEl.querySelector('[data-role="sponsor-header-link"]');
    assert.ok(headerSponsor);
    assert.equal(headerSponsor.getAttribute('href'), 'https://github.com/sponsors/arthurcavallari');
    assert.equal(headerSponsor.getAttribute('target'), '_blank');
    assert.equal(storeViewEl.querySelectorAll('[data-subtab]').length, 3);
    storeViewEl.querySelector('[data-subtab="discover"]').click();
    assert.equal(storeViewEl.querySelectorAll('[data-cat]').length, 4);
    const fundedCardSponsor = storeViewEl.querySelector('.agy-card[data-pkg-id="context-monitor"] [data-role="pkg-sponsor-link"]');
    assert.equal(fundedCardSponsor.classList.contains('hidden'), false);
    assert.equal(fundedCardSponsor.getAttribute('href'), 'https://github.com/sponsors/arthurcavallari');
    assert.equal(fundedCardSponsor.title, 'Sponsor Arthur Cavallari');
    const unfundedCardSponsor = storeViewEl.querySelector('.agy-card[data-pkg-id="unfunded-pkg"] [data-role="pkg-sponsor-link"]');
    assert.equal(unfundedCardSponsor.classList.contains('hidden'), true);
    storeViewEl.querySelector('[data-subtab="installed"]').click();

    const verPill = storeViewEl.querySelector('[data-role="hangar-ver-pill"]');
    assert.equal(verPill.classList.contains('hidden'), false);
    assert.equal(verPill.textContent, 'Hangar v1.2.5');
    assert.equal(verPill.title, 'Installed Antigravity Hangar version: v1.2.5');

    const wsPill = storeViewEl.querySelector('[data-role="active-ws-pill"]');
    assert.equal(wsPill.title, 'Active Workspace: C:/Proj/App');
    assert.match(wsPill.innerHTML, /App/);

    const sugBox = storeViewEl.querySelector('[data-role="workspace-suggestions"]');
    assert.equal(sugBox.classList.contains('hidden'), false);
    const sugBtn = sugBox.children[1].children[1];
    sugBtn.click();
    assert.deepEqual(appliedSuggestions, ['docker-ui']);

    const cmCard = storeViewEl.querySelector('.agy-card[data-sidecar-id="context-monitor"]');
    assert.equal(cmCard.querySelector('[data-role="title"]').textContent, 'Context & Budget Monitor');
    const cmProcBtn = cmCard.querySelector('[data-role="proc-btn"]');
    assert.equal(cmProcBtn.classList.contains('on'), true);
    assert.equal(cmProcBtn.getAttribute('aria-checked'), 'true');
    assert.ok(cmProcBtn.querySelector('.agy-switch-thumb'));
    const cmHibBtn = cmCard.querySelector('[data-role="hibernate-btn"]');
    assert.equal(cmHibBtn.disabled, false);
    assert.equal(cmHibBtn.getAttribute('aria-pressed'), 'true');
    cmHibBtn.click();
    await flush();
    assert.deepEqual(toggledHib, ['context-monitor']);

    const cmWsBtn = cmCard.querySelector('[data-role="add-ws-btn"]');
    assert.equal(cmWsBtn.disabled, false);
    assert.equal(cmWsBtn.classList.contains('active'), true);
    cmWsBtn.click();
    await flush();
    assert.deepEqual(JSON.parse(JSON.stringify(savedWorkspaces)), [['context-monitor', []]]);

    const pluginCard = storeViewEl.querySelector('.agy-card[data-sidecar-id="my-plugin/pane"]');
    const pluginHibBtn = pluginCard.querySelector('[data-role="hibernate-btn"]');
    assert.equal(pluginHibBtn.disabled, true);
    pluginHibBtn.click();
    await flush();
    assert.deepEqual(toggledHib, ['context-monitor']);

    const settingsPatches = [];
    let currentEngine = 'jetbox';
    window.Hangar.readEngineMode = () => currentEngine;
    window.Hangar.saveEngineMode = (m) => {
      currentEngine = m;
    };
    window.Hangar.renderExtensionsTab({
      storeViewEl,
      sidecars,
      layout: { hibernateAfterIdleMinutes: 10 },
      onUpdateSettings: async (patch) => settingsPatches.push(patch),
    });

    const settingsBtn = storeViewEl.querySelector('[data-role="settings-btn"]');
    const settingsPane = storeViewEl.querySelector('[data-role="pane-settings"]');
    assert.equal(settingsBtn.getAttribute('aria-pressed'), 'false');
    assert.equal(settingsPane.classList.contains('hidden'), true);

    settingsBtn.click();
    assert.equal(settingsBtn.getAttribute('aria-pressed'), 'true');
    assert.equal(settingsPane.classList.contains('hidden'), false);
    assert.equal(storeViewEl.querySelector('[data-role="pane-installed"]').classList.contains('hidden'), true);
    const settingsSponsor = settingsPane.querySelector('[data-role="settings-sponsor-link"]');
    assert.ok(settingsSponsor);
    assert.equal(settingsSponsor.getAttribute('href'), 'https://github.com/sponsors/arthurcavallari');
    assert.equal(settingsSponsor.getAttribute('target'), '_blank');

    assert.equal(settingsPane.querySelector('[data-role="auto-update-off"]').classList.contains('active'), true);
    assert.equal(settingsPane.querySelector('[data-role="auto-update-on"]').classList.contains('active'), false);
    settingsPane.querySelector('[data-role="auto-update-on"]').click();
    await flush();
    settingsPane.querySelector('[data-role="ttl-30"]').click();
    await flush();
    settingsPane.querySelector('[data-role="ext-mode-button"]').click();
    await flush();
    settingsPane.querySelector('[data-role="term-mode-button"]').click();
    await flush();
    settingsPane.querySelector('[data-role="engine-direct"]').click();
    assert.equal(currentEngine, 'direct');

    assert.deepEqual(JSON.parse(JSON.stringify(settingsPatches)), [
      { autoUpdate: true },
      { hibernateAfterIdleMinutes: 30 },
      { extensionsDisplayMode: 'button' },
      { terminalDisplayMode: 'button' },
    ]);

    settingsBtn.click();
    assert.equal(settingsBtn.getAttribute('aria-pressed'), 'false');
    assert.equal(settingsPane.classList.contains('hidden'), true);
    assert.equal(storeViewEl.querySelector('[data-role="pane-installed"]').classList.contains('hidden'), false);
  });
});
