/** @fileoverview Jetbox RPC allowlist, no-op stubs, strict-error propagation policy, and proxied static asset table. */

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
  'GetUserStatus', 'GetAllCascadeTrajectories', 'GetMergedCascadeTrajectories', 'GetCascadeTrajectory',
  'GetCascadeTrajectorySteps', 'GetCascadeTrajectoryGeneratorMetadata', 'GetTrajectoryTurns', 'GetTurnDiff',
  'GetTrajectoryFileDiffs', 'GetCodeActionDiff', 'GetChapterTitles', 'GetCodeValidationStates',
  'RequestAgentStatePageUpdate', 'StartCascade', 'SendUserCascadeMessage', 'SendAgentMessage',
  'DeleteAgentMessage', 'SendAllQueuedMessages', 'DeleteQueuedUserInputStep',
  'CancelCascadeInvocation', 'CancelCascadeSteps', 'ForceStopCascadeTree',
  'HandleCascadeUserInteraction', 'RegisterInteraction', 'RevertToCascadeStep', 'GetRevertPreview',
  'DeleteCascadeTrajectory', 'ForkConversation', 'UpdateConversationAnnotations',
  'GetCascadeModelConfigs', 'GetCascadeModelConfigData', 'GetCommandModelConfigs',
  'GetSlashCommands', 'GetAllWorkflows', 'GetAllRules', 'GetAllSkills',
  'GetCustomizationStates', 'GetAgentScripts', 'GetAllCustomAgentConfigs',
  'ListContextProviders', 'SearchContext', 'ResolveContextUri', 'SearchFiles', 'SearchConversations',
  'StatUri', 'ReadFile', 'ReadDir', 'ResolveFolder', 'GetRepoInfos', 'ListProjects',
  'ReadProject', 'ReadProjects', 'GetContribVariants', 'WarmUpEnvironment',
  'SaveMediaAsArtifact', 'DeleteMediaArtifact', 'GetWorkspaceInfos', 'GetAllPlugins',
  'GetMcpServerStates', 'JetboxReadState', 'GetLocalUserInfo', 'GetServerConfiguration',
  'GetMendelFlags', 'HasAuthToken', 'GetAuthStatus', 'GetUpdateStatus',
  'GetVersionControlFileContent', 'GetCommitDetails', 'GetBattleWorktreeDiff', 'GetHover',
  'SearchGcpProjects', 'SubmitLoginAuthCode', 'SwitchLoginToAuthCode',
]);

export const NOOP_JETBOX_RPCS = new Set([
  'JetboxWriteState', 'ManageSidecar', 'RenameTerminal',
  'RecordError', 'RecordAnalyticsEvent', 'LogObservabilityData', 'ReportFeedbackMetadata',
]);

export const STRICT_JETBOX_RPCS = new Set([
  'StartCascade',
  'SendUserCascadeMessage',
  'SendAgentMessage',
  'DeleteAgentMessage',
  'DeleteQueuedUserInputStep',
  'SendAllQueuedMessages',
  'HandleCascadeUserInteraction',
  'CancelCascadeInvocation',
  'DeleteCascadeTrajectory',
]);

export function isStrictJetboxRpc(method) {
  return method.includes('Terminal') || STRICT_JETBOX_RPCS.has(method);
}
