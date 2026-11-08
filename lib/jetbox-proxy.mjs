/** @fileoverview Proxies Antigravity's native jetbox_web bundle in Aux-Pane-Only terminal mode and Side-Chat conversation mode. */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP_STORAGE_PATH, CONFIG_JSON_PATH, readJsonSafe } from 'antigravity-sidecar-kit/config';
import { createConnectFrameAccumulator, encodeConnectFrame as encodeConnectFrameBuf, getLsConfig } from 'antigravity-sidecar-kit/rpc';
import { getCurrentRequestContext, isLoopbackOrigin, verifySidecarToken } from 'antigravity-sidecar-kit/state-sync';
import { hangarRpc } from './ls-rpc.mjs';

export function checkJetboxAuth(data, rawCtx = {}, { requireToken = true } = {}) {
  const ctx = (rawCtx && (rawCtx.req || rawCtx.headers || rawCtx.query || rawCtx.origin !== undefined)) ? rawCtx : (getCurrentRequestContext?.() || rawCtx || {});
  const req = ctx?.req || (ctx?.headers ? ctx : data?.headers ? data : null);
  const headers = req?.headers || ctx?.headers || data?.headers || null;
  const origin = headers?.origin ?? ctx?.origin ?? data?.origin;
  if (origin !== undefined && !isLoopbackOrigin(origin)) {
    return { ok: false, status: 403, error: 'Forbidden origin' };
  }
  const expectedToken = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || '';
  if (expectedToken && (requireToken || headers || data?.token !== undefined || ctx?.query)) {
    const rawHeaderTok = headers?.['x-sidecar-token'] ?? headers?.['X-Sidecar-Token'] ?? headers?.['x-codeium-csrf-token'];
    const headerTok = Array.isArray(rawHeaderTok) ? rawHeaderTok[0] : (rawHeaderTok || '');
    let refererTok = '';
    if (headers?.referer) {
      try { refererTok = new URL(headers.referer, 'http://127.0.0.1').searchParams.get('token') || ''; } catch {}
    }
    let reqUrlTok = '';
    if (req?.url) {
      try { reqUrlTok = new URL(req.url, 'http://127.0.0.1').searchParams.get('token') || ''; } catch {}
    }
    const urlTok = ctx?.query?.token ?? ctx?.query?.get?.('token') ?? data?.token ?? reqUrlTok ?? refererTok ?? '';
    const provided = String(headerTok || urlTok || refererTok || '');
    if (!verifySidecarToken(provided, expectedToken)) {
      return { ok: false, status: 401, error: 'Unauthorized' };
    }
  }
  return { ok: true, status: 200, uiToken: expectedToken || String(data?.token || '') };
}

