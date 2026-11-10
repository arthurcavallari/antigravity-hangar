// Material Symbols lines are 1/16 of the icon, so below 16px they fall under a pixel and render blurry.
// Antigravity draws its UI icons at 16px; icons in Hangar's buttons and toggles must too.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const DIR = new URL('../ui/components/', import.meta.url);
const BUTTON = /class="[^"]*\b(agy-icon-btn|has-icon|agy-toggle-item)\b/;
const ICON = /iconSvg\('([a-z_]+)', *(\d+)\)/g;

describe('icon sizes', () => {
  it('draws every icon in a button or toggle at 16px or more', () => {
    const small = [];
    for (const file of readdirSync(DIR).filter((f) => f.endsWith('.js'))) {
      const lines = readFileSync(new URL(file, DIR), 'utf8').split('\n');
      lines.forEach((line, i) => {
        // The icon sits on the button's line or within the next two lines of markup
        const inButton = [i, i - 1, i - 2].some((j) => j >= 0 && BUTTON.test(lines[j]))
          || /setHtml\((selfUpBtn|hibBtn|els\.btn)/.test(line);
        if (!inButton) return;
        for (const [, name, size] of line.matchAll(ICON)) {
          if (Number(size) < 16) small.push(`${file}:${i + 1} ${name} ${size}px`);
        }
      });
    }
    assert.deepEqual(small, []);
  });
});
