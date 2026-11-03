/**
 * @fileoverview Runtime health inspector for installed Antigravity plugins.
 * Scans MCP server definitions and lifecycle hooks for missing binaries on PATH
 * and unconfigured ${VAR} environment variable placeholders without exposing secret values.
 */

import { existsSync, readdirSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { readJsonSafe } from 'antigravity-sidecar-kit/config';
import { getCurrentRequestContext, isLoopbackOrigin, verifySidecarToken } from 'antigravity-sidecar-kit/state-sync';
import { GLOBAL_PLUGINS_DIR } from './constants.mjs';

export function isAuthorizedSidecarRequest(reqOrData = {}, rawCtx = {}) {
  const ctx = (rawCtx && (rawCtx.req || rawCtx.headers || rawCtx.query || rawCtx.origin !== undefined)) ? rawCtx : (getCurrentRequestContext?.() || rawCtx || {});
  const req = ctx?.req || (ctx?.headers ? ctx : reqOrData?.req || (reqOrData?.headers || reqOrData?.url ? reqOrData : null));
  const headers = req?.headers || ctx?.headers || reqOrData?.headers || null;
  const origin = headers?.origin ?? ctx?.origin ?? reqOrData?.origin;
  if (origin !== undefined && !isLoopbackOrigin(origin)) return false;
  const expectedToken = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || '';
  if (!expectedToken) return true;
  const headerTok = headers
    ? Array.isArray(headers['x-sidecar-token'])
      ? headers['x-sidecar-token'][0]
      : headers['x-sidecar-token']
    : '';
  let urlTok =
    ctx?.query?.token ??
    ctx?.query?.get?.('token') ??
    reqOrData?.query?.token ??
    reqOrData?.query?.get?.('token') ??
    reqOrData?.token ??
    '';
  if (!urlTok && req?.url) {
    try {
      urlTok = new URL(req.url, 'http://127.0.0.1').searchParams.get('token') || '';
    } catch {}
  }
  return verifySidecarToken(String(headerTok || urlTok || ''), expectedToken);
}

const BUILTIN_PATH_VARS = new Set([
  'PLUGIN_ROOT',
  'CLAUDE_PLUGIN_ROOT',
  'extensionPath',
  'workspaceFolder',
  'GEMINI_PROJECT_DIR',
  'CLAUDE_PROJECT_DIR',
]);
const PLACEHOLDER_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;
const BARE_MCP_META_KEYS = new Set(['$schema', 'version', 'description']);

function isPlainObject(val) {
  return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

export function checkCommandExists(command, env = process.env, pluginDir = '') {
  const raw = String(command || '').trim();
  if (!raw) return false;
  const tokenMatch = raw.match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/);
  const firstToken = tokenMatch ? (tokenMatch[1] ?? tokenMatch[2] ?? tokenMatch[3] ?? raw) : raw;
  const expanded = firstToken
    .replace(/\$\{(?:CLAUDE_PLUGIN_ROOT|PLUGIN_ROOT|extensionPath)\}/g, pluginDir || '.')
    .replace(/\$\{\/\}/g, '/');
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat', '.com'] : [''];
  if (expanded.includes('/') || expanded.includes('\\') || expanded.startsWith('.')) {
    const candidate = isAbsolute(expanded) ? expanded : resolve(pluginDir || '.', expanded);
    return exts.some((ext) => existsSync(candidate + ext));
  }
  if ((expanded === 'node' || expanded.toLowerCase() === 'node.exe') && existsSync(process.execPath)) return true;

  const rawPath = env?.PATH ?? env?.Path ?? process.env.PATH ?? process.env.Path ?? '';
  const dirs = String(rawPath)
    .split(delimiter)
    .map((d) => d.trim())
    .filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      if (existsSync(join(dir, expanded + ext))) return true;
    }
  }
  return false;
}

function collectPlaceholders(node, out = new Set()) {
  if (typeof node === 'string') {
    for (const match of node.matchAll(PLACEHOLDER_RE)) {
      const name = match[1];
      const fallback = match[2];
      if (fallback !== undefined && fallback.trim() !== '') continue;
      if (name && !BUILTIN_PATH_VARS.has(name)) out.add(name);
    }
    return out;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectPlaceholders(item, out);
    return out;
  }
  if (isPlainObject(node)) {
    for (const val of Object.values(node)) collectPlaceholders(val, out);
  }
  return out;
}