class DefaultResponse {
  constructor(body, { contentType = 'text/plain', status = 200, headers } = {}) {
    this.body = body;
    this.contentType = contentType;
    this.status = status;
    this.headers = headers;
  }
}
export const MAX_ASSET_CACHE_ENTRIES = 128;
const SYMBOL_ICON_RE = /^\/symbols-icons\/icons\/(?:files|folders)\/[A-Za-z0-9._-]+\.svg$/;
const assetCache = new Map();
const chatStreams = new Map();
const QUOTE_DIR = join(tmpdir(), 'hangar-quotes');
try { mkdirSync(QUOTE_DIR, { recursive: true }); } catch {}
const QUOTE_DIR_URI = pathToFileURL(QUOTE_DIR).href.replace(/\/+$/, '').replace(/^file:\/\/\/([A-Z]):/, (_, d) => `file:///${d.toLowerCase()}:`);
export function writeQuoteFile(name, text, terminalId = '') {
  const cleanName = String(name || 'terminal').replace(/[\[\]()\r\n]+/g, ' ').replace(/\s+/g, ' ').trim() || 'terminal';
  const baseName = cleanName.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'terminal';
  const safeTid = String(terminalId || '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36);
  const safe = `${baseName}${safeTid ? `-${safeTid}` : ''}-quote.txt`;
  try { mkdirSync(QUOTE_DIR, { recursive: true }); writeFileSync(join(QUOTE_DIR, safe), String(text || ''), 'utf8'); } catch {}
  return `${QUOTE_DIR_URI}/${encodeURIComponent(safe)}`;
}

export async function syncQuoteWithHostWindow({ conversationId = '', terminalId = '', name = 'terminal', selectionContent = '', action = 'stage', cdpPort = 0, fetchFn = globalThis.fetch, WebSocketClass = globalThis.WebSocket } = {}) {
  try {
    let port = Number(cdpPort) || 0;
    if (!port) {
      const candidates = [
        process.env.APPDATA && join(process.env.APPDATA, 'Antigravity', 'DevToolsActivePort'),
        join(homedir(), 'AppData', 'Roaming', 'Antigravity', 'DevToolsActivePort'),
        join(homedir(), '.config', 'Antigravity', 'DevToolsActivePort'),
        join(homedir(), 'Library', 'Application Support', 'Antigravity', 'DevToolsActivePort'),
      ].filter(Boolean);
      for (const p of candidates) {
        try {
          const first = readFileSync(p, 'utf8').split(/\r?\n/)[0]?.trim();
          if (first && /^\d+$/.test(first)) { port = Number(first); break; }
        } catch {}
      }
    }
    if (!port || typeof fetchFn !== 'function' || typeof WebSocketClass !== 'function') return { ok: false, reason: 'no-cdp-port' };
    const targets = await fetchFn(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1200) }).then((r) => r.json()).catch(() => []);
    const list = Array.isArray(targets) ? targets : [];
    const cid = String(conversationId || '').trim().replace(/^hangar:/, '');
    const pages = list.filter((t) => t?.type === 'page' && t?.webSocketDebuggerUrl && !String(t?.url || '').startsWith('devtools://'));
    if (!pages.length) return { ok: false, reason: 'no-hub-page' };
    const hangarFrames = list.filter((t) => t?.type === 'iframe' && String(t?.url || '').includes('plugin://hangar-'));
    const cidParentIds = new Set(cid && cid !== '_new' ? hangarFrames.filter((f) => String(f.url || '').includes(cid)).map((f) => f.parentId).filter(Boolean) : []);
    const activePageIds = new Set(hangarFrames.map((f) => f.parentId).filter(Boolean));
    const target = (cid && cid !== '_new' && (pages.find((t) => cidParentIds.has(t.id)) || pages.find((t) => String(t.url || '').includes(cid))))
      || pages.find((t) => activePageIds.has(t.id)) || pages.find((t) => t.title === 'Hub' || String(t.url || '').includes('/c/')) || pages[0];
    const cleanName = String(name || 'terminal').replace(/[\[\]()\r\n]+/g, ' ').replace(/\s+/g, ' ').trim() || 'terminal';
    const scopeJson = JSON.stringify({ terminal: { processId: String(terminalId || ''), name: cleanName, ...(selectionContent ? { selectionContent: String(selectionContent) } : {}) } });
    const expr = `(() => {
      const scopeJson = ${JSON.stringify(scopeJson)}, action = ${JSON.stringify(action)};
      window.__hangarPendingQuote = { scopeJson, ts: Date.now() };
      if (!window.__hangarDropHookInstalled) {
        window.__hangarDropHookInstalled = true;
        window.addEventListener('drop', (e) => {
          const pq = window.__hangarPendingQuote;
          if (!pq || (Date.now() - pq.ts > 60000) || e.dataTransfer?.files?.length > 0) return;
          if (e.isTrusted) window.__hangarLastNativeDropTs = Date.now();
          if (e.dataTransfer) {
            const origGetData = e.dataTransfer.getData.bind(e.dataTransfer);
            try {
              const scopeToUse = origGetData('application/context-scope-item-cider') || origGetData('application/context-scope-item') || pq.scopeJson;
              e.dataTransfer.getData = (type) => (type === 'application/context-scope-item-cider' || type === 'application/context-scope-item') ? scopeToUse : ((type === 'text/uri-list' || type === 'text/plain') ? '' : origGetData(type));
              setTimeout(() => { if (window.__hangarPendingQuote === pq) window.__hangarPendingQuote = null; }, 50);
            } catch {}
          }
        }, true);
      }
      if (action === 'drop') {
        if (Date.now() - (window.__hangarLastNativeDropTs || 0) < 900) return 'already-dropped-natively';
        if (Date.now() - (window.__hangarLastInjectedDropTs || 0) < 700) return 'already-injected';
        window.__hangarLastInjectedDropTs = Date.now();
        const dt = new DataTransfer();
        dt.setData('application/context-scope-item', scopeJson);
        dt.setData('application/context-scope-item-cider', scopeJson);
        const dropEv = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
        const ed = document.querySelector('[data-lexical-editor="true"]');
        if (ed && typeof ed.dispatchEvent === 'function') ed.dispatchEvent(dropEv); else window.dispatchEvent(dropEv);
        if (ed && typeof ed.focus === 'function') ed.focus();
        window.__hangarPendingQuote = null;
        return 'injected-drop';
      }
      return 'staged';
    })()`;
    const result = await new Promise((resolve) => {
      const ws = new WebSocketClass(target.webSocketDebuggerUrl);
      const timer = setTimeout(() => { try { ws.close(); } catch {} resolve('timeout'); }, 1500);
      ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data || ''));
          if (msg.id === 1) {
            clearTimeout(timer);
            try { ws.close(); } catch {}
            resolve(msg.result?.result?.value || 'done');
          }
        } catch {}
      };
      ws.onerror = () => { clearTimeout(timer); resolve('error'); };
    });
    return { ok: true, result, targetId: target.id };
  } catch (err) {
    return { ok: false, reason: err?.message || 'error' };
  }
}

