import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import { BaseBackend } from "./base.js";
import { BackendPromptOptions, LogicalSessionState, PromptResult } from "../types.js";
import { ConnectorConfig } from "../types.js";
import { detectCapacity } from "../capacity.js";
import { resolveAgentArgs, resolveAgentEnvForSession } from "../config.js";
import { truncateText } from "../redaction.js";

export class StdioTextBackend extends BaseBackend {
  private readonly running = new Map<string, ChildProcessWithoutNullStreams>();

  constructor(
    agent: import("../types.js").AgentConfig,
    private readonly config: ConnectorConfig
  ) {
    super(agent);
  }

  async initialize(): Promise<void> {
    this.initialized = true;
  }

  async startSession(session: LogicalSessionState): Promise<string> {
    return `${this.agent.name}:${session.id}`;
  }

  async prompt(options: BackendPromptOptions): Promise<PromptResult> {
    const resolvedArgs = resolveAgentArgs(this.agent, options.session);
    const args = resolvedArgs.map((arg) => arg.replace("{prompt}", options.prompt));
    const usesArgPrompt = resolvedArgs.some((arg) => arg.includes("{prompt}"));
    const child = spawn(this.agent.command, args, {
      cwd: options.session.cwd,
      env: {
        ...process.env,
        ...resolveAgentEnvForSession(this.agent, options.session)
      },
      stdio: ["pipe", "pipe", "pipe"]
    });

    this.running.set(options.session.id, child);
    let stdout = "";
    let stderr = "";

    const persona = this.agent.persona ? `Persona:\n${this.agent.persona}\n\n` : "";
    const handoff = options.handoffSummary ? `Context handoff:\n${options.handoffSummary}\n\n` : "";
    const fullPrompt = `${persona}${handoff}User task:\n${options.prompt}\n`;

    if (usesArgPrompt) {
      child.stdin.end();
    } else {
      child.stdin.write(fullPrompt);
      child.stdin.end();
    }

    options.signal.addEventListener(
      "abort",
      () => {
        child.kill("SIGTERM");
      },
      { once: true }
    );

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      options.onUpdate({
        params: {
          sessionId: options.session.id,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: [{ type: "text", text }]
          }
        }
      });
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr += text;
      options.onUpdate({
        params: {
          sessionId: options.session.id,
          update: {
            sessionUpdate: "tool_call_update",
            title: `${this.agent.name} stderr`,
            content: [{ type: "text", text }]
          }
        }
      });
    });

    return await new Promise<PromptResult>((resolve) => {
      child.on("error", (error) => {
        this.running.delete(options.session.id);
        const message = error.message;
        resolve({
          stopReason: "error",
          capacityKind: detectCapacity(this.agent.name, this.config, message),
          message
        });
      });

      child.on("exit", (code, signal) => {
        this.running.delete(options.session.id);
        const combined = truncateText(`${stdout}\n${stderr}`, 24_000);
        const capacityKind = detectCapacity(this.agent.name, this.config, combined);
        if (options.signal.aborted || signal) {
          resolve({ stopReason: "cancelled", message: `Process stopped by ${signal ?? "abort"}` });
          return;
        }
        if (code === 0) {
          resolve({ stopReason: "end_turn", message: stdout });
          return;
        }
        resolve({
          stopReason: "error",
          capacityKind: capacityKind ?? "unknown_backend_failure",
          message: combined || `Process exited with code ${code}`
        });
      });
    });
  }

  async cancel(logicalSessionId: string): Promise<void> {
    this.running.get(logicalSessionId)?.kill("SIGTERM");
  }

  async dispose(): Promise<void> {
    for (const child of this.running.values()) {
      child.kill("SIGTERM");
    }
    this.running.clear();
  }
}
