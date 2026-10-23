import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui');

function loadPluginPanes() {
  const window = {};
  const ctx = vm.createContext({ window, document: {} });
  for (const rel of ['core.js', 'components/plugin-panes.js']) {
    vm.runInContext(readFileSync(join(UI_DIR, rel), 'utf8'), ctx, { filename: rel });
  }
  return window.Hangar;
}

function fakeEl() {
  const classes = new Set(['hidden']);
  return {
    dataset: {},
    innerHTML: '',
    textContent: '',
    disabled: false,
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
  };
}

function fakeCard() {
  const els = { btn: fakeEl(), consentBar: fakeEl(), consentText: fakeEl(), errorEl: fakeEl(), resets: [] };
  els.reset = (label) => els.resets.push(label);
  return { card: {}, els };
}

const PKG = {
  id: 'review-port',
  kind: 'plugin',
  latestVersion: '1.2.0',
  port: { from: 'claude' },
  release: { gitRepo: 'https://github.com/acme/plugins', ref: 'v1.2.0', path: 'plugins/review' },
};

describe('Hangar plugin panes', () => {
  it('shows what will and won\'t port before consent, escaping everything the upstream controls', () => {
    const ns = loadPluginPanes();
    const html = ns.pluginConsentHtml({
      scannedTier: 'TIER_2_LOCAL_TOOLING',
      report: {
        ecosystems: ['claude'],
        ported: ['skill:<b>review</b>'],
        unported: [{ item: 'hook:<img src=x onerror=alert(1)>', reason: 'no "UserPromptSubmit" event' }],
        flags: [{ kind: 'pipe-to-shell', severity: 'high', file: 'hooks/<x>.sh', line: 3 }],
        warnings: [],
        tierReasons: ['hooks: PreToolUse'],
      },
    });
    assert.match(html, /Tier 2 · Local CLI/);
    assert.match(html, /1 ported • 1 not ported • 1 audit finding</);
    assert.match(html, /<details class="port-report" open>/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.equal(html.includes('<img'), false);
    assert.equal(html.includes('<b>review'), false);
    assert.match(html, /hooks\/&lt;x&gt;\.sh:3/);
    assert.match(html, /restart it after installing/);
  });

  it('labels plugins, and ports with where they came from', () => {
    const ns = loadPluginPanes();
    assert.match(ns.pluginBadgesHtml({ port: { from: 'claude' } }), /Ported from Claude Code/);
    assert.match(ns.pluginBadgesHtml({ portedFrom: ['roo', 'cursor'] }), /Ported from Roo Code \+ Cursor/);
    assert.match(ns.pluginBadgesHtml({ port: { from: 'auto' } }), /Ported from another tool/);
    const native = ns.pluginBadgesHtml({ portedFrom: [] });
    assert.match(native, />Plugin</);
    assert.equal(native.includes('Ported'), false);
  });

  it('previews, then installs with exactly the tier and findings the user saw, asking again if they changed', async () => {
    const ns = loadPluginPanes();
    const { card, els } = fakeCard();
    const calls = [];
    const responses = [
      { scannedTier: 'TIER_2_LOCAL_TOOLING', flagsDigest: 'aaaa', report: { ecosystems: ['claude'], ported: ['skill:x'] } },
      { needsConsent: true, scannedTier: 'TIER_3_AGENT_CONTROL', flagsDigest: 'bbbb', report: { ecosystems: ['claude'] } },
      { ok: true, restartRequired: true },
    ];
    const ctx = {
      onPreviewPlugin: async (payload) => (calls.push(['preview', payload]), responses.shift()),
      onInstallPlugin: async (payload) => (calls.push(['install', payload]), responses.shift()),
      onSwitchTab: (tab) => calls.push(['tab', tab]),
    };

    await ns.previewPluginInstall(card, els, ctx, PKG);
    // The payload is built in the UI's vm realm, so compare it as plain JSON
    assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), ['preview', {
      pluginId: 'review-port', gitRepo: 'https://github.com/acme/plugins', tarballUrl: '', sha256: '',
      ref: 'v1.2.0', path: 'plugins/review', port: { from: 'claude' }, version: '1.2.0',
    }]);
    assert.equal(els.consentBar.classList.contains('hidden'), false);
    assert.match(els.consentText.innerHTML, /Port report/);

    await ns.confirmPluginInstall(card, els, ctx, PKG);
    assert.equal(calls[1][1].acceptedTier, 'TIER_2_LOCAL_TOOLING');
    assert.equal(calls[1][1].acceptedFlags, 'aaaa');
    assert.match(els.consentText.innerHTML, /Tier 3/, 'a changed scan is shown again before anything installs');
    assert.equal(els.consentBar.classList.contains('hidden'), false);

    await ns.confirmPluginInstall(card, els, ctx, PKG);
    assert.equal(calls[2][1].acceptedTier, 'TIER_3_AGENT_CONTROL');
    assert.equal(calls[2][1].acceptedFlags, 'bbbb');
    assert.deepEqual(calls[3], ['tab', 'installed']);
    assert.deepEqual(els.resets, ['Install', 'Install', 'Install']);
  });

  it('shows a failed preview on the card and offers a retry', async () => {
    const ns = loadPluginPanes();
    const { card, els } = fakeCard();
    await ns.previewPluginInstall(card, els, { onPreviewPlugin: async () => { throw new Error('agy not found'); } }, PKG);
    assert.equal(els.errorEl.textContent, 'agy not found');
    assert.equal(els.errorEl.classList.contains('hidden'), false);
    assert.deepEqual(els.resets, ['Retry Install']);
    // Without a preview there's nothing the user agreed to, so Confirm does nothing
    let installed = false;
    await ns.confirmPluginInstall(card, els, { onInstallPlugin: async () => { installed = true; } }, PKG);
    assert.equal(installed, false);
  });
});