async function fetchLsAsset(pathname, contentType, ResponseClass = DefaultResponse, fetchFn = globalThis.fetch) {
  const { lsAddress: lsAddr } = getLsConfig();
  if (!lsAddr) return new ResponseClass('Missing ANTIGRAVITY_LS_ADDRESS', { status: 503, contentType: 'text/plain' });
  const cacheKey = `${lsAddr}:${pathname}`;
  if (assetCache.has(cacheKey)) return new ResponseClass(assetCache.get(cacheKey), { status: 200, contentType });
  const upstream = await fetchFn(`http://${lsAddr}${pathname}`);
  if (!upstream.ok) return new ResponseClass(`Upstream ${pathname} returned ${upstream.status}`, { status: upstream.status, contentType: 'text/plain' });
  const buf = Buffer.from(await upstream.arrayBuffer());
  if (assetCache.size >= MAX_ASSET_CACHE_ENTRIES) {
    const oldestKey = assetCache.keys().next().value;
    if (oldestKey !== undefined) assetCache.delete(oldestKey);
  }
  assetCache.set(cacheKey, buf);
  return new ResponseClass(buf, { status: 200, contentType });
}

export function evictStaleChatStreams(nowMs = Date.now(), maxIdleMs = 120_000) {
  let evicted = 0;
  for (const [k, entry] of chatStreams.entries()) {
    if (nowMs - (entry.lastPolledAt ?? entry.createdAt ?? 0) > maxIdleMs) {
      try { entry.abortController?.abort?.(); } catch {}
      try { entry.req?.destroy?.(); } catch {}
      chatStreams.delete(k);
      evicted += 1;
    }
  }
  return evicted;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function startTerminalSideChat({ parentConversationId = '', cascadeId = '', rpcFn = hangarRpc } = {}) {
  const rawCid = String(cascadeId || '').trim();
  const newId = rawCid && !/^sidechat-\d+-\d+$/.test(rawCid) ? rawCid : randomUUID();
  const parentId = String(parentConversationId || '').trim().replace(/^hangar:/, '');
  const baseReq = { cascadeId: newId, trajectoryType: 22, source: 12 };
  if (parentId && parentId !== '_new') {
    try {
      await rpcFn('StartCascade', { ...baseReq, baseTrajectoryIdentifier: { cascadeId: parentId } });
      return { ok: true, cascadeId: newId, parentConversationId: parentId };
    } catch {}
  }
  await rpcFn('StartCascade', baseReq);
  return { ok: true, cascadeId: newId, parentConversationId: '' };
}

export async function deleteTerminalSideChat({ cascadeId = '', rpcFn = hangarRpc } = {}) {
  const cid = String(cascadeId || '').trim();
  if (!cid) throw new Error('cascadeId is required');
  for (const [k, entry] of chatStreams.entries()) {
    if (entry.conversationId === cid) {
      try { entry.abortController?.abort(); } catch {}
      chatStreams.delete(k);
    }
  }
  await rpcFn('DeleteCascadeTrajectory', { cascadeId: cid }).catch(() => {});
  return { ok: true, cascadeId: cid };
}

export function pollChatStream({
  conversationId = '', subscriberId = 'sidechat', trajectoryVerbosity = 'CLIENT_TRAJECTORY_VERBOSITY_PROD_UI',
  initialStepsPageBounds = { startIndex: -50 }, initialGeneratorMetadatasPageBounds = { startIndex: -1 },
  initialExecutorMetadatasPageBounds = { startIndex: 0, endIndexExclusive: 0 },
  enableLatencyTelemetry, disableRehydration, afterSeq = 0, fetchFn = globalThis.fetch, rpcFn = hangarRpc,
} = {}) {
  const now = Date.now();
  evictStaleChatStreams(now);
  const cid = String(conversationId || '').trim();
  if (!cid) return { chunks: [], seq: 0, closed: false };
  const subId = String(subscriberId || 'sidechat').trim();
  const minSeq = Math.max(0, Number(afterSeq) || 0);
  const resolvedVerbosity = typeof trajectoryVerbosity === 'string' && trajectoryVerbosity.trim()
    ? (/^\d+$/.test(trajectoryVerbosity.trim()) ? Number(trajectoryVerbosity) : trajectoryVerbosity.trim())
    : (Number(trajectoryVerbosity) || 'CLIENT_TRAJECTORY_VERBOSITY_PROD_UI');
  const key = `${cid}:${subId}`;
  let entry = chatStreams.get(key);
  if (!entry) {
    entry = { key, conversationId: cid, subscriberId: subId, seq: minSeq, totalBytes: 0, chunks: [], connecting: false, connected: false, closed: false, autoStarted: false, nextRetryAt: 0, abortController: null, createdAt: now, lastPolledAt: now };
    chatStreams.set(key, entry);
  } else {
    entry.lastPolledAt = now;
  }
  const { lsAddress: lsAddr, csrfToken: csrf } = getLsConfig();
  if (!entry.connecting && !entry.connected && !entry.closed && Date.now() >= entry.nextRetryAt && lsAddr && csrf && typeof fetchFn === 'function') {
    entry.connecting = true;
    entry.nextRetryAt = Date.now() + 1200;
    const ac = new AbortController();
    entry.abortController = ac;
    (async () => {
      let reader = null;
      try {
        const res = await fetchFn(`http://${lsAddr}/exa.language_server_pb.LanguageServerService/StreamAgentStateUpdates`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/connect+json', 'Connect-Protocol-Version': '1', 'x-codeium-csrf-token': csrf },
          body: encodeConnectFrameBuf({
            conversationId: cid, subscriberId: subId, trajectoryVerbosity: resolvedVerbosity,
            ...(initialStepsPageBounds ? { initialStepsPageBounds } : {}),
            ...(initialGeneratorMetadatasPageBounds ? { initialGeneratorMetadatasPageBounds } : {}),
            ...(initialExecutorMetadatasPageBounds ? { initialExecutorMetadatasPageBounds } : {}),
            ...(enableLatencyTelemetry !== undefined ? { enableLatencyTelemetry } : {}),
            ...(disableRehydration !== undefined ? { disableRehydration } : {}),
          }),
          signal: ac.signal,
        });
        entry.connecting = false;
        if (!res.ok || !res.body) return;
        entry.connected = true;
        reader = res.body.getReader();
        const acc = createConnectFrameAccumulator({ maxFrameBytes: Infinity, rawOnly: true });
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const frame of acc.push(value)) {
            if (frame.flags === 0 && frame.raw?.length) {
              const bytes = frame.raw.length;
              entry.seq += 1;
              entry.chunks.push({ seq: entry.seq, raw: frame.raw, bytes });
              entry.totalBytes = (entry.totalBytes || 0) + bytes;
              const cap = (entry.chunks[0]?.seq === 1 ? entry.chunks[0].bytes : 0) + 2_097_152;
              while (entry.chunks.length > 1 && (entry.chunks.length > 240 || entry.totalBytes > cap)) {
                entry.totalBytes = Math.max(0, entry.totalBytes - (entry.chunks.shift()?.bytes || 0));
              }
              entry.onChunk?.();
              entry.onChunk = null;
            } else if ((frame.flags & 2) === 2 && frame.data?.error) {
              const isNotFound = frame.data.error.code === 'not_found' || /not_found|not found/i.test(String(frame.data.error.message || ''));
              if (isNotFound && !entry.autoStarted && UUID_RE.test(cid)) {
                entry.autoStarted = true;
                entry.nextRetryAt = 0;
                await rpcFn('StartCascade', { cascadeId: cid, trajectoryType: 22, source: 12 }).catch(() => {});
              } else {
                entry.closed = true;
              }
            }
          }
        }
      } catch {} finally {
        try { reader?.releaseLock(); } catch {}
        entry.connecting = false;
        entry.connected = false;
        entry.onChunk?.();
        entry.onChunk = null;
      }
    })();
  }
  while (minSeq > 0 && entry.chunks.length > 0 && entry.chunks[0].seq <= minSeq) {
    entry.totalBytes = Math.max(0, (entry.totalBytes || 0) - (entry.chunks.shift()?.bytes || 0));
  }
  return {
    conversationId: cid, subscriberId: subId, seq: entry.seq, closed: entry.closed,
    chunks: entry.chunks.filter((c) => c.seq > minSeq).map((c) => {
      const rawJson = (c.rawJson ??= c.raw.toString('utf8'));
      const out = { seq: c.seq, rawJson };
      Object.defineProperty(out, 'frameData', { enumerable: false, configurable: true, get: () => (c._parsed ??= JSON.parse(rawJson)) });
      return out;
    }),
  };
}
export const pollSideChatStream = pollChatStream;

