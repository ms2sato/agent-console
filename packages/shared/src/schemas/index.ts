/**
 * The wire-schema barrel. Every consumer of a schema reaches it through here
 * (`packages/shared/src/index.ts` re-exports this module wholesale), which is
 * why the standing ruling below lives at this file rather than beside any one
 * schema: it governs all of them.
 *
 * **That is also this header's scope limit: only properties true of EVERY
 * schema here belong in it.** A rule about one schema, read from the place
 * that speaks for all of them, is not ignored -- it is obeyed too widely. Put
 * anything narrower beside the schema it governs.
 *
 * # Adding a field to a schema in this directory
 *
 * **These schemas are strict. An unknown field makes the parse FAIL; it is not
 * silently dropped.** That is deliberate. An earlier permissive default let a
 * server-populated field vanish at the wire boundary with no error on either
 * side, and the gap surfaced only during manual QA, hours of cross-layer
 * debugging later. Loud beats invisible.
 *
 * The consequence, which is the part people re-derive: **a client running an
 * older bundle rejects the whole row** when the server sends a schema carrying
 * a field that bundle has never heard of. Not the field — the row.
 *
 * **This is already handled, and the handling is "declare and heal". Do not
 * build per-field compatibility machinery for it.** No optional-tolerant
 * variants, no version-gated parsing, no widening a schema so an old client
 * can limp along. Concretely:
 *
 * - **The ordinary path heals.** Every schema file here feeds a build-time
 *   content hash, so touching one changes the version the server advertises.
 *   The client compares it against its own on every REST response and on the
 *   app socket's first frame, and reloads once — and a reload is a fresh
 *   bootstrap, so the full history is refetched and re-parsed by the new
 *   bundle. Rows dropped before the reload come back.
 * - **The degraded path declares itself.** When a mismatch survives the
 *   reload, the client stops reloading and raises a persistent banner. Rows
 *   may drop there, but they drop inside a state the user has been told
 *   about, and a declared divergence is not a silent one.
 *
 * So the question to ask of a new field is NOT "how do old clients cope with
 * it" — it is answered above, identically for every field. Ask instead whether
 * the field's own semantics are right, and whether its schema and its
 * hand-written type were changed together.
 *
 * @see `packages/client/src/lib/schema-version.ts` — the comparison and the
 *   reload guard.
 * @see `packages/server/src/middleware/schema-version-header.ts` and the app
 *   websocket's first frame — the two places the version is advertised.
 * @see `docs/glossary.md` "Schema Version" — the concept and its history.
 */

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
  UpdateEmbeddedAgentWorkerRequestSchema,
  // Internal types for server-side worker creation
  type CreateAgentWorkerParams,
  type CreateTerminalWorkerParams,
  type CreateGitDiffWorkerParams,
  type CreateEmbeddedAgentWorkerParams,
  type CreateWorkerParams,
  // API types
  type CreateWorkerRequest,
  type RestartWorkerRequest,
  type UpdateEmbeddedAgentWorkerRequest,
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
  ExitReasonSchema,
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
  RestoreInfoMessageSchema,
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
  type AppServerMessage,
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

// Artifact schemas
export {
  ArtifactSchema,
  type ArtifactSchemaOutput,
  ArtifactsListResponseSchema,
  type ArtifactsListResponse,
} from './artifact.js';

// Bookmark schemas
export {
  BookmarkSchema,
  type BookmarkSchemaOutput,
  BookmarksListResponseSchema,
  type BookmarksListResponse,
  CreateBookmarkRequestSchema,
  type CreateBookmarkRequest,
  ALLOWED_BOOKMARK_URL_SCHEMES,
} from './bookmark.js';

// Notification center schemas
export {
  NotificationItemSchema,
  NotificationsResponseSchema,
  NotificationsSeenRequestSchema,
  NotificationsSeenResponseSchema,
  type NotificationItemSchemaOutput,
  type NotificationsResponseSchemaOutput,
  type NotificationsSeenRequestSchemaOutput,
  type NotificationsSeenResponseSchemaOutput,
} from './notification-item.js';
