export type AgentDriver = "acp-proxy" | "stdio-text";
export type AuthAction = "login" | "device-login" | "status" | "logout";

export type CapacityKind =
  | "quota_exhausted"
  | "rate_limited"
  | "context_exhausted"
  | "model_unavailable"
  | "unknown_backend_failure";

export type AgentHealthStatus = "healthy" | "limited" | "disabled" | "unavailable";

export interface AgentConfig {
  name: string;
  persona?: string;
  driver: AgentDriver;
  command: string;
  args: string[];
  env: Record<string, string>;
  models?: AgentModelConfig[];
  defaultModel?: string;
  auth?: AgentAuthConfig;
  priority: number;
  enabled: boolean;
  capabilities: string[];
  costHint: number;
  idleTimeoutMs: number;
}

export interface AgentModelConfig {
  id: string;
  label?: string;
  description?: string;
  enabled: boolean;
  costHint?: number;
  args: string[];
  env: Record<string, string>;
}

export interface CommandSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  timeoutMs: number;
  cwd?: string;
  interactive: boolean;
}

export interface AgentAuthConfig {
  login?: CommandSpec;
  deviceLogin?: CommandSpec;
  status?: CommandSpec;
  logout?: CommandSpec;
  successPatterns: string[];
  loggedInPatterns: string[];
  loggedOutPatterns: string[];
}

export interface AuthCommandUpdate {
  agentName: string;
  action: AuthAction;
  stream: "stdout" | "stderr" | "lifecycle";
  text: string;
  urls: string[];
  at: string;
}

export interface AuthCommandResult {
  agentName: string;
  action: AuthAction;
  status: "not_configured" | "succeeded" | "failed" | "unknown";
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  urls: string[];
  durationMs: number;
  message?: string;
}

export interface CapacityDetectorConfig {
  quota: string[];
  rate_limit: string[];
  context: string[];
  model_unavailable: string[];
}

export interface FailoverConfig {
  mode: "ask" | "auto" | "manual";
  triggers: Array<"quota" | "rate_limit" | "context" | "model_unavailable">;
  contextTransfer: "summary_files" | "full_transcript" | "fresh_session";
  cooldownMs: number;
  maxRetriesPerAgent: number;
}

export interface StateConfig {
  path: string;
  retentionDays: number;
  redactionRules: string[];
  contextBudgetChars: number;
}

export interface ConnectorConfig {
  defaultAgent?: string;
  agents: AgentConfig[];
  failover: FailoverConfig;
  capacityDetectors: Record<string, CapacityDetectorConfig>;
  state: StateConfig;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  config?: ConnectorConfig;
}

export interface AgentHealth {
  name: string;
  status: AgentHealthStatus;
  reason?: string;
  limitedKind?: CapacityKind;
  limitedUntil?: number;
  lastCheckedAt?: number;
  activeSessionCount: number;
}

export interface LogicalMessage {
  role: "user" | "agent" | "system";
  text: string;
  at: string;
  agentName?: string;
  attachments?: PromptAttachment[];
}

export interface PromptAttachment {
  id: string;
  kind: "file" | "selection" | "folder" | "open-editor" | "unsupported";
  label: string;
  path?: string;
  range?: string;
  content?: string;
  truncated?: boolean;
}

export interface RoutingEvent {
  at: string;
  from?: string;
  to: string;
  reason: string;
}

export interface LogicalSessionState {
  id: string;
  cwd: string;
  additionalDirectories: string[];
  mcpServers: unknown[];
  activeAgent: string;
  activeModelByAgent?: Record<string, string>;
  backendSessionIds: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  transcript: LogicalMessage[];
  handoffSummary?: string;
  relevantFiles: string[];
  changedFiles: string[];
  permissions: Record<string, boolean>;
  routingHistory: RoutingEvent[];
  pendingTask?: string;
  currentTurnState: "idle" | "running" | "cancelling";
  lastLimitReason?: {
    kind: CapacityKind;
    agentName: string;
    message: string;
    at: string;
  };
  lastPrompt?: string;
}

export interface SwitchProposal {
  id: string;
  sessionId: string;
  fromAgent: string;
  toAgent: string;
  capacityKind: CapacityKind;
  reason: string;
  handoffSummary: string;
  createdAt: string;
}

export interface PromptUpdate {
  method?: string;
  params: unknown;
}

export interface PromptResult {
  stopReason: string;
  capacityKind?: CapacityKind;
  message?: string;
  raw?: unknown;
}

export interface BackendPromptOptions {
  session: LogicalSessionState;
  backendSessionId: string;
  prompt: string;
  handoffSummary?: string;
  signal: AbortSignal;
  onUpdate: (update: PromptUpdate) => void;
  requestClient: (method: string, params: unknown) => Promise<unknown>;
}

export interface AgentBackend {
  readonly agent: AgentConfig;
  initialize(): Promise<void>;
  startSession(session: LogicalSessionState): Promise<string>;
  prompt(options: BackendPromptOptions): Promise<PromptResult>;
  cancel(logicalSessionId: string): Promise<void>;
  dispose(): Promise<void>;
}

export interface JsonRpcRequest {
  jsonrpc?: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc?: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}