const JETBOX_SHARED_CSS = readFileSync(new URL('../ui/jetbox/jetbox-shared.css', import.meta.url), 'utf8');
const JETBOX_CHAT_CSS = readFileSync(new URL('../ui/jetbox/jetbox-chat.css', import.meta.url), 'utf8');
const JETBOX_TERMINAL_CSS = readFileSync(new URL('../ui/jetbox/jetbox-terminal.css', import.meta.url), 'utf8');
const JETBOX_BOOTSTRAP_JS = readFileSync(new URL('../ui/jetbox/jetbox-bootstrap.js', import.meta.url), 'utf8');

function safeScriptJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

const HOST_STORAGE_KEYS = ['jetski.contrast', 'jetski.typeface', 'theme-preset-light', 'theme-preset-dark', 'theme-custom-presets', 'editor-colors'];
function readHostJetboxSeed() {
  const storage = readJsonSafe(APP_STORAGE_PATH, {}) || {};
  const hostStorage = {};
  for (const k of HOST_STORAGE_KEYS) {
    if (storage[k] !== undefined && storage[k] !== null) hostStorage[k] = String(storage[k]);
  }
  const cfg = readJsonSafe(CONFIG_JSON_PATH, {}) || {};
  const userSettings = cfg?.userSettings && typeof cfg.userSettings === 'object' ? { ...cfg.userSettings } : {};
  return { hostStorage, userSettings };
}

