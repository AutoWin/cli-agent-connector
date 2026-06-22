import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ConnectorConfig, LogicalSessionState } from "./types.js";
import { Redactor } from "./redaction.js";
import { defaultModelIdForAgent } from "./config.js";

export class StateStore {
  private readonly sessionsDir: string;

  constructor(
    private readonly config: ConnectorConfig,
    private readonly redactor: Redactor
  ) {
    this.sessionsDir = join(config.state.path, "sessions");
  }

  async init(): Promise<void> {
    await mkdir(this.sessionsDir, { recursive: true });
    await this.pruneExpiredSessions();
  }

  async createSession(input: {
    cwd: string;
    additionalDirectories?: string[];
    mcpServers?: unknown[];
    activeAgent: string;
  }): Promise<LogicalSessionState> {
    const now = new Date().toISOString();
    const session: LogicalSessionState = {
      id: `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      cwd: input.cwd,
      additionalDirectories: input.additionalDirectories ?? [],
      mcpServers: input.mcpServers ?? [],
      activeAgent: input.activeAgent,
      activeModelByAgent: initialActiveModels(this.config, input.activeAgent),
      backendSessionIds: {},
      createdAt: now,
      updatedAt: now,
      transcript: [],
      relevantFiles: [],
      changedFiles: [],
      permissions: {},
      routingHistory: [
        {
          at: now,
          to: input.activeAgent,
          reason: "initial"
        }
      ],
      currentTurnState: "idle"
    };
    await this.saveSession(session);
    return session;
  }

  async saveSession(session: LogicalSessionState): Promise<void> {
    await mkdir(this.sessionsDir, { recursive: true });
    const redacted = this.redactor.redact({
      ...session,
      updatedAt: new Date().toISOString()
    });
    await writeFile(this.pathFor(session.id), `${JSON.stringify(redacted, null, 2)}\n`, "utf8");
  }

  async getSession(id: string): Promise<LogicalSessionState> {
    const raw = await readFile(this.pathFor(id), "utf8");
    return JSON.parse(raw) as LogicalSessionState;
  }

  async listSessions(): Promise<LogicalSessionState[]> {
    await mkdir(this.sessionsDir, { recursive: true });
    const files = (await readdir(this.sessionsDir)).filter((file) => file.endsWith(".json"));
    const sessions = await Promise.all(
      files.map(async (file) => JSON.parse(await readFile(join(this.sessionsDir, file), "utf8")) as LogicalSessionState)
    );
    return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async exportSupportBundle(input: {
    sessionId?: string;
    configShape: unknown;
    agents: unknown;
    metrics: unknown;
    recentEvents: string;
  }): Promise<unknown> {
    const session = input.sessionId ? await this.getSession(input.sessionId) : undefined;
    return this.redactor.redact({
      exportedAt: new Date().toISOString(),
      configShape: input.configShape,
      agents: input.agents,
      metrics: input.metrics,
      recentEvents: input.recentEvents,
      session: session
        ? {
            ...session,
            transcript: session.transcript.slice(-5)
          }
        : undefined
    });
  }

  private pathFor(id: string): string {
    return join(this.sessionsDir, `${id}.json`);
  }

  private async pruneExpiredSessions(): Promise<void> {
    const retentionMs = this.config.state.retentionDays * 24 * 60 * 60 * 1000;
    if (retentionMs <= 0) {
      return;
    }
    const now = Date.now();
    const sessions = await this.listSessions().catch(() => []);
    await Promise.all(
      sessions.map(async (session) => {
        if (now - Date.parse(session.updatedAt) > retentionMs) {
          await rm(this.pathFor(session.id), { force: true });
        }
      })
    );
  }
}

function initialActiveModels(config: ConnectorConfig, activeAgent: string): Record<string, string> | undefined {
  const agent = config.agents.find((item) => item.name === activeAgent);
  const modelId = agent ? defaultModelIdForAgent(agent) : undefined;
  return modelId ? { [activeAgent]: modelId } : undefined;
}
