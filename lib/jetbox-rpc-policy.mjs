/** @fileoverview Jetbox RPC allowlist, no-op stubs, strict-error propagation policy, and proxied static asset table. */
import { getLsConfig } from 'antigravity-sidecar-kit/rpc';

export const JETBOX_STATIC_ASSETS = [
  ['/jetbox.css', '/jetbox.css', 'text/css; charset=utf-8'],
  ['/jetbox-tailwind.css', '/compiled_tailwind.css', 'text/css; charset=utf-8'],
  ['/prism_bundle.js', '/prism_bundle.js', 'text/javascript; charset=utf-8'],
  ['/audio_processor.js', '/audio_processor.js', 'text/javascript; charset=utf-8'],
  ['/diff_worker.js', '/diff_worker.js', 'text/javascript; charset=utf-8'],
  ['/workers/pdfjs_loader.mjs', '/workers/pdfjs_loader.mjs', 'text/javascript; charset=utf-8'],
  ['/workers/pdf.worker.mjs', '/workers/pdf.worker.mjs', 'text/javascript; charset=utf-8'],
  ['/jetbox-main.js', '/main.js', 'text/javascript; charset=utf-8'],
];

export const ALLOWED_JETBOX_RPCS = new Set([
  'ListTerminals', 'CreateTerminal', 'SendTerminalInput', 'CloseTerminal',
  'GetUserStatus', 'RetrieveUserQuotaSummary', 'GetAvailableModels', 'GetModelStatuses',
  'GetProfileData', 'GetCapabilities', 'FetchAdminControls', 'GetTokenBase',
  'GetAllCascadeTrajectories', 'GetMergedCascadeTrajectories', 'GetCascadeTrajectory',
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