function buildJetboxHtml({ mode = 'terminal', cascadeId = '', terminalId = '', hostTheme = 'dark', uiToken = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || '' } = {}) {
  const isChat = mode === 'chat';
  const safeTheme = hostTheme === 'light' ? 'light' : 'dark';
  const q = uiToken ? `?token=${encodeURIComponent(uiToken)}` : '';
  const { hostStorage, userSettings } = readHostJetboxSeed();
  const bootConfig = safeScriptJson({ productName: 'antigravity', csrfToken: 'hangar-jetbox-proxy', appVersion: '2.28.0', releaseChannel: 'stable', devMode: true });
  const bootParams = safeScriptJson({ mode: isChat ? 'chat' : 'terminal', cascadeId: String(cascadeId || ''), terminalId: String(terminalId || ''), quoteDirUri: QUOTE_DIR_URI, uiToken: String(uiToken || ''), safeTheme, themeQuery: `hostTheme=${safeTheme}&defaultThemeMode=${safeTheme}`, hostStorage, userSettings });
  const styleBlock = `${JETBOX_SHARED_CSS}\n${isChat ? JETBOX_CHAT_CSS : JETBOX_TERMINAL_CSS}`;
  return `<!doctype html>
<html lang="en" style="color-scheme: ${safeTheme};"><head>
  <meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${isChat ? 'Antigravity Side Chat' : 'Antigravity Native Terminal'}</title>
  <script>window.__APP_CONFIG__ = ${bootConfig}; window.__HANGAR_JETBOX_PARAMS__ = ${bootParams};\n${JETBOX_BOOTSTRAP_JS}</script>
  <script src="/preload.js${q}"></script>
  <link rel="stylesheet" href="/jetbox.css${q}" /><link rel="stylesheet" href="/compiled_tailwind.css${q}" /><link rel="stylesheet" href="/jetbox-tailwind.css${q}" />
  <style>${styleBlock}</style>
</head><body><div id="root"></div><script src="/prism_bundle.js${q}"></script><script src="/jetbox-main.js${q}"></script></body></html>`;
}

