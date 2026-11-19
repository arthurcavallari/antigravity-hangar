/** @fileoverview Jetbox RPC allowlist, no-op stubs, strict-error propagation policy, quote helpers, and proxied static asset table. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getLsConfig } from 'antigravity-sidecar-kit/rpc';

const QUOTE_DIR = join(tmpdir(), 'hangar-quotes');
try { mkdirSync(QUOTE_DIR, { recursive: true }); } catch {}
export const QUOTE_DIR_URI = pathToFileURL(QUOTE_DIR)
  .href.replace(/\/+$/, '')
  .replace(/^file:\/\/\/([A-Z]):/, (_, d) => `file:///${d.toLowerCase()}:`);

export function writeQuoteFile(name, text, terminalId = '') {
  const cleanName = String(name || 'terminal').replace(/[\[\]()\r\n]+/g, ' ').replace(/\s+/g, ' ').trim() || 'terminal';
  const baseName = cleanName.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'terminal';
  const safeTid = String(terminalId || '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36);
  const safe = `${baseName}${safeTid ? `-${safeTid}` : ''}-quote.txt`;
  try {
    mkdirSync(QUOTE_DIR, { recursive: true });
    writeFileSync(join(QUOTE_DIR, safe), String(text || ''), 'utf8');
  } catch {}
  return `${QUOTE_DIR_URI}/${encodeURIComponent(safe)}`;
}

export async function syncQuoteWithHostWindow({
  conversationId = '',
  terminalId = '',
  name = 'terminal',
  selectionContent = '',
  action = 'stage',
  cdpPort = 0,
  fetchFn = globalThis.fetch,
  WebSocketClass = globalThis.WebSocket,
} = {}) {
  try {
    let port = Number(cdpPort) || 0;
    if (!port) {
      const candidates = [
        process.env.AGY_BROWSER_ACTIVE_PORT_FILE?.trim(),
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

export const JETBOX_STATIC_ASSETS = [
  ['/jetbox.css', '/jetbox.css', 'text/css; charset=utf-8'],
  ['/jetbox-tailwind.css', '/compiled_tailwind.css', 'text/css; charset=utf-8'],
  ['/prism_bundle.js', '/prism_bundle.js', 'text/javascript; charset=utf-8'],
  ['/audio_processor.js', '/audio_processor.js', 'text/javascript; charset=utf-8'],
  ['/diff_worker.js', '/diff_worker.js', 'text/javascript; charset=utf-8'],
  ['/workers/pdfjs_loader.mjs', '/workers/pdfjs_loader.mjs', 'text/javascript; charset=utf-8'],
  ['/workers/pdf.min.mjs', '/workers/pdf.min.mjs', 'text/javascript; charset=utf-8'],
  ['/workers/pdf.worker.mjs', '/workers/pdf.worker.mjs', 'text/javascript; charset=utf-8'],
  ['/workers/shiki_worker.js', '/workers/shiki_worker.js', 'text/javascript; charset=utf-8'],
  ['/jetbox-main.js', '/main.js', 'text/javascript; charset=utf-8'],
];

export const ALLOWED_JETBOX_RPCS = new Set([
  'ListTerminals', 'CreateTerminal', 'SendTerminalInput', 'CloseTerminal',
  'GetUserStatus', 'RetrieveUserQuotaSummary', 'GetAvailableModels', 'GetModelStatuses',
  'GetProfileData', 'GetCapabilities', 'FetchAdminControls', 'GetTokenBase',
  'GetAllCascadeTrajectories', 'GetMergedCascadeTrajectories', 'ReadJetboxStateSnapshot', 'GetCascadeTrajectory',
  'GetCascadeTrajectorySteps', 'GetCascadeTrajectoryGeneratorMetadata', 'GetCascadeTrajectoryExecutorMetadatas',
  'GetTrajectoryTurns', 'GetTurnDiff', 'GetTrajectoryFileDiffs', 'GetCodeActionDiff',
  'GetChapterTitles', 'GetCodeValidationStates', 'GetArtifactSnapshots', 'GetPatchAndCodeChange',
  'GetAgentTeamMetadata', 'ListBackgroundTasks', 'ResolveWorkspaceUrlPreview',
  'GetInputCompletion', 'GetDefinition', 'GetReferences',
  'RequestAgentStatePageUpdate', 'StartCascade', 'SendUserCascadeMessage', 'SendAgentMessage',
  'DeleteAgentMessage', 'SendAllQueuedMessages', 'DeleteQueuedUserInputStep',
  'SendAudioChunk', 'EndAudioSession',
  'CancelCascadeInvocation', 'CancelCascadeSteps', 'ForceStopCascadeTree',
  'HandleCascadeUserInteraction', 'RegisterInteraction', 'RevertToCascadeStep', 'GetRevertPreview',
  'DeleteCascadeTrajectory', 'ForkConversation', 'UpdateConversationAnnotations',
  'AcknowledgeCascadeCodeEdit', 'AcknowledgeCodeActionStep', 'ConvertTrajectoryToMarkdown',
  'CreateTrajectoryShare', 'SkipBrowserSubagent', 'OpenUrl',
  'GetCascadeModelConfigs', 'GetCascadeModelConfigData', 'GetCommandModelConfigs',
  'GetSlashCommands', 'GetAllWorkflows', 'GetAllRules', 'GetAllSkills',
  'GetCustomizationStates', 'GetAgentScripts', 'GetAllCustomAgentConfigs',
  'ListContextProviders', 'SearchContext', 'ResolveContextUri', 'SearchFiles', 'SearchConversations',
  'StatUri', 'ReadFile', 'ReadDir', 'ResolveFolder', 'GetRepoInfos', 'ListProjects',
  'ReadProject', 'ReadProjects', 'GetContribVariants', 'WarmUpEnvironment',
  'SaveMediaAsArtifact', 'DeleteMediaArtifact', 'GetWorkspaceInfos',
  'GetAllPlugins', 'GetPlugin', 'GetAvailableCascadePlugins', 'ListPluginAuthProviders',
  'ResolveCommandPlugin', 'ListRemotePlugins', 'GetBuildWithGooglePlugins',
  'GetMarketplaceCustomization', 'GetMarketplaceBundles', 'GetMarketplaceFeatured',
  'InstallCustomization', 'GetPermissionSettings', 'UpdatePermissionSettings',
  'GetMcpServerStates', 'ListMcpResources', 'ListMcpPrompts', 'GetMcpPrompt', 'GetMcpAppResource',
  'ListResourceProviders', 'ListAvailableResources', 'LaunchMcpApp', 'CallMcpAppTool',
  'JetboxReadState', 'JetboxReadAppState', 'JetboxReadUserConfig',
  'GetLocalUserInfo', 'GetServerConfiguration', 'GetMendelFlags', 'HasAuthToken', 'GetAuthStatus', 'GetUpdateStatus',
  'GetVersionControlFileContent', 'GetCommitDetails', 'GetBattleWorktreeDiff', 'GetHover',
  'GetJJWorktrees', 'GetGitHubPullRequests', 'GetChangelistStatus', 'GetGerritChangeStatus',
  'CheckoutCommit', 'DiscardFileChanges',
  'GitStage', 'GitUnstage', 'GitCommit', 'GitDiscard', 'GitPush',
  'JjSync', 'JjCommit', 'JjSquash', 'JjUpload', 'JjAbandon',
  'FigSync', 'FigCommit', 'FigAmend', 'FigUpload',
  'RepoSync', 'RepoCommit', 'RepoAmend', 'RepoUpload',
  'CogSync', 'CogCommit', 'CogUpload', 'CogSquash',
  'SearchGcpProjects', 'SubmitLoginAuthCode', 'SwitchLoginToAuthCode',
]);

export const NOOP_JETBOX_RPCS = new Set([
  'JetboxWriteState', 'ManageSidecar', 'RenameTerminal',
  'RecordError', 'RecordAnalyticsEvent', 'LogObservabilityData', 'ReportFeedbackMetadata',
  'RecordObservabilityData', 'RecordChatFeedback', 'RecordInteractiveCascadeFeedback',
  'RecordUserStepSnapshot', 'SendInputCompletionFeedback',
]);

export const STRICT_JETBOX_RPCS = new Set([
  'GetAuthStatus',
  'GetUserStatus',
  'StartCascade',
  'SendUserCascadeMessage',
  'SendAgentMessage',
  'DeleteAgentMessage',
  'DeleteQueuedUserInputStep',
  'SendAllQueuedMessages',
  'SendAudioChunk',
  'EndAudioSession',
  'HandleCascadeUserInteraction',
  'CancelCascadeInvocation',
  'CancelCascadeSteps',
  'ForceStopCascadeTree',
  'DeleteCascadeTrajectory',
  'RevertToCascadeStep',
  'ForkConversation',
  'UpdateConversationAnnotations',
  'SaveMediaAsArtifact',
  'DeleteMediaArtifact',
  'AcknowledgeCascadeCodeEdit',
  'AcknowledgeCodeActionStep',
  'UpdatePermissionSettings',
  'InstallCustomization',
  'LaunchMcpApp',
  'CallMcpAppTool',
  'JetboxReadAppState',
  'JetboxReadUserConfig',
  'ConvertTrajectoryToMarkdown',
  'CreateTrajectoryShare',
  'SkipBrowserSubagent',
  'CheckoutCommit',
  'DiscardFileChanges',
  'GitStage',
  'GitUnstage',
  'GitCommit',
  'GitDiscard',
  'GitPush',
  'JjSync',
  'JjCommit',
  'JjSquash',
  'JjUpload',
  'JjAbandon',
  'FigSync',
  'FigCommit',
  'FigAmend',
  'FigUpload',
  'RepoSync',
  'RepoCommit',
  'RepoAmend',
  'RepoUpload',
  'CogSync',
  'CogCommit',
  'CogUpload',
  'CogSquash',
]);

export function isStrictJetboxRpc(method) {
  return method.includes('Terminal') || STRICT_JETBOX_RPCS.has(method);
}

export function parseJetboxCookieToken(cookieHeader) {
  const raw = Array.isArray(cookieHeader) ? cookieHeader.join('; ') : String(cookieHeader || '');
  if (!raw) return '';
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    if (part.slice(0, eq).trim() === 'hangar_jetbox_tok') {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return '';
      }
    }
  }
  return '';
}

export async function proxyStaticArtifact(rawUrl, rawCtx, { checkAuth, ResponseClass, fetchFn = globalThis.fetch }) {
  const rawStr = String(rawUrl || '');
  const qIdx = rawStr.indexOf('?');
  const rawPath = (qIdx >= 0 ? rawStr.slice(0, qIdx) : rawStr).split('#')[0];
  let decoded = '';
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return new ResponseClass('Invalid artifact path', { status: 400, contentType: 'text/plain; charset=utf-8' });
  }
  if (
    !rawPath.startsWith('/static/artifacts/') ||
    rawPath.length <= '/static/artifacts/'.length ||
    rawPath.includes('..') ||
    decoded.includes('..') ||
    decoded.includes('\\') ||
    decoded.includes('\0')
  ) {
    return new ResponseClass('Invalid artifact path', { status: 400, contentType: 'text/plain; charset=utf-8' });
  }
  const auth = checkAuth(null, rawCtx, { requireToken: true });
  if (!auth.ok) {
    return new ResponseClass(auth.error, { status: auth.status, contentType: 'text/plain; charset=utf-8' });
  }
  const { lsAddress: lsAddr, csrfToken: csrf } = getLsConfig();
  if (!lsAddr || !csrf) {
    return new ResponseClass('Missing Language Server credentials', { status: 503, contentType: 'text/plain; charset=utf-8' });
  }
  const upstream = await fetchFn(`http://${lsAddr}${rawPath}?csrf=${encodeURIComponent(csrf)}`);
  if (!upstream.ok) {
    return new ResponseClass(`Upstream artifact returned ${upstream.status}`, {
      status: upstream.status,
      contentType: 'text/plain; charset=utf-8',
    });
  }
  const buf = Buffer.from(await upstream.arrayBuffer());
  const contentType = upstream.headers?.get?.('content-type') || 'application/octet-stream';
  return new ResponseClass(buf, {
    status: 200,
    contentType,
    headers: { 'Cache-Control': 'private, max-age=300' },
  });
}
