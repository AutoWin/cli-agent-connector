import { spawn } from "node:child_process";
import { AgentConfig, AuthAction, AuthCommandResult, AuthCommandUpdate, CommandSpec } from "./types.js";
import { resolveCommandEnv } from "./config.js";
import { Redactor, truncateText } from "./redaction.js";

const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>]+/g;
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

type AuthUpdateHandler = (update: AuthCommandUpdate) => void;

export class AuthService {
  private readonly running = new Map<string, AbortController>();

  constructor(
    private readonly agents: AgentConfig[],
    private readonly redactor: Redactor
  ) {}

  list(): unknown[] {
    return this.agents.map((agent) => ({
      name: agent.name,
      configured: Boolean(agent.auth),
      actions: {
        login: Boolean(agent.auth?.login),
        deviceLogin: Boolean(agent.auth?.deviceLogin),
        status: Boolean(agent.auth?.status),
        logout: Boolean(agent.auth?.logout)
      }
    }));
  }

  async run(agentName: string, action: AuthAction, onUpdate?: AuthUpdateHandler): Promise<AuthCommandResult> {
    const agent = this.agents.find((candidate) => candidate.name === agentName);
    if (!agent) {
      throw new Error(`Unknown agent: ${agentName}`);
    }

    const spec = this.resolveSpec(agent, action);
    if (!spec) {
      return {
        agentName,
        action,
        status: "not_configured",
        stdout: "",
        stderr: "",
        urls: [],
        durationMs: 0,
        message: `Agent ${agentName} does not configure auth action ${action}.`
      };
    }

    const key = `${agentName}:${action}`;
    if (this.running.has(key)) {
      throw new Error(`Auth action already running for ${agentName}: ${action}`);
    }

    const startedAt = Date.now();
    const controller = new AbortController();
    this.running.set(key, controller);
    const urls = new Set<string>();
    let stdout = "";
    let stderr = "";

    emit(onUpdate, {
      agentName,
      action,
      stream: "lifecycle",
      text: `Starting ${action}: ${spec.command} ${spec.args.join(" ")}`,
      urls: [],
      at: new Date().toISOString()
    });

    return await new Promise<AuthCommandResult>((resolve) => {
      const inheritTerminal = Boolean(spec.interactive && process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY);
      const child = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env: {
          ...process.env,
          ...resolveCommandEnv(spec, agent.env)
        },
        stdio: inheritTerminal ? "inherit" : [spec.interactive && process.stdin.isTTY ? "inherit" : "ignore", "pipe", "pipe"]
      });

      const timeout = setTimeout(() => {
        controller.abort();
        child.kill("SIGTERM");
      }, spec.timeoutMs);
      timeout.unref();

      child.stdout?.on("data", (chunk: Buffer) => {
        const text = stripAnsi(chunk.toString("utf8"));
        stdout += text;
        extractUrls(text).forEach((url) => urls.add(url));
        emit(onUpdate, makeUpdate(agentName, action, "stdout", this.redactor.redactText(text), extractUrls(text)));
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        const text = stripAnsi(chunk.toString("utf8"));
        stderr += text;
        extractUrls(text).forEach((url) => urls.add(url));
        emit(onUpdate, makeUpdate(agentName, action, "stderr", this.redactor.redactText(text), extractUrls(text)));
      });

      child.on("error", (error) => {
        clearTimeout(timeout);
        this.running.delete(key);
        resolve({
          agentName,
          action,
          status: "failed",
          stdout: "",
          stderr: "",
          urls: [],
          durationMs: Date.now() - startedAt,
          message: error.message
        });
      });

      child.on("exit", (exitCode, signal) => {
        clearTimeout(timeout);
        this.running.delete(key);
        const status = classifyStatus(agent, action, stdout, stderr, exitCode, controller.signal.aborted);
        const result: AuthCommandResult = {
          agentName,
          action,
          status,
          exitCode,
          signal,
          stdout: truncateText(this.redactor.redactText(stdout), 16_000),
          stderr: truncateText(this.redactor.redactText(stderr), 16_000),
          urls: [...urls],
          durationMs: Date.now() - startedAt,
          message: controller.signal.aborted
            ? "Auth command timed out and was stopped."
            : inheritTerminal
              ? "Interactive auth used the current terminal; command output was not captured."
              : undefined
        };
        emit(onUpdate, {
          agentName,
          action,
          stream: "lifecycle",
          text: `Finished ${action} with status ${status}`,
          urls: result.urls,
          at: new Date().toISOString()
        });
        resolve(result);
      });
    });
  }

  private resolveSpec(agent: AgentConfig, action: AuthAction): CommandSpec | undefined {
    switch (action) {
      case "login":
        return agent.auth?.login;
      case "device-login":
        return agent.auth?.deviceLogin;
      case "status":
        return agent.auth?.status;
      case "logout":
        return agent.auth?.logout;
    }
  }
}

function classifyStatus(
  agent: AgentConfig,
  action: AuthAction,
  stdout: string,
  stderr: string,
  exitCode: number | null,
  timedOut: boolean
): AuthCommandResult["status"] {
  if (timedOut) {
    return "failed";
  }
  const text = `${stdout}\n${stderr}`;
  if (action === "status") {
    if (matchesAny(text, agent.auth?.loggedInPatterns ?? [])) {
      return "succeeded";
    }
    if (matchesAny(text, agent.auth?.loggedOutPatterns ?? [])) {
      return "failed";
    }
    return exitCode === 0 ? "unknown" : "failed";
  }
  if (exitCode === 0) {
    return matchesAny(text, agent.auth?.successPatterns ?? []) || action === "login" || action === "device-login" || action === "logout"
      ? "succeeded"
      : "unknown";
  }
  return "failed";
}

function matchesAny(text: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    try {
      return new RegExp(pattern, "i").test(text);
    } catch {
      return text.toLowerCase().includes(pattern.toLowerCase());
    }
  });
}

function makeUpdate(
  agentName: string,
  action: AuthAction,
  stream: AuthCommandUpdate["stream"],
  text: string,
  urls: string[]
): AuthCommandUpdate {
  return {
    agentName,
    action,
    stream,
    text,
    urls,
    at: new Date().toISOString()
  };
}

function emit(onUpdate: AuthUpdateHandler | undefined, update: AuthCommandUpdate): void {
  onUpdate?.(update);
}

function extractUrls(text: string): string[] {
  return [...stripAnsi(text).matchAll(URL_PATTERN)].map((match) => match[0].replace(/[),.;]+$/, ""));
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}