export const buildJetboxTerminalHtml = (opts = {}) => buildJetboxHtml({ ...opts, mode: 'terminal' });
export const buildJetboxChatHtml = (opts = {}) => buildJetboxHtml({ ...opts, mode: 'chat' });

const ALLOWED_JETBOX_RPCS = new Set([
  'ListTerminals', 'CreateTerminal', 'SendTerminalInput', 'CloseTerminal', 'RenameTerminal', 'GetUserStatus', 'GetAllCascadeTrajectories', 'GetCascadeTrajectory',
  'GetCascadeTrajectorySteps', 'GetCascadeTrajectoryGeneratorMetadata', 'GetTrajectoryTurns', 'GetTurnDiff', 'GetTrajectoryFileDiffs', 'GetCodeActionDiff', 'GetChapterTitles',
  'GetCodeValidationStates', 'RequestAgentStatePageUpdate', 'StartCascade', 'SendUserCascadeMessage', 'SendAllQueuedMessages', 'DeleteQueuedUserInputStep',
  'CancelCascadeInvocation', 'CancelCascadeSteps', 'ForceStopCascadeTree', 'HandleCascadeUserInteraction', 'RegisterInteraction', 'RevertToCascadeStep', 'GetRevertPreview',
  'DeleteCascadeTrajectory', 'ForkConversation', 'UpdateConversationAnnotations', 'GetCascadeModelConfigs', 'GetCascadeModelConfigData', 'GetCommandModelConfigs',
  'GetSlashCommands', 'GetAllWorkflows', 'GetAllRules', 'GetAllSkills', 'GetCustomizationStates', 'GetAgentScripts', 'GetAllCustomAgentConfigs', 'ListContextProviders',
  'SearchContext', 'ResolveContextUri', 'SearchFiles', 'SearchConversations', 'StatUri', 'ReadFile', 'ReadDir', 'ResolveFolder', 'GetRepoInfos', 'ListProjects',
  'ReadProject', 'ReadProjects', 'GetContribVariants', 'WarmUpEnvironment', 'SaveMediaAsArtifact', 'DeleteMediaArtifact', 'GetWorkspaceInfos', 'GetAllPlugins',
  'GetMcpServerStates', 'JetboxReadState', 'GetLocalUserInfo', 'GetServerConfiguration', 'GetMendelFlags', 'HasAuthToken', 'GetAuthStatus', 'GetUpdateStatus',
  'GetVersionControlFileContent', 'GetCommitDetails', 'GetBattleWorktreeDiff', 'GetHover',
]);
const NOOP_JETBOX_RPCS = new Set(['JetboxWriteState', 'ManageSidecar', 'RecordError', 'RecordAnalyticsEvent', 'LogObservabilityData', 'ReportFeedbackMetadata']);