function findMissingEnvVars(serverEntry, env = process.env) {
  const vars = collectPlaceholders(serverEntry);
  if (isPlainObject(serverEntry?.env)) {
    for (const [k, v] of Object.entries(serverEntry.env)) {
      if (typeof v === 'string' && v.trim() === '' && !BUILTIN_PATH_VARS.has(k)) {
        vars.add(k);
      }
    }
  }
  const missing = [];
  for (const name of vars) {
    const val = env?.[name];
    if (typeof val !== 'string' || val.trim() === '') {
      missing.push(name);
    }
  }
  return missing;
}

function extractMcpServers(pluginDir, env = process.env) {
  const servers = [];
  const seenKeys = new Set();
  for (const rel of ['mcp_config.json', '.mcp.json', 'mcp.json', 'plugin.json', join('.gemini-plugin', 'plugin.json')]) {
    const mcpPath = join(pluginDir, rel);
    if (!existsSync(mcpPath)) continue;
    const raw = readJsonSafe(mcpPath, null);
    if (!isPlainObject(raw)) continue;
    const isPluginManifest = rel.endsWith('plugin.json');
    if (isPluginManifest && !isPlainObject(raw.mcpServers)) continue;
    const hasWrapper = isPlainObject(raw.mcpServers);
    const map = hasWrapper ? raw.mcpServers : raw;
    for (const [key, entry] of Object.entries(map)) {
      if (!hasWrapper && BARE_MCP_META_KEYS.has(key)) continue;
      if (seenKeys.has(key) || !isPlainObject(entry)) continue;
      seenKeys.add(key);
      const isHttp = Boolean(
        (entry.serverUrl || entry.url || entry.httpUrl || entry.type === 'http' || entry.type === 'sse') &&
          !entry.command
      );
      const transport = isHttp ? 'http' : 'stdio';
      const commandExists = isHttp ? null : checkCommandExists(entry.command, env, pluginDir);
      const missingEnvVars = findMissingEnvVars(entry, env);
      servers.push({ key, transport, commandExists, missingEnvVars });
    }
  }
  return servers;
}

function collectEventBuckets(parsedHooks) {
  if (!isPlainObject(parsedHooks)) return [];
  const root = isPlainObject(parsedHooks.hooks) ? parsedHooks.hooks : parsedHooks;
  const buckets = [];
  for (const [key, val] of Object.entries(root)) {
    if (Array.isArray(val)) {
      buckets.push([key, val]);
    } else if (isPlainObject(val)) {
      for (const [ev, arr] of Object.entries(val)) {
        if (Array.isArray(arr)) buckets.push([ev, arr]);
      }
    }
  }
  return buckets;
}

function extractHooks(pluginDir) {
  const hooks = [];
  for (const rel of ['hooks.json', 'hooks/hooks.json', 'plugin.json', join('.gemini-plugin', 'plugin.json')]) {
    const hooksPath = join(pluginDir, rel);
    if (!existsSync(hooksPath)) continue;
    const raw = readJsonSafe(hooksPath, null);
    if (rel.endsWith('plugin.json') && !isPlainObject(raw?.hooks)) continue;
    const target = rel.endsWith('plugin.json') ? { hooks: raw.hooks } : raw;
    for (const [event, entries] of collectEventBuckets(target)) {
      for (const entry of entries) {
        if (!isPlainObject(entry)) continue;
        const matcher = typeof entry.matcher === 'string' ? entry.matcher : '*';
        if (Array.isArray(entry.hooks)) {
          for (const h of entry.hooks) {
            if (isPlainObject(h) && typeof h.command === 'string') {
              hooks.push({ event, matcher, command: h.command });
            }
          }
        } else if (typeof entry.command === 'string') {
          hooks.push({ event, matcher, command: entry.command });
        }
      }
    }
    if (hooks.length > 0) break;
  }
  return hooks;
}

export function inspectInstalledPluginHealth(pluginsDir = GLOBAL_PLUGINS_DIR, env = process.env) {
  if (!pluginsDir || !existsSync(pluginsDir)) return [];
  let entries = [];
  try {
    entries = readdirSync(pluginsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const results = [];
  const sorted = entries
    .filter((e) => !e.name.startsWith('.') && (e.isDirectory() || e.isSymbolicLink()))
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of sorted) {
    const pluginDir = join(pluginsDir, entry.name);
    if (!existsSync(pluginDir)) continue;
    const mcpServers = extractMcpServers(pluginDir, env);
    const hooks = extractHooks(pluginDir);
    const healthy = mcpServers.every(
      (s) => (s.transport === 'http' || s.commandExists === true) && s.missingEnvVars.length === 0
    );
    results.push({
      id: entry.name,
      healthy,
      mcpServers,
      hooks,
    });
  }
  return results;
}
