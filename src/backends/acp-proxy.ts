import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import { BaseBackend } from "./base.js";
import { JsonRpcPeer } from "../jsonrpc.js";
import { BackendPromptOptions, ConnectorConfig, LogicalSessionState, PromptResult } from "../types.js";
import { detectCapacity } from "../capacity.js";
import { modelKeyForAgent, resolveAgentArgs, resolveAgentEnvForSession } from "../config.js";

export class AcpProxyBackend extends BaseBackend {
  private child?: ChildProcessWithoutNullStreams;
  private peer?: JsonRpcPeer;
  private readonly logicalToBackend = new Map<string, string>();
  private readonly notificationHandlers = new Set<(method: string, params: unknown) => void>();
  private currentClientRequester?: (method: string, params: unknown) => Promise<unknown>;
  private currentModelKey = "__agent_default__";

  constructor(
    agent: import("../types.js").AgentConfig,
    private readonly config: ConnectorConfig
  ) {
    super(agent);
  }

  async initialize(): Promise<void> {
    await this.initializeProcess();
  }

  private async initializeProcess(session?: LogicalSessionState): Promise<void> {
    await this.ensureProcess(session);
    if (this.initialized) {
      return;
    }
    try {
      await this.peer!.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true
        },
        clientInfo: {
          name: "cli-agent-connector",
          title: "CLI Agent Connector",
          version: "0.1.0"
        }
      });
      this.peer!.notify("initialized", {});
    } catch (error) {
      const capacityKind = detectCapacity(this.agent.name, this.config, error instanceof Error ? error.message : String(error), error);
      if (capacityKind) {
        throw new Error(`${capacityKind}: ${error instanceof Error ? error.message : String(error)}`);
      }
      throw error;
    }
    this.initialized = true;
  }

  async startSession(session: LogicalSessionState): Promise<string> {
    await this.initializeProcess(session);
    const result = await this.peer!.request("session/new", {
      cwd: session.cwd,
      additionalDirectories: session.additionalDirectories,
      mcpServers: session.mcpServers
    });
    const sessionId = extractSessionId(result);
    if (!sessionId) {
      throw new Error(`ACP backend ${this.agent.name} did not return a sessionId.`);
    }
    this.logicalToBackend.set(session.id, sessionId);
    return sessionId;
  }

  async prompt(options: BackendPromptOptions): Promise<PromptResult> {
    let backendSessionId = this.logicalToBackend.get(options.session.id) ?? options.backendSessionId;
    if (!this.child || !this.peer) {
      backendSessionId = await this.startSession(options.session);
    } else {
      const previousModelKey = this.currentModelKey;
      await this.initializeProcess(options.session);
      if (previousModelKey !== this.currentModelKey) {
        backendSessionId = await this.startSession(options.session);
      }
    }
    const handler = (method: string, params: unknown) => {
      options.onUpdate({ method, params });
    };
    this.notificationHandlers.add(handler);
    this.currentClientRequester = options.requestClient;

    try {
      const result = await this.peer!.request(
        "session/prompt",
        {
          sessionId: backendSessionId,
          prompt: [
            {
              type: "text",
              text: buildPromptText(this.agent.persona, options.handoffSummary, options.prompt)
            }
          ]
        },
        30 * 60_000
      );
      const capacityKind = detectCapacity(this.agent.name, this.config, JSON.stringify(result), result);
      return {
        stopReason: extractStopReason(result) ?? "end_turn",
        capacityKind,
        raw: result
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        stopReason: "error",
        capacityKind: detectCapacity(this.agent.name, this.config, message, error) ?? "unknown_backend_failure",
        message
      };
    } finally {
      this.notificationHandlers.delete(handler);
      this.currentClientRequester = undefined;
    }
  }

  async cancel(logicalSessionId: string): Promise<void> {
    const backendSessionId = this.logicalToBackend.get(logicalSessionId) ?? logicalSessionId;
    await this.peer?.request("session/cancel", { sessionId: backendSessionId }, 5_000).catch(() => undefined);
  }

  async dispose(): Promise<void> {
    this.child?.kill("SIGTERM");
    this.child = undefined;
    this.peer = undefined;
    this.logicalToBackend.clear();
    this.initialized = false;
    this.currentModelKey = "__agent_default__";
  }

  private async ensureProcess(session?: LogicalSessionState): Promise<void> {
    const desiredModelKey = modelKeyForAgent(this.agent, session);
    if (this.child && this.peer && this.currentModelKey !== desiredModelKey) {
      await this.dispose();
    }
    if (this.child && this.peer) {
      return;
    }
    this.currentModelKey = desiredModelKey;
    this.child = spawn(this.agent.command, resolveAgentArgs(this.agent, session), {
      env: {
        ...process.env,
        ...resolveAgentEnvForSession(this.agent, session)
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(
        `${JSON.stringify({
          at: new Date().toISOString(),
          event: "backend_stderr",
          agent: this.agent.name,
          text: chunk.toString("utf8")
        })}\n`
      );
    });
    this.child.on("exit", () => {
      this.child = undefined;
      this.peer = undefined;
      this.initialized = false;
    });
    this.peer = new JsonRpcPeer(this.child.stdout, this.child.stdin, {
      name: `${this.agent.name}-acp`,
      requestTimeoutMs: 120_000
    });
    this.peer.onNotification("session/update", (params) => this.forwardNotification("session/update", params));
    this.peer.onNotification("session/request_permission", (params) => this.forwardNotification("session/request_permission", params));
    this.peer.onRequest("session/request_permission", async (params) => {
      if (!this.currentClientRequester) {
        return { outcome: "denied", reason: "No active client requester." };
      }
      return await this.currentClientRequester("session/request_permission", params);
    });
    this.peer.onRequest("fs/read_text_file", async (params) => await this.forwardClientRequest("fs/read_text_file", params));
    this.peer.onRequest("fs/write_text_file", async (params) => await this.forwardClientRequest("fs/write_text_file", params));
    this.peer.onRequest("terminal/execute", async (params) => await this.forwardClientRequest("terminal/execute", params));
    this.peer.start();
  }

  private forwardNotification(method: string, params: unknown): void {
    for (const handler of this.notificationHandlers) {
      handler(method, params);
    }
  }

  private async forwardClientRequest(method: string, params: unknown): Promise<unknown> {
    if (!this.currentClientRequester) {
      throw new Error(`Cannot forward ${method}; no active client request handler.`);
    }
    return await this.currentClientRequester(method, params);
  }
}

function extractSessionId(value: unknown): string | undefined {
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.sessionId === "string") {
      return record.sessionId;
    }
    if (record.session && typeof record.session === "object") {
      const nested = record.session as Record<string, unknown>;
      if (typeof nested.id === "string") {
        return nested.id;
      }
    }
  }
  return undefined;
}

function extractStopReason(value: unknown): string | undefined {
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.stopReason === "string") {
      return record.stopReason;
    }
  }
  return undefined;
}

function buildPromptText(persona: string | undefined, handoffSummary: string | undefined, prompt: string): string {
  return [
    persona ? `Persona:\n${persona}` : undefined,
    handoffSummary ? `Context handoff:\n${handoffSummary}` : undefined,
    prompt
  ]
    .filter(Boolean)
    .join("\n\n");
}