export function registerJetboxProxyRoutes(app, { ResponseClass = DefaultResponse, onTerminalInput, rpcFn = hangarRpc, fetchFn = globalThis.fetch } = {}) {
  for (const [p, u, c] of [
    ['/jetbox.css', '/jetbox.css', 'text/css; charset=utf-8'], ['/jetbox-tailwind.css', '/compiled_tailwind.css', 'text/css; charset=utf-8'],
    ['/prism_bundle.js', '/prism_bundle.js', 'text/javascript; charset=utf-8'],
    ['/audio_processor.js', '/audio_processor.js', 'text/javascript; charset=utf-8'], ['/diff_worker.js', '/diff_worker.js', 'text/javascript; charset=utf-8'],
    ['/workers/pdfjs_loader.mjs', '/workers/pdfjs_loader.mjs', 'text/javascript; charset=utf-8'], ['/workers/pdf.worker.mjs', '/workers/pdf.worker.mjs', 'text/javascript; charset=utf-8'],
    ['/jetbox-main.js', '/main.js', 'text/javascript; charset=utf-8'],
  ]) app.page(p, () => fetchLsAsset(u, c, ResponseClass, fetchFn));
  const serveSymbolIcon = (pathname = '/symbols-icons/icons/files/document.svg') =>
    SYMBOL_ICON_RE.test(pathname) && !pathname.includes('..')
      ? fetchLsAsset(pathname, 'image/svg+xml; charset=utf-8', ResponseClass, fetchFn)
      : new ResponseClass('Not found', { status: 404, contentType: 'text/plain; charset=utf-8' });
  app.page('/symbols-icons/*', serveSymbolIcon);
  if (typeof app.run === 'function' && !app._jetboxIconsAttached) {
    app._jetboxIconsAttached = true;
    const origRun = app.run.bind(app);
    app.run = async (...args) => {
      const server = await origRun(...args);
      if (server && typeof server.listeners === 'function' && !server._jetboxIconsAttached) {
        server._jetboxIconsAttached = true;
        const listeners = server.listeners('request');
        server.removeAllListeners('request');
        server.on('request', async (req, res) => {
          let pathname = '';
          try { pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname; } catch {}
          if (req.method === 'GET' && SYMBOL_ICON_RE.test(pathname) && !pathname.includes('..')) {
            try {
              const out = await serveSymbolIcon(pathname);
              res.writeHead(out.status || 200, { 'Content-Type': out.contentType || 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=86400', ...out.headers });
              res.end(out.body);
            } catch {
              res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
              res.end('Upstream error');
            }
            return;
          }
          for (const fn of listeners) fn.call(server, req, res);
        });
      }
      return server;
    };
  }
  const guardJson = (fn) => async (data, ctx) => {
    const auth = checkJetboxAuth(data, ctx, { requireToken: true });
    if (!auth.ok) return new ResponseClass(JSON.stringify({ ok: false, error: auth.error }), { status: auth.status, contentType: 'application/json; charset=utf-8' });
    return fn(data, ctx);
  };
  app.api('/jetbox-terminal', async (data, ctx) => {
    const auth = checkJetboxAuth(data, ctx, { requireToken: true });
    if (!auth.ok) return new ResponseClass(auth.error, { status: auth.status, contentType: 'text/plain; charset=utf-8', headers: { 'Cache-Control': 'no-store' } });
    return new ResponseClass(buildJetboxTerminalHtml({ cascadeId: data?.cascadeId, terminalId: data?.terminalId, hostTheme: data?.hostTheme, uiToken: auth.uiToken }), { contentType: 'text/html; charset=utf-8', headers: { 'Cache-Control': 'no-store' } });
  }, 'GET');
  app.api('/jetbox-chat', async (data, ctx) => {
    const auth = checkJetboxAuth(data, ctx, { requireToken: true });
    if (!auth.ok) return new ResponseClass(auth.error, { status: auth.status, contentType: 'text/plain; charset=utf-8', headers: { 'Cache-Control': 'no-store' } });
    return new ResponseClass(buildJetboxChatHtml({ cascadeId: data?.cascadeId, hostTheme: data?.hostTheme, uiToken: auth.uiToken }), { contentType: 'text/html; charset=utf-8', headers: { 'Cache-Control': 'no-store' } });
  }, 'GET');
  app.api('/api/terminal/sidechat/start', guardJson((data) => startTerminalSideChat(data || {})), 'POST');
  app.api('/api/terminal/sidechat/delete', guardJson((data) => deleteTerminalSideChat(data || {})), 'POST');
  app.api('/api/terminal/chat-poll', guardJson(async (data) => {
    const first = pollChatStream(data || {});
    const entry = !first.chunks.length && !first.closed && !(Number(data?.afterSeq) > 0) ? chatStreams.get(`${first.conversationId}:${first.subscriberId}`) : null;
    if (entry && (entry.connecting || entry.connected)) {
      await new Promise((r) => {
        const t = setTimeout(r, 180);
        entry.onChunk = () => { clearTimeout(t); r(); };
      });
      return pollChatStream(data || {});
    }
    return first;
  }), 'POST');
  app.api('/api/terminal/ls-rpc', guardJson(async (data) => {
    const method = String(data?.method || '').trim();
    if (!/^[A-Za-z0-9_]+$/.test(method)) throw new Error(`Disallowed Jetbox RPC method: ${method}`);
    if (method === 'WriteQuoteFile') {
      const tid = data?.terminalId || data?.targetTerminalId || '';
      const uri = writeQuoteFile(data?.name, data?.selectionContent, tid);
      syncQuoteWithHostWindow({ conversationId: data?.conversationId || data?.targetConversationId, terminalId: tid, name: data?.name, selectionContent: data?.selectionContent, action: 'stage' }).catch(() => {});
      return { uri };
    }
    if (method === 'InjectQuoteDrop') return syncQuoteWithHostWindow({ conversationId: data?.conversationId || data?.targetConversationId, terminalId: data?.terminalId || data?.targetTerminalId, name: data?.name || data?.title, selectionContent: data?.selectionContent, action: 'drop' });
    if (method === 'GetSidecars') return { sidecars: [] };
    if (method === 'HasAuthToken') return { hasToken: true };
    if (method === 'JetboxReadState') return { appState: { agentOnboardingCompleted: 2 }, userConfig: { userSettings: { themeMode: 1 } } };
    if (NOOP_JETBOX_RPCS.has(method) || (!ALLOWED_JETBOX_RPCS.has(method) && /^(Get|List|Fetch|Check|Has|Read|Resolve|Find|Query|Load)/.test(method))) return {};
    if (!ALLOWED_JETBOX_RPCS.has(method)) throw new Error(`Disallowed Jetbox RPC method: ${method}`);
    const reqBody = data?.body && typeof data.body === 'object' ? data.body : {};
    if (method === 'ListTerminals') {
      const targetTid = String(data?.targetTerminalId || '').trim();
      const targetCid = String(data?.targetConversationId || reqBody.conversationId || '').trim();
      if (!targetTid && !targetCid) return rpcFn('ListTerminals', reqBody);
      const raw = await rpcFn('ListTerminals', {});
      const list = Array.isArray(raw?.terminals) ? raw.terminals : [];
      const ids = targetTid ? targetTid.split(',').map((s) => s.trim()).filter(Boolean) : [];
      const byTid = ids.length ? list.filter((t) => ids.includes(t?.terminalId)) : [];
      const matched = ids.length ? (byTid.length ? byTid : list.filter((t) => ids.includes(t?.splitGroupId))) : list.filter((t) => !targetCid || !t?.conversationId || t.conversationId === targetCid || t.conversationId === `hangar:${targetCid}`);
      const forcedSg = ids.length >= 2 && matched.length >= 2 ? (ids[0] || matched[0]?.splitGroupId || matched[0]?.terminalId) : undefined;
      return { terminals: matched.map(({ splitGroupId, ...t }) => ({ ...t, conversationId: targetCid || t.conversationId || '', projectId: '', ...(forcedSg ? { splitGroupId: forcedSg } : (!ids.length && splitGroupId ? { splitGroupId } : {})), workspaceUri: '' })) };
    }
    if (method === 'CreateTerminal') {
      const sanitized = { ...reqBody };
      if (sanitized.workspaceUri && !sanitized.projectId) sanitized.projectId = sanitized.workspaceUri;
      else if (sanitized.projectId && !sanitized.workspaceUri) sanitized.workspaceUri = sanitized.projectId;
      const cid = String(sanitized.conversationId || '').trim() || '_new';
      sanitized.conversationId = cid.startsWith('hangar:') ? cid : `hangar:${cid}`;
      return rpcFn('CreateTerminal', sanitized);
    }
    if (method === 'SendTerminalInput' && reqBody.resize && ((Number(reqBody.resize.cols) || 0) < 10 || (Number(reqBody.resize.rows) || 0) < 3)) return {};
    if (method === 'SendTerminalInput' && reqBody.input) {
      try {
        onTerminalInput?.(reqBody.terminalId || data?.targetTerminalId || '', Buffer.from(String(reqBody.input), 'base64').toString('utf8'), reqBody.inputStreamId, reqBody.inputOffset);
      } catch {}
    }
    const isStrictRpc = method.includes('Terminal') || /^(StartCascade|SendUserCascadeMessage|HandleCascadeUserInteraction|CancelCascadeInvocation|DeleteCascadeTrajectory)$/.test(method);
    const targetCid = String(reqBody.cascadeId || reqBody.conversationId || '').trim();
    if (/^(GetCascadeTrajectory|RequestAgentStatePageUpdate|SendUserCascadeMessage)$/.test(method) && UUID_RE.test(targetCid)) {
      try {
        return await rpcFn(method, reqBody);
      } catch (err) {
        if (/not_found|not found/i.test(String(err?.message || ''))) {
          await rpcFn('StartCascade', { cascadeId: targetCid, trajectoryType: 22, source: 12 }).catch(() => {});
          return isStrictRpc ? rpcFn(method, reqBody) : rpcFn(method, reqBody).catch(() => ({}));
        }
        if (isStrictRpc) throw err;
        return {};
      }
    }
    return isStrictRpc ? rpcFn(method, reqBody) : rpcFn(method, reqBody).catch(() => ({}));
  }), 'POST');
}
