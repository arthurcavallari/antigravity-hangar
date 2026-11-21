// Material Symbols lines are 1/16 of the icon, so below 16px they fall under a pixel and render blurry.
// Antigravity draws its UI icons at 16px; icons in Hangar's buttons, toggles, and top-bar tabs must too.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const UI_DIR = new URL('../ui/', import.meta.url);
const COMP_DIR = new URL('../ui/components/', import.meta.url);
const ICON_CALL = /(?:iconSvg|iconEl)\??\.\(\s*([^,]+?)\s*,\s*(\d+)|(?:iconSvg|iconEl)\(\s*([^,]+?)\s*,\s*(\d+)/g;
// Explicitly allowed micro close chips inside compact split-pane headers / workspace rule pills
const EXEMPT_MICRO_CLOSE_CHIPS = /\b(term-pane-close|ws-rule-remove)\b/;

function lineNumberAt(src, index) {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (src.charCodeAt(i) === 10) line++;
  }
  return line;
}

function collectIconViolations(fileLabel, src, regionStart, regionText) {
  if (EXEMPT_MICRO_CLOSE_CHIPS.test(regionText)) return [];
  const out = [];
  for (const m of regionText.matchAll(ICON_CALL)) {
    const rawName = (m[1] || m[3] || '').trim().replace(/\s+/g, ' ');
    const size = Number(m[2] || m[4]);
    if (size < 16) {
      const ln = lineNumberAt(src, regionStart + m.index);
      out.push(`${fileLabel}:${ln} ${rawName} ${size}px`);
    }
  }
  return out;
}

describe('icon sizes', () => {
  it('draws every icon in a standard button, toggle, or top-bar chrome tab at 16px or more', () => {
    const found = new Set();
    const sources = [
      ...readdirSync(UI_DIR)
        .filter((f) => f.endsWith('.js'))
        .map((f) => ({ label: `ui/${f}`, src: readFileSync(new URL(f, UI_DIR), 'utf8') })),
      ...readdirSync(COMP_DIR)
        .filter((f) => f.endsWith('.js'))
        .map((f) => ({ label: `ui/components/${f}`, src: readFileSync(new URL(f, COMP_DIR), 'utf8') })),
    ];

    for (const { label, src } of sources) {
      // 1. Multi-line HTML <button>...</button> and button-styled <a>...</a> blocks
      const tagBlocks = /<(?:button\b[\s\S]*?<\/button>|a\b[^>]*\b(?:agy-btn|agy-icon-btn|has-icon|agy-toggle-item)\b[\s\S]*?<\/a>)/g;
      for (const m of src.matchAll(tagBlocks)) {
        for (const v of collectIconViolations(label, src, m.index, m[0])) found.add(v);
      }

      // 2. Programmatic DOM builders: mkEl('button', ...) and createElement('button') across single or multi-line calls
      for (const m of src.matchAll(/\b(?:mkEl|createElement)\(\s*['"]button['"]/g)) {
        const snippet = src.slice(m.index, m.index + 650);
        for (const v of collectIconViolations(label, src, m.index, snippet)) found.add(v);
      }

      // 3. Imperative setHtml(...) updates targeting button variables across single or multi-line calls
      for (const m of src.matchAll(/\bsetHtml\(\s*(?:[A-Za-z0-9_$.]*Btn\b|(?:els\.)?btn\b)/g)) {
        const snippet = src.slice(m.index, m.index + 320);
        for (const v of collectIconViolations(label, src, m.index, snippet)) found.add(v);
      }

      // 4. Top-bar chrome tab iconSize in tab-bar.js
      if (label === 'ui/components/tab-bar.js') {
        for (const m of src.matchAll(/\biconSize\s*:\s*([^\n,]+)/g)) {
          for (const numMatch of m[1].matchAll(/\b(\d+)\b/g)) {
            const sz = Number(numMatch[1]);
            if (sz < 16) {
              found.add(`${label}:${lineNumberAt(src, m.index)} iconSize ${sz}px`);
            }
          }
        }
      }
    }

    assert.deepEqual([...found], []);
  });
});
