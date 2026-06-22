import { AgentBackend, AgentConfig } from "../types.js";

export abstract class BaseBackend implements AgentBackend {
  protected initialized = false;

  constructor(readonly agent: AgentConfig) {}

  abstract initialize(): Promise<void>;
  abstract startSession(session: import("../types.js").LogicalSessionState): Promise<string>;
  abstract prompt(options: import("../types.js").BackendPromptOptions): Promise<import("../types.js").PromptResult>;
  abstract cancel(logicalSessionId: string): Promise<void>;
  abstract dispose(): Promise<void>;
}
