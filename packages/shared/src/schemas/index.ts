// Auth schemas
export {
  LoginRequestSchema,
  type LoginRequest,
} from './auth.js';

// Agent schemas
export {
  // Base schema for client form reuse
  AgentFieldsBaseSchema,
  // Server schemas
  AgentActivityPatternsSchema,
  AgentCapabilitiesSchema,
  AgentDefinitionSchema,
  CreateAgentRequestSchema,
  UpdateAgentRequestSchema,
  // Validation utilities
  isValidRegex,
  isSafeRegex,
  isPromptQuoted,
  hasMalformedPlaceholder,
  // Types
  type CreateAgentRequest,
  type UpdateAgentRequest,
  type AgentActivityPatterns,
  type AgentCapabilities,
} from './agent.js';

// Worker schemas
export {
  CreateWorkerRequestSchema,
  RestartWorkerRequestSchema,
  // Internal types for server-side worker creation
  type CreateAgentWorkerParams,
  type CreateTerminalWorkerParams,
  type CreateGitDiffWorkerParams,
  type CreateEmbeddedAgentWorkerParams,
  type CreateWorkerParams,
  // API types
  type CreateWorkerRequest,
  type RestartWorkerRequest,
} from './worker.js';

// Embedded agent schemas
export {
  EmbeddedAgentProviderSchema,
  EmbeddedAgentDefinitionSchema,
  CreateEmbeddedAgentRequestSchema,
  UpdateEmbeddedAgentRequestSchema,
  EmbeddedAgentCommandSchema,
  EmbeddedAgentEventSchema,
  EmbeddedAgentServerEventSchema,
  EmbeddedAgentStreamEventSchema,
  type CreateEmbeddedAgentRequest,
  type UpdateEmbeddedAgentRequest,
} from './embedded-agent.js';

// Session schemas
export {
  CreateWorktreeSessionRequestSchema,
  CreateQuickSessionRequestSchema,
  CreateSessionRequestSchema,
  UpdateSessionRequestSchema,
  DeleteSessionRequestSchema,
  branchNamePattern,
  branchNameErrorMessage,
  type CreateWorktreeSessionRequest,
  type CreateQuickSessionRequest,
  type CreateSessionRequest,
  type UpdateSessionRequest,
  type DeleteSessionRequest,
} from './session.js';

// Repository schemas
export {
  CreateRepositoryRequestSchema,
  CloneRepositoryRequestSchema,
  CLONE_JOB_STATUS,
  CLONE_ERROR_CODES,
  CreateWorktreePromptRequestSchema,
  CreateWorktreeCustomRequestSchema,
  CreateWorktreeExistingRequestSchema,
  CreateWorktreeRequestSchema,
  DeleteWorktreeRequestSchema,
  DeleteRepositoryRequestSchema,
  PullWorktreeRequestSchema,
  UpdateRepositoryRequestSchema,
  FetchGitHubIssueRequestSchema,
  GitHubIssueSummarySchema,
  RefreshDefaultBranchResponseSchema,
  RemoteBranchStatusSchema,
  type CreateRepositoryRequest,
  type CloneRepositoryRequest,
  type CloneRepositoryResponse,
  type CloneJobStatus,
  type CloneJobStatusResponse,
  type CloneJobError,
  type CloneErrorCode,
  type CreateWorktreePromptRequest,
  type CreateWorktreeCustomRequest,
  type CreateWorktreeExistingRequest,
  type CreateWorktreeRequest,
  type DeleteWorktreeRequest,
  type DeleteRepositoryRequest,
  type PullWorktreeRequest,
  type UpdateRepositoryRequest,
  type FetchGitHubIssueRequest,
  type GitHubIssueSummary,
  type RefreshDefaultBranchResponse,
  type RemoteBranchStatus,
  type GenerateRepositoryDescriptionResponse,
} from './repository.js';

// App server message schema
export {
  AppServerMessageSchema,
  SchemaVersionMessageSchema,
} from './app-server-message.js';

// System schemas
export {
  SystemOpenRequestSchema,
  SystemOpenVSCodeRequestSchema,
  type SystemOpenRequest,
  type SystemOpenVSCodeRequest,
} from './system.js';

// Message schemas
export {
  SendWorkerMessageRequestSchema,
  type SendWorkerMessageRequest,
} from './message.js';

// Notification schemas
export {
  RepositorySlackIntegrationInputSchema,
  type RepositorySlackIntegrationInput,
} from './notification.js';

// Message template schemas
export {
  CreateMessageTemplateRequestSchema,
  UpdateMessageTemplateRequestSchema,
  ReorderMessageTemplatesRequestSchema,
  type CreateMessageTemplateRequest,
  type UpdateMessageTemplateRequest,
  type ReorderMessageTemplatesRequest,
} from './message-template.js';
