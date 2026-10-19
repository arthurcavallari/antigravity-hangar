/**
 * @fileoverview Host theme resolution, contrast detection, and Antigravity stylesheet proxy.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { APP_STORAGE_PATH, CONFIG_JSON_PATH } from './constants.mjs';
import { readJsonSafe } from './config-store.mjs';

let cachedStorageMtime = -1;
let cachedStorageContrast = 1;

export function readHostContrast(storagePath = APP_STORAGE_PATH) {
  try {
    if (!existsSync(storagePath)) return 1;
    const mtime = statSync(storagePath).mtimeMs;
    if (storagePath === APP_STORAGE_PATH && mtime === cachedStorageMtime) return cachedStorageContrast;
    const m = readFileSync(storagePath, 'utf8').match(/"jetski\.contrast"\s*:\s*"?([12])"?/);
    const val = m ? Number(m[1]) : 1;
    if (storagePath === APP_STORAGE_PATH) {
      cachedStorageMtime = mtime;
      cachedStorageContrast = val;
    }
    return val;
  } catch {
    return 1;
  }
}

export function resolveHostTheme(agyConfigPath = CONFIG_JSON_PATH, appStoragePath) {
  const cfg = readJsonSafe(agyConfigPath, {});
  const us = cfg?.userSettings || {};
  const mode = String(us.themeMode || 'THEME_MODE_DARK');
  const isLight = mode === 'THEME_MODE_LIGHT' || mode === '1';
  const isDark = !isLight;
  const rawContrast =
    us.contrast !== undefined
      ? us.contrast
      : appStoragePath || agyConfigPath === CONFIG_JSON_PATH
        ? readHostContrast(appStoragePath)
        : 1;
  const highContrast = rawContrast === 2 || rawContrast === '2' || rawContrast === 'CONTRAST_HIGH';
  const c = highContrast
    ? { darkPct: '10%', darkAlpha: 0.1, lightPct: '12%', lightAlpha: 0.12, mutedPct: '4%', secDark: '14%', secLight: '8%', cardDark: '6.5%' }
    : { darkPct: '5%', darkAlpha: 0.05, lightPct: '7.5%', lightAlpha: 0.075, mutedPct: '2.5%', secDark: '12%', secLight: '6%', cardDark: '5%' };
  const seeds = (isLight ? us.customThemeSeedsLight : us.customThemeSeedsDark) || {};

  const bg = seeds.background || (isDark ? '#101010' : '#F9F9F9');
  const fg = seeds.foregroundOverride || (isDark ? '#cccccc' : '#101010');
  const primary = seeds.primary || '#007acc';
  const primaryFg = seeds.primaryForegroundOverride || '#ffffff';
  const mixBase = isDark ? '#ffffff' : '#000000';
  const secPct = isDark ? c.secDark : c.secLight;
  const sidebar = `color-mix(in srgb, ${mixBase} ${c.mutedPct}, ${bg})`;
  const card = isDark
    ? `color-mix(in srgb, ${mixBase} ${c.cardDark}, ${bg})`
    : `color-mix(in srgb, ${bg} 70%, #ffffff)`;

  return {
    theme: isDark ? 'Antigravity Dark' : 'Antigravity Light',
    themeType: isDark ? 'dark' : 'light',
    contrast: highContrast ? 'high' : 'normal',
    isDark,
    cssVariables: {
      '--background': bg,
      '--foreground': fg,
      '--primary': primary,
      '--primary-foreground': primaryFg,
      '--secondary': `color-mix(in srgb, ${mixBase} ${secPct}, ${bg})`,
      '--secondary-foreground': `color-mix(in srgb, ${fg} 75%, ${bg})`,
      '--muted': `color-mix(in srgb, ${mixBase} ${c.mutedPct}, ${bg})`,
      '--muted-foreground': `color-mix(in srgb, ${fg} 50%, ${bg})`,
      '--placeholder': `color-mix(in srgb, ${fg} 30%, ${bg})`,
      '--sidebar': sidebar,
      '--sidebar-secondary': `color-mix(in srgb, ${mixBase} ${secPct}, ${sidebar})`,
      '--sidebar-muted': `color-mix(in srgb, ${mixBase} ${c.mutedPct}, ${sidebar})`,
      '--content': bg,
      '--card': card,
      '--card-border': `color-mix(in srgb, ${fg} ${isDark ? c.darkPct : c.lightPct}, ${card})`,
      '--border': isDark ? `rgba(255, 255, 255, ${c.darkAlpha})` : `rgba(0, 0, 0, ${c.lightAlpha})`,
      '--accent': primary,
      '--error': isDark ? '#de5555' : '#f05151',
      '--warning': isDark ? '#f3c949' : '#ac830b',
      '--success': isDark ? '#7aae66' : '#58983f',
      '--chart-blue': isDark ? '#4e9de0' : '#0066cc',
      '--chart-purple': isDark ? '#9b59b6' : '#6f42c1',
      '--chart-green': isDark ? '#388a34' : '#28a745',
      '--chart-yellow': isDark ? '#b5a642' : '#d29922',
      '--chart-orange': isDark ? '#d18616' : '#e36209',
      '--chart-red': isDark ? '#d14d41' : '#d73a49',
      '--code-foreground': seeds.codeForegroundOverride || (isDark ? '#d7ba7d' : '#a31515'),
      '--vscode-font-family':
        'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
      '--editor-font-family':
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    },
  };
}

let cachedHostCss = '';
export async function fetchHostStylesheet({
  lsAddress = process.env.ANTIGRAVITY_LS_ADDRESS || '',
  fetchFn = globalThis.fetch,
  forceRefresh = false,
} = {}) {
  if (cachedHostCss && !forceRefresh) return cachedHostCss;
  if (!lsAddress || typeof fetchFn !== 'function') return '';
  const baseUrl = lsAddress.startsWith('http') ? lsAddress : `http://${lsAddress}`;
  const candidates = ['/compiled_tailwind.css'];
  try {
    const htmlRes = await fetchFn(`${baseUrl}/`, { signal: AbortSignal.timeout(1500) });
    if (htmlRes?.ok) {
      const html = await htmlRes.text();
      const hrefs = [...html.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]+href=["']([^"']+)["']|<link[^>]+href=["']([^"']+)["'][^>]+rel=["']stylesheet["']/gi)]
        .map((m) => m[1] || m[2])
        .filter((h) => h && h.startsWith('/') && !h.includes('jetbox'));
      for (const h of hrefs.reverse()) {
        if (!candidates.includes(h)) candidates.unshift(h);
      }
    }
  } catch { /* fallback to default candidate */ }

  for (const path of candidates) {
    try {
      const res = await fetchFn(`${baseUrl}${path}`, { signal: AbortSignal.timeout(1500) });
      const ctype = String(res?.headers?.get?.('content-type') || '').toLowerCase();
      if (!res?.ok || !ctype.includes('text/css')) continue;
      const rawCss = await res.text();
      const trimmed = rawCss.trimStart();
      if (!trimmed || trimmed.startsWith('<')) continue;
      const props = [];
      const body = rawCss.replace(/@property\s+--[\w-]+\s*\{[^}]*\}/g, (m) => {
        props.push(m);
        return '';
      });
      const wrapped = `@layer agy-host {\n${body}\n}\n${props.join('\n')}`;
      if (!forceRefresh) cachedHostCss = wrapped;
      return wrapped;
    } catch { /* try next candidate */ }
  }
  return '';
}
