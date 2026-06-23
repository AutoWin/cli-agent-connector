import * as vscode from "vscode";
import { spawn, execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import {
  buildTextDiff,
  DiffProposal,
  parseDiffProposals,
} from "./chat-utils.js";
import { JsonRpcPeer } from "./jsonrpc.js";
import {
  LogicalMessage,
  LogicalSessionState,
  PromptAttachment,
} from "./types.js";

interface AgentModelView {
  id: string;
  label?: string;
  description?: string;
  benchmarkModelId?: string;
  enabled: boolean;
  costHint?: number;
}

interface AgentView {
  name: string;
  persona?: string;
  driver: string;
  priority: number;
  enabled: boolean;
  capabilities: string[];
  costHint: number;
  models?: AgentModelView[];
  defaultModel?: string;
  auth?: {
    configured: boolean;
    actions: {
      login: boolean;
      deviceLogin: boolean;
      status: boolean;
      logout: boolean;
    };
  };
  health: {
    status: string;
    reason?: string;
    limitedKind?: string;
    activeSessionCount: number;
  };
}

interface FailoverProposal {
  id: string;
  sessionId: string;
  fromAgent: string;
  toAgent: string;
  capacityKind: string;
  reason: string;
  handoffSummary: string;
}

interface ToolCard {
  id: string;
  type: string;
  title: string;
  status: "pending" | "running" | "done" | "approved" | "denied" | "error";
  detail?: string;
  diff?: string;
  actions?: string[];
}

type AgentMode = "agent" | "ask" | "plan";
type ResponseLanguage = "auto" | "en" | "vi";

interface ChatState {
  agents: AgentView[];
  sessions: Array<
    Pick<
      LogicalSessionState,
      | "id"
      | "title"
      | "titleSource"
      | "activeAgent"
      | "activeModelByAgent"
      | "modelSelectionByAgent"
      | "createdAt"
      | "updatedAt"
      | "currentTurnState"
    >
  >;
  activeSessionId?: string;
  activeAgent?: string;
  activeModelByAgent?: Record<string, string>;
  modelSelectionByAgent?: Record<string, string>;
  transcript: LogicalMessage[];
  attachments: PromptAttachment[];
  toolCards: ToolCard[];
  mode: AgentMode;
  responseLanguage: ResponseLanguage;
  busy: boolean;
  error?: string;
}

interface PendingWrite {
  filePath: string;
  content: string;
  resolve: (value: unknown) => void;
}

class ConnectorClient {
  private child?: ReturnType<typeof spawn>;
  private readonly intentionallyStoppedChildren = new WeakSet<
    ReturnType<typeof spawn>
  >();
  private peer?: JsonRpcPeer;
  private sessionId?: string;
  private lastPrompt?: string;
  private lastAttachments: PromptAttachment[] = [];
  private lastMode: AgentMode = "agent";
  private lastResponseLanguage: ResponseLanguage = "auto";
  private activeAgent?: string;
  private currentTurnOutput = "";
  private stderrBuffer = "";
  private readonly openedAuthUrls = new Set<string>();
  private readonly pendingWrites = new Map<string, PendingWrite>();
  private readonly patchProposals = new Map<string, DiffProposal>();
  private chatInitialized = false;
  private chatInitialization?: Promise<void>;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly chat: AgentChatViewProvider,
    private readonly onAgentsChanged: (agents: AgentView[]) => void,
  ) {}

  async start(): Promise<void> {
    if (this.child && this.peer) {
      return;
    }

    const workspaceFolder = this.workspaceFolder();
    const config = vscode.workspace.getConfiguration("cliAgentConnector");
    const configuredCommand =
      config.get<string>("command") ?? "cli-agent-connector";
    const configuredArgs = config.get<string[]>("args") ?? [
      "serve",
      "--config",
      "${workspaceFolder}/cli-agent-connector.config.json",
    ];
    const expandedArgs = configuredArgs.map((arg) =>
      arg.replaceAll("${workspaceFolder}", workspaceFolder),
    );
    const missingConfigPath = this.missingConfigPath(
      expandedArgs,
      workspaceFolder,
    );
    if (missingConfigPath) {
      const message =
        `CLI Agent Connector config was not found for this workspace: ${missingConfigPath}\n` +
        `Create cli-agent-connector.config.json in the opened folder, or update cliAgentConnector.args to point at an existing config.`;
      this.output.appendLine(message);
      this.chat.setError(message);
      throw new Error(message);
    }
    const { command, args } = this.resolveCommand(
      configuredCommand,
      expandedArgs,
    );

    this.child = spawn(command, args, {
      cwd: workspaceFolder,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const child = this.child;
    if (!this.child.stdin || !this.child.stdout || !this.child.stderr) {
      throw new Error("Connector process did not expose stdio pipes.");
    }
    this.stderrBuffer = "";
    this.output.appendLine(`Workspace folder: ${workspaceFolder}`);
    this.output.appendLine(`Started connector: ${command} ${args.join(" ")}`);
    this.child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      this.stderrBuffer = `${this.stderrBuffer}${text}`.slice(-8000);
      this.output.append(text);
    });
    this.child.on("error", (error) => {
      this.output.appendLine(`Connector process error: ${error.message}`);
      if (this.child === child) {
        this.child = undefined;
        this.peer = undefined;
      }
      this.chat.setError(error.message);
    });
    this.child.on("exit", (code, signal) => {
      this.output.appendLine(
        `Connector exited: code=${code ?? "none"} signal=${signal ?? "none"}`,
      );
      const wasIntentional = this.intentionallyStoppedChildren.has(child);
      if (this.child === child) {
        this.child = undefined;
        this.peer = undefined;
      }
      if (wasIntentional) {
        return;
      }
      this.chat.setError("CLI Agent Connector stopped.");
      void vscode.window.showWarningMessage("CLI Agent Connector stopped.");
    });

    this.peer = new JsonRpcPeer(this.child.stdout, this.child.stdin, {
      name: "vscode-client",
      requestTimeoutMs: 30 * 60_000,
    });
    this.registerPeerHandlers(this.peer);
    this.peer.start();
    try {
      await this.peer.request("initialize", {});
      await this.refreshAll();
      this.chat.setError(undefined);
    } catch (error) {
      const detail = this.stderrBuffer.trim();
      throw new Error(
        `Unable to start CLI Agent Connector: ${error instanceof Error ? error.message : String(error)}${
          detail ? `\n\nConnector output:\n${detail}` : ""
        }`,
      );
    }
  }

  async newSession(agentName?: string): Promise<void> {
    await this.start();
    const cwd = this.workspaceFolder();
    const result = (await this.peer!.request("session/new", {
      cwd,
      agentName,
    })) as { sessionId?: string; activeAgent?: string };
    if (!result.sessionId) {
      throw new Error("Connector did not return a sessionId.");
    }
    this.sessionId = result.sessionId;
    this.activeAgent = result.activeAgent;
    this.lastPrompt = undefined;
    this.lastAttachments = [];
    this.chat.setAttachments([]);
    this.output.appendLine(
      `New session: ${this.sessionId}${result.activeAgent ? ` (${result.activeAgent})` : ""}`,
    );
    await this.refreshAll();
    await this.loadSession(result.sessionId);
  }

  async openChat(agentName?: string): Promise<void> {
    await this.chat.reveal();
    if (agentName) {
      await this.switchAgent(agentName);
    } else {
      await this.start();
    }
  }

  async sendPrompt(
    prompt?: string,
    attachments = this.chat.attachments,
  ): Promise<void> {
    await this.start();
    if (!this.sessionId) {
      await this.newSession(this.activeAgent);
    }
    const text =
      prompt ??
      (await vscode.window.showInputBox({
        title: "Send prompt to active CLI agent",
        prompt: "What should the agent do?",
        ignoreFocusOut: true,
      }));
    if (!text || !this.sessionId) {
      return;
    }

    this.lastPrompt = text;
    this.lastAttachments = attachments;
    this.lastMode = this.chat.mode;
    this.lastResponseLanguage = this.chat.responseLanguage;
    this.currentTurnOutput = "";
    this.chat.setBusy(true);
    this.chat.appendLocalUserMessage(text, attachments);
    this.output.show(true);
    this.output.appendLine(`\n> [${this.chat.mode}] ${text}\n`);
    this.chat.startAgentMessage();

    try {
      await this.peer!.request("session/prompt", {
        sessionId: this.sessionId,
        prompt: text,
        mode: this.chat.mode,
        responseLanguage: this.chat.responseLanguage,
        attachments,
      });
      this.chat.finishAgentMessage();
      this.addDiffProposalCards(parseDiffProposals(this.currentTurnOutput));
      this.chat.setAttachments([]);
      await this.refreshAll();
      await this.loadSession(this.sessionId);
    } catch (error) {
      this.chat.appendError(
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    } finally {
      this.chat.setBusy(false);
    }
  }

  async cancel(): Promise<void> {
    if (!this.peer || !this.sessionId) {
      return;
    }
    await this.peer.request("session/cancel", { sessionId: this.sessionId });
    this.chat.setBusy(false);
    await this.refreshAll();
  }

  async switchAgent(agentName?: string): Promise<void> {
    await this.start();
    const agents = (await this.peer!.request(
      "connector/agents/list",
      {},
    )) as AgentView[];
    const picked =
      agentName ??
      (
        await vscode.window.showQuickPick(
          agents
            .filter((agent) => agent.enabled)
            .map((agent) => ({
              label: agent.name,
              description: `${agent.health.status} · priority ${agent.priority} · cost ${agent.costHint}`,
              detail: agent.persona,
              agent,
            })),
          { title: "Switch active CLI agent" },
        )
      )?.agent.name;
    if (!picked) {
      return;
    }
    if (!this.sessionId) {
      await this.newSession(picked);
      return;
    }
    await this.peer!.request("connector/agent/switch", {
      sessionId: this.sessionId,
      agentName: picked,
    });
    this.activeAgent = picked;
    this.output.appendLine(`Active agent: ${picked}`);
    await this.refreshAll();
    await this.loadSession(this.sessionId);
  }

  async switchModel(agentName: string, modelId: string): Promise<void> {
    await this.start();
    if (!this.sessionId) {
      await this.newSession(agentName);
    }
    if (!this.sessionId || modelId === "__agent_default__") {
      return;
    }
    await this.peer!.request("connector/model/switch", {
      sessionId: this.sessionId,
      agentName,
      modelId,
    });
    this.output.appendLine(`Active model for ${agentName}: ${modelId}`);
    await this.refreshAll();
    await this.loadSession(this.sessionId);
  }

  async renameSession(): Promise<void> {
    await this.start();
    if (!this.sessionId) {
      return;
    }
    const title = await vscode.window.showInputBox({
      title: "Rename chat session",
      value: this.chat.currentSessionTitle() ?? "",
      prompt: "Short name for this session",
      ignoreFocusOut: true,
    });
    if (!title?.trim()) {
      return;
    }
    await this.peer!.request("sessions/rename", {
      sessionId: this.sessionId,
      title: title.trim(),
    });
    await this.refreshAll();
    await this.loadSession(this.sessionId);
  }

  async refreshLiveBench(): Promise<void> {
    await this.start();
    const card = this.chat.addToolCard({
      type: "benchmark",
      title: "LiveBench refresh",
      status: "running",
      detail: "Downloading leaderboard files...",
    });
    try {
      const result = (await this.peer!.request(
        "connector/benchmarks/livebench/refresh",
        {},
        60_000,
      )) as {
        enabled?: boolean;
        release?: string;
        source?: string;
        modelCount?: number;
        categories?: string[];
      };
      this.chat.updateToolCard(card.id, {
        status: "done",
        detail: result.enabled
          ? `Release ${result.release} from ${result.source}. ${result.modelCount ?? 0} models, ${(result.categories ?? []).join(", ")}.`
          : "LiveBench is disabled in config.",
      });
    } catch (error) {
      this.chat.updateToolCard(card.id, {
        status: "error",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async login(agentName?: string): Promise<void> {
    await this.runAuth("login", agentName);
  }

  async deviceLogin(agentName?: string): Promise<void> {
    await this.runAuth("device-login", agentName);
  }

  async authStatus(agentName?: string): Promise<void> {
    await this.runAuth("status", agentName);
  }

  async logout(agentName?: string): Promise<void> {
    await this.runAuth("logout", agentName);
  }

  async retry(): Promise<void> {
    if (this.lastPrompt) {
      this.chat.setMode(this.lastMode);
      this.chat.setResponseLanguage(this.lastResponseLanguage);
      await this.sendPrompt(this.lastPrompt, this.lastAttachments);
    }
  }

  async inspectContext(): Promise<void> {
    if (!this.peer || !this.sessionId) {
      await vscode.window.showInformationMessage(
        "No active CLI Agent Connector session.",
      );
      return;
    }
    const context = await this.peer.request("sessions/inspect", {
      sessionId: this.sessionId,
    });
    const doc = await vscode.workspace.openTextDocument({
      language: "json",
      content: JSON.stringify(context, null, 2),
    });
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  openLogs(): void {
    this.output.show(true);
  }

  async handleChatMessage(message: unknown): Promise<void> {
    const record =
      message && typeof message === "object"
        ? (message as Record<string, unknown>)
        : {};
    try {
      switch (record.type) {
        case "webviewReady":
          return;
        case "webviewBootstrap":
          return;
        case "stateReceived":
          return;
        case "webviewError":
          this.output.appendLine(
            `[webview] error during ${stringValue(record.phase) ?? "unknown"}: ${stringValue(record.message) ?? "unknown error"}`,
          );
          if (typeof record.stack === "string" && record.stack) {
            this.output.appendLine(record.stack);
          }
          this.chat.setError(
            `Webview error: ${stringValue(record.message) ?? "unknown error"}`,
          );
          return;
        case "ready":
          await this.initializeChatView();
          return;
        case "send":
          if (typeof record.text === "string") {
            if (
              record.mode === "agent" ||
              record.mode === "ask" ||
              record.mode === "plan"
            ) {
              this.chat.setMode(record.mode);
            }
            if (
              record.responseLanguage === "auto" ||
              record.responseLanguage === "en" ||
              record.responseLanguage === "vi"
            ) {
              this.chat.setResponseLanguage(record.responseLanguage);
            }
            await this.sendPrompt(record.text, this.chat.attachments);
          }
          return;
        case "setMode":
          if (
            record.mode === "agent" ||
            record.mode === "ask" ||
            record.mode === "plan"
          ) {
            this.chat.setMode(record.mode);
          }
          return;
        case "setResponseLanguage":
          if (
            record.responseLanguage === "auto" ||
            record.responseLanguage === "en" ||
            record.responseLanguage === "vi"
          ) {
            this.chat.setResponseLanguage(record.responseLanguage);
          }
          return;
        case "stop":
          await this.cancel();
          return;
        case "retry":
          await this.retry();
          return;
        case "newSession":
          await this.newSession(this.activeAgent);
          return;
        case "renameSession":
          await this.renameSession();
          return;
        case "refreshLiveBench":
          await this.refreshLiveBench();
          return;
        case "switchAgent":
          if (typeof record.agentName === "string") {
            await this.switchAgent(record.agentName);
          }
          return;
        case "switchModel":
          if (
            typeof record.agentName === "string" &&
            typeof record.modelId === "string"
          ) {
            await this.switchModel(record.agentName, record.modelId);
          }
          return;
        case "selectSession":
          if (typeof record.sessionId === "string") {
            await this.loadSession(record.sessionId);
          }
          return;
        case "attachCurrentFile":
          await this.attachCurrentFile();
          return;
        case "attachSelection":
          await this.attachSelection();
          return;
        case "attachFile":
          await this.attachPickedFiles(false);
          return;
        case "attachFolder":
          await this.attachPickedFiles(true);
          return;
        case "attachOpenEditors":
          await this.attachOpenEditors();
          return;
        case "removeAttachment":
          if (typeof record.id === "string") {
            this.chat.removeAttachment(record.id);
          }
          return;
        case "applyWrite":
          if (typeof record.id === "string") {
            await this.resolveWriteRequest(record.id, true);
          }
          return;
        case "rejectWrite":
          if (typeof record.id === "string") {
            await this.resolveWriteRequest(record.id, false);
          }
          return;
        case "applyPatch":
          if (typeof record.id === "string") {
            await this.applyPatchProposal(record.id);
          }
          return;
        case "rejectPatch":
          if (typeof record.id === "string") {
            this.chat.updateToolCard(record.id, {
              status: "denied",
              detail: "Rejected.",
            });
          }
          return;
        case "approveFailover":
          if (typeof record.id === "string") {
            await this.peer?.request("connector/failover/approve", {
              proposalId: record.id,
            });
            this.chat.updateToolCard(record.id, {
              status: "approved",
              detail: "Switched.",
            });
          }
          return;
        case "clearView":
          this.chat.setTranscript([]);
          return;
        case "openLogs":
          this.openLogs();
          return;
      }
    } catch (error) {
      this.chat.appendError(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async refreshAgents(): Promise<void> {
    if (!this.peer) {
      this.onAgentsChanged([]);
      this.chat.setAgents([]);
      return;
    }
    try {
      const agents = (await this.peer.request(
        "connector/agents/list",
        {},
      )) as AgentView[];
      if (
        agents.length &&
        !agents.some((agent) => agent.name === this.activeAgent)
      ) {
        this.activeAgent =
          agents.find((agent) => agent.enabled)?.name ?? agents[0].name;
      }
      this.onAgentsChanged(agents);
      this.chat.setAgents(agents);
    } catch (error) {
      this.output.appendLine(
        `Refresh agents failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async dispose(): Promise<void> {
    await this.stop();
  }

  async stop(): Promise<void> {
    if (!this.child) {
      this.peer = undefined;
      return;
    }
    this.intentionallyStoppedChildren.add(this.child);
    this.child.kill("SIGTERM");
    this.child = undefined;
    this.peer = undefined;
  }

  async handleWorkspaceChanged(): Promise<void> {
    await this.stop();
    this.chatInitialized = false;
    this.chatInitialization = undefined;
    this.sessionId = undefined;
    this.lastPrompt = undefined;
    this.lastAttachments = [];
    this.lastMode = "agent";
    this.lastResponseLanguage = "auto";
    this.activeAgent = undefined;
    this.pendingWrites.clear();
    this.patchProposals.clear();
    this.chat.setAgents([]);
    this.chat.setSessions([]);
    this.chat.setTranscript([]);
    this.chat.setAttachments([]);
    this.chat.setActive(undefined, undefined);
    this.chat.setModelSelection(undefined);
    this.chat.setMode("agent");
    this.chat.setResponseLanguage("auto");
    this.chat.setError(undefined);
    this.output.appendLine(`Workspace changed: ${this.workspaceFolder()}`);
  }

  private async refreshAll(): Promise<void> {
    await this.refreshAgents();
    await this.refreshSessions();
    this.chat.setActive(this.sessionId, this.activeAgent);
  }

  private async initializeChatView(): Promise<void> {
    if (!this.chatInitialized) {
      if (!this.chatInitialization) {
        this.chatInitialization = (async () => {
          await this.start();
          await this.refreshAll();
          await this.loadLatestSession();
          this.chatInitialized = true;
        })();
      }
      try {
        await this.chatInitialization;
      } catch (error) {
        this.output.appendLine(
          `Initialize chat view failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        this.chatInitialization = undefined;
        throw error;
      }
    }
    this.chat.syncState();
  }

  private async refreshSessions(): Promise<void> {
    if (!this.peer) {
      this.chat.setSessions([]);
      return;
    }
    const sessions = (await this.peer.request(
      "sessions/list",
      {},
    )) as LogicalSessionState[];
    this.chat.setSessions(sessions);
  }

  private async loadLatestSession(): Promise<void> {
    if (!this.peer) {
      return;
    }
    const sessions = (await this.peer.request(
      "sessions/list",
      {},
    )) as LogicalSessionState[];
    this.chat.setSessions(sessions);
    if (!this.sessionId && sessions[0]) {
      await this.loadSession(sessions[0].id);
    }
  }

  private async loadSession(sessionId: string): Promise<void> {
    if (!this.peer) {
      return;
    }
    const session = (await this.peer.request("sessions/inspect", {
      sessionId,
    })) as LogicalSessionState;
    this.sessionId = session.id;
    this.activeAgent = session.activeAgent;
    this.chat.setSession(session);
  }

  private workspaceFolder(): string {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceFolder) {
      return workspaceFolder;
    }
    if (this.context.extensionUri.scheme === "file") {
      return this.context.extensionUri.fsPath;
    }
    return process.cwd();
  }

  private resolveCommand(
    command: string,
    args: string[],
  ): { command: string; args: string[] } {
    if (command !== "cli-agent-connector") {
      return { command, args };
    }
    const localCli = join(this.context.extensionUri.fsPath, "dist", "cli.js");
    if (existsSync(localCli)) {
      return { command: process.execPath, args: [localCli, ...args] };
    }
    return { command, args };
  }

  private missingConfigPath(
    args: string[],
    workspaceFolder: string,
  ): string | undefined {
    const configFlagIndex = args.indexOf("--config");
    if (configFlagIndex < 0) {
      return undefined;
    }
    const configPath = args[configFlagIndex + 1];
    if (!configPath) {
      return undefined;
    }
    const resolvedConfigPath = resolve(workspaceFolder, configPath);
    return existsSync(resolvedConfigPath) ? undefined : resolvedConfigPath;
  }

  private registerPeerHandlers(peer: JsonRpcPeer): void {
    peer.onNotification("session/update", (params) => {
      const text = extractText(params);
      if (text) {
        this.output.append(text);
        this.currentTurnOutput += text;
        this.chat.appendAgentChunk(text);
      }
    });
    peer.onNotification("connector/failover_proposal", (params) => {
      this.handleFailoverProposal(params as FailoverProposal);
    });
    peer.onNotification("connector/mentor_context", (params) => {
      this.handleMentorContext(params);
    });
    peer.onNotification("connector/agent_switched", (params) => {
      const record = params as {
        fromAgent?: string;
        toAgent?: string;
        reason?: string;
      };
      this.activeAgent = record.toAgent;
      this.chat.setActive(this.sessionId, record.toAgent);
      this.output.appendLine(
        `\nSwitched agent: ${record.fromAgent} -> ${record.toAgent} (${record.reason})`,
      );
      void this.refreshAll();
    });
    peer.onNotification("connector/auth_update", (params) => {
      void this.handleAuthUpdate(params);
    });
    peer.onRequest(
      "session/request_permission",
      async (params) => await this.requestPermission(params),
    );
    peer.onRequest(
      "fs/read_text_file",
      async (params) => await this.readTextFile(params),
    );
    peer.onRequest(
      "fs/write_text_file",
      async (params) => await this.writeTextFile(params),
    );
    peer.onRequest(
      "terminal/execute",
      async (params) => await this.executeTerminal(params),
    );
  }

  private async runAuth(
    action: "login" | "device-login" | "status" | "logout",
    agentName?: string,
  ): Promise<void> {
    await this.start();
    const picked = agentName ?? (await this.pickAgentForAuth(action));
    if (!picked) {
      return;
    }
    this.output.show(true);
    this.output.appendLine(`\n[auth] ${action} ${picked}\n`);
    const card = this.chat.addToolCard({
      type: "auth",
      title: `Auth: ${action} ${picked}`,
      status: "running",
    });
    const method = `connector/auth/${action}`;
    const result = (await this.peer!.request(
      method,
      { agentName: picked },
      10 * 60_000,
    )) as {
      status?: string;
      message?: string;
      urls?: string[];
    };
    this.chat.updateToolCard(card.id, {
      status: result.status === "succeeded" ? "done" : "error",
      detail: result.message ?? result.status,
    });
    if (result.urls?.length) {
      await this.offerOpenUrls(result.urls);
    }
    await this.refreshAll();
  }

  private async pickAgentForAuth(
    action: "login" | "device-login" | "status" | "logout",
  ): Promise<string | undefined> {
    const agents = (await this.peer!.request(
      "connector/agents/list",
      {},
    )) as AgentView[];
    return (
      await vscode.window.showQuickPick(
        agents
          .filter(
            (agent) => agent.auth?.configured && hasAuthAction(agent, action),
          )
          .map((agent) => ({
            label: agent.name,
            description: `${agent.driver} · ${agent.health.status}`,
            detail: agent.persona,
            agent,
          })),
        { title: `Choose agent for ${action}` },
      )
    )?.agent.name;
  }

  private async handleAuthUpdate(params: unknown): Promise<void> {
    const record =
      params && typeof params === "object"
        ? (params as {
            text?: string;
            urls?: string[];
            stream?: string;
            action?: string;
          })
        : {};
    if (record.text) {
      this.output.append(
        record.stream === "lifecycle" ? `${record.text}\n` : record.text,
      );
      this.chat.addToolCard({
        type: "auth",
        title: `Auth update${record.action ? `: ${record.action}` : ""}`,
        status: "done",
        detail: record.text,
      });
    }
    if (record.urls?.length) {
      await this.offerOpenUrls(record.urls);
    }
  }

  private async offerOpenUrls(urls: string[]): Promise<void> {
    for (const url of urls) {
      if (this.openedAuthUrls.has(url)) {
        continue;
      }
      this.openedAuthUrls.add(url);
      const answer = await vscode.window.showInformationMessage(
        "Open CLI agent login URL in your browser?",
        "Open Browser",
        "Copy URL",
      );
      if (answer === "Open Browser") {
        await vscode.env.openExternal(vscode.Uri.parse(url));
      } else if (answer === "Copy URL") {
        await vscode.env.clipboard.writeText(url);
      }
    }
  }

  private handleFailoverProposal(proposal: FailoverProposal): void {
    this.chat.addToolCard({
      id: proposal.id,
      type: "failover",
      title: `Switch ${proposal.fromAgent} -> ${proposal.toAgent}`,
      status: "pending",
      detail: `${proposal.capacityKind}\n${proposal.reason}\n\n${proposal.handoffSummary.slice(0, 1200)}`,
      actions: ["approveFailover", "rejectPatch"],
    });
  }

  private handleMentorContext(params: unknown): void {
    const record =
      params && typeof params === "object"
        ? (params as {
            teacherAgent?: string;
            teacherModel?: string;
            studentAgent?: string;
            studentModel?: string;
            category?: string;
            scoreGap?: number;
            guidance?: string;
          })
        : {};
    this.chat.addToolCard({
      type: "mentor",
      title: `Mentor: ${record.teacherAgent ?? "teacher"} -> ${record.studentAgent ?? "student"}`,
      status: "done",
      detail: [
        `${record.category ?? "category"} gap ${typeof record.scoreGap === "number" ? record.scoreGap.toFixed(1) : "?"}`,
        `${record.teacherModel ?? ""} -> ${record.studentModel ?? ""}`.trim(),
        "",
        record.guidance ?? "",
      ]
        .filter((item) => item !== undefined)
        .join("\n"),
    });
  }

  private async requestPermission(params: unknown): Promise<unknown> {
    const text = JSON.stringify(params, null, 2).slice(0, 1600);
    const card = this.chat.addToolCard({
      type: "permission",
      title: "Permission requested",
      status: "pending",
      detail: text,
    });
    const answer = await vscode.window.showWarningMessage(
      `Agent requests permission:\n${text}`,
      { modal: true },
      "Allow",
      "Deny",
    );
    const approved = answer === "Allow";
    this.chat.updateToolCard(card.id, {
      status: approved ? "approved" : "denied",
    });
    return approved
      ? { outcome: "approved" }
      : { outcome: "denied", reason: "User denied permission." };
  }

  private async readTextFile(params: unknown): Promise<unknown> {
    const filePath = pathFromParams(params);
    if (!filePath || !this.isInsideWorkspace(filePath)) {
      throw new Error("Blocked file read outside the current workspace.");
    }
    const card = this.chat.addToolCard({
      type: "read",
      title: `Read ${relative(this.workspaceFolder(), filePath)}`,
      status: "running",
    });
    try {
      const content = await readFile(filePath, "utf8");
      this.chat.updateToolCard(card.id, {
        status: "done",
        detail: `${content.length} chars`,
      });
      return { content };
    } catch (error) {
      this.chat.updateToolCard(card.id, {
        status: "error",
        detail: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async writeTextFile(params: unknown): Promise<unknown> {
    const record =
      params && typeof params === "object"
        ? (params as Record<string, unknown>)
        : {};
    const filePath = pathFromParams(params);
    if (!filePath || !this.isInsideWorkspace(filePath)) {
      throw new Error("Blocked file write outside the current workspace.");
    }
    const content =
      typeof record.content === "string"
        ? record.content
        : typeof record.text === "string"
          ? record.text
          : "";
    const oldContent = await readFile(filePath, "utf8").catch(() => "");
    const relativePath = relative(this.workspaceFolder(), filePath);
    const card = this.chat.addToolCard({
      type: "write",
      title: `Write ${relativePath}`,
      status: "pending",
      detail: "Review the proposed file change.",
      diff: buildTextDiff(oldContent, content, relativePath),
      actions: ["applyWrite", "rejectWrite"],
    });
    await this.chat.reveal();
    return await new Promise((resolvePromise) => {
      this.pendingWrites.set(card.id, {
        filePath,
        content,
        resolve: resolvePromise,
      });
    });
  }

  private async executeTerminal(params: unknown): Promise<unknown> {
    const record =
      params && typeof params === "object"
        ? (params as Record<string, unknown>)
        : {};
    const command =
      typeof record.command === "string" ? record.command : undefined;
    const args = Array.isArray(record.args)
      ? record.args.filter((item): item is string => typeof item === "string")
      : [];
    if (!command) {
      throw new Error("terminal/execute requires command.");
    }
    const card = this.chat.addToolCard({
      type: "terminal",
      title: `Run ${command} ${args.join(" ")}`,
      status: "pending",
    });
    const answer = await vscode.window.showWarningMessage(
      `Allow agent to run: ${command} ${args.join(" ")}`,
      { modal: true },
      "Allow",
      "Deny",
    );
    if (answer !== "Allow") {
      this.chat.updateToolCard(card.id, {
        status: "denied",
        detail: "User denied terminal command.",
      });
      return { outcome: "denied", reason: "User denied terminal command." };
    }
    this.chat.updateToolCard(card.id, { status: "running" });
    return await new Promise((resolvePromise) => {
      execFile(
        command,
        args,
        {
          cwd: this.workspaceFolder(),
          timeout: 120_000,
          maxBuffer: 1024 * 1024,
        },
        (error, stdout, stderr) => {
          this.chat.updateToolCard(card.id, {
            status: error ? "error" : "done",
            detail: `${stdout}${stderr ? `\n${stderr}` : ""}`.slice(0, 4000),
          });
          resolvePromise({
            outcome: error ? "failed" : "completed",
            exitCode: error && "code" in error ? error.code : 0,
            stdout,
            stderr,
          });
        },
      );
    });
  }

  private async resolveWriteRequest(id: string, apply: boolean): Promise<void> {
    const pending = this.pendingWrites.get(id);
    if (!pending) {
      return;
    }
    this.pendingWrites.delete(id);
    if (!apply) {
      this.chat.updateToolCard(id, { status: "denied", detail: "Rejected." });
      pending.resolve({
        outcome: "denied",
        reason: "User rejected file write.",
      });
      return;
    }
    await writeFile(pending.filePath, pending.content, "utf8");
    this.chat.updateToolCard(id, { status: "approved", detail: "Applied." });
    pending.resolve({ outcome: "approved" });
  }

  private addDiffProposalCards(proposals: DiffProposal[]): void {
    for (const proposal of proposals) {
      if (this.patchProposals.has(proposal.id)) {
        continue;
      }
      this.patchProposals.set(proposal.id, proposal);
      this.chat.addToolCard({
        id: proposal.id,
        type: "diff",
        title: proposal.title,
        status: "pending",
        detail: proposal.applicable
          ? "Patch can be applied with review."
          : "Patch target is unsafe or unknown. Copy manually.",
        diff: proposal.diff,
        actions: proposal.applicable
          ? ["applyPatch", "rejectPatch"]
          : ["rejectPatch"],
      });
    }
  }

  private async applyPatchProposal(id: string): Promise<void> {
    const proposal = this.patchProposals.get(id);
    if (!proposal || !proposal.applicable) {
      return;
    }
    this.chat.updateToolCard(id, {
      status: "running",
      detail: "Applying patch...",
    });
    const result = await runWithInput(
      "git",
      ["apply", "--whitespace=nowarn"],
      proposal.diff,
      this.workspaceFolder(),
    );
    this.chat.updateToolCard(id, {
      status: result.exitCode === 0 ? "approved" : "error",
      detail:
        result.exitCode === 0
          ? "Applied."
          : result.stderr ||
            result.stdout ||
            `git apply exited ${result.exitCode}`,
    });
  }

  private async attachCurrentFile(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      this.chat.setError("No active editor.");
      return;
    }
    this.chat.addAttachments([
      this.attachmentFromDocument(editor.document, "file"),
    ]);
  }

  private async attachSelection(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      this.chat.setError("No active selection.");
      return;
    }
    this.chat.addAttachments([
      this.attachmentFromDocument(
        editor.document,
        "selection",
        editor.selection,
      ),
    ]);
  }

  private async attachPickedFiles(folder: boolean): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: !folder,
      canSelectFolders: folder,
      canSelectMany: true,
      openLabel: folder ? "Attach Folder" : "Attach File",
    });
    if (!picked?.length) {
      return;
    }
    const attachments: PromptAttachment[] = [];
    for (const uri of picked) {
      attachments.push(
        ...(folder
          ? await this.attachmentsFromFolder(uri.fsPath)
          : [await this.attachmentFromFile(uri.fsPath, "file")]),
      );
    }
    this.chat.addAttachments(attachments);
  }

  private async attachOpenEditors(): Promise<void> {
    const attachments = vscode.workspace.textDocuments
      .filter(
        (document) => document.uri.scheme === "file" && !document.isUntitled,
      )
      .slice(0, 20)
      .map((document) => this.attachmentFromDocument(document, "open-editor"));
    this.chat.addAttachments(attachments);
  }

  private attachmentFromDocument(
    document: vscode.TextDocument,
    kind: PromptAttachment["kind"],
    range?: vscode.Range,
  ): PromptAttachment {
    const text = range ? document.getText(range) : document.getText();
    return makeAttachment({
      kind,
      label: range
        ? `${basename(document.uri.fsPath)} ${range.start.line + 1}:${range.start.character + 1}-${range.end.line + 1}:${range.end.character + 1}`
        : basename(document.uri.fsPath),
      path: document.uri.fsPath,
      range: range
        ? `${range.start.line + 1}:${range.start.character + 1}-${range.end.line + 1}:${range.end.character + 1}`
        : undefined,
      content: text,
    });
  }

  private async attachmentFromFile(
    filePath: string,
    kind: PromptAttachment["kind"],
  ): Promise<PromptAttachment> {
    try {
      const content = await readFile(filePath, "utf8");
      if (looksBinary(content)) {
        return makeAttachment({
          kind: "unsupported",
          label: basename(filePath),
          path: filePath,
        });
      }
      return makeAttachment({
        kind,
        label: relative(this.workspaceFolder(), filePath) || basename(filePath),
        path: filePath,
        content,
      });
    } catch {
      return makeAttachment({
        kind: "unsupported",
        label: basename(filePath),
        path: filePath,
      });
    }
  }

  private async attachmentsFromFolder(
    folderPath: string,
  ): Promise<PromptAttachment[]> {
    const files = await collectTextFiles(folderPath, 30);
    const attachments: PromptAttachment[] = [];
    for (const filePath of files) {
      attachments.push(await this.attachmentFromFile(filePath, "folder"));
    }
    return attachments;
  }

  private isInsideWorkspace(filePath: string): boolean {
    const root = resolve(this.workspaceFolder());
    const target = resolve(filePath);
    return target === root || target.startsWith(`${root}/`);
  }
}

class AgentChatViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private cspSource = "";
  private readonly state: ChatState = {
    agents: [],
    sessions: [],
    transcript: [],
    attachments: [],
    toolCards: [],
    mode: "agent",
    responseLanguage: "auto",
    busy: false,
  };

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly onMessage: (message: unknown) => Promise<void>,
    private readonly log: (message: string) => void,
  ) {}

  get attachments(): PromptAttachment[] {
    return this.state.attachments;
  }

  get mode(): AgentMode {
    return this.state.mode;
  }

  get responseLanguage(): ResponseLanguage {
    return this.state.responseLanguage;
  }

  currentSessionTitle(): string | undefined {
    return this.state.sessions.find(
      (session) => session.id === this.state.activeSessionId,
    )?.title;
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    this.cspSource = webviewView.webview.cspSource;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };
    webviewView.webview.onDidReceiveMessage((message) => {
      void this.onMessage(message);
    });
    // Register before assigning HTML: the webview sends "ready" as it loads.
    // Registering afterwards can lose that handshake and leave Chat unhydrated.
    webviewView.webview.html = this.html(webviewView.webview);
    this.post({ type: "state", state: this.state });
    webviewView.onDidDispose(() => {
      if (this.view === webviewView) {
        this.view = undefined;
      }
    });
  }

  async reveal(): Promise<void> {
    await vscode.commands.executeCommand("cliAgentConnector.chat.focus");
  }

  setAgents(agents: AgentView[]): void {
    this.state.agents = agents;
    if (
      agents.length &&
      !agents.some((agent) => agent.name === this.state.activeAgent)
    ) {
      this.state.activeAgent =
        agents.find((agent) => agent.enabled)?.name ?? agents[0].name;
    }
    this.postState();
  }

  setSessions(sessions: LogicalSessionState[]): void {
    this.state.sessions = sessions.map((session) => ({
      id: session.id,
      title: session.title,
      titleSource: session.titleSource,
      activeAgent: session.activeAgent,
      activeModelByAgent: session.activeModelByAgent,
      modelSelectionByAgent: session.modelSelectionByAgent,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      currentTurnState: session.currentTurnState,
    }));
    this.postState();
  }

  setSession(session: LogicalSessionState): void {
    this.state.activeSessionId = session.id;
    this.state.activeAgent = session.activeAgent;
    this.state.activeModelByAgent = session.activeModelByAgent;
    this.state.modelSelectionByAgent = session.modelSelectionByAgent;
    this.state.transcript = session.transcript;
    this.state.busy = session.currentTurnState === "running";
    this.postState();
  }

  setActive(sessionId?: string, agentName?: string): void {
    this.state.activeSessionId = sessionId;
    this.state.activeAgent = agentName;
    this.postState();
  }

  setModelSelection(selection?: Record<string, string>): void {
    this.state.modelSelectionByAgent = selection;
    this.postState();
  }

  setTranscript(transcript: LogicalMessage[]): void {
    this.state.transcript = transcript;
    this.postState();
  }

  setAttachments(attachments: PromptAttachment[]): void {
    this.state.attachments = attachments;
    this.postState();
  }

  setMode(mode: AgentMode): void {
    this.state.mode = mode;
    this.postState();
  }

  setResponseLanguage(responseLanguage: ResponseLanguage): void {
    this.state.responseLanguage = responseLanguage;
    this.postState();
  }

  addAttachments(attachments: PromptAttachment[]): void {
    const existing = new Set(
      this.state.attachments.map((attachment) => attachment.id),
    );
    this.state.attachments = [
      ...this.state.attachments,
      ...attachments.filter((attachment) => !existing.has(attachment.id)),
    ].slice(0, 60);
    this.postState();
  }

  removeAttachment(id: string): void {
    this.state.attachments = this.state.attachments.filter(
      (attachment) => attachment.id !== id,
    );
    this.postState();
  }

  setBusy(busy: boolean): void {
    this.state.busy = busy;
    this.postState();
  }

  setError(error?: string): void {
    this.state.error = error;
    this.postState();
  }

  syncState(): void {
    this.postState();
  }

  appendLocalUserMessage(text: string, attachments: PromptAttachment[]): void {
    this.state.transcript = [
      ...this.state.transcript,
      {
        role: "user",
        text,
        attachments,
        at: new Date().toISOString(),
      },
    ];
    this.postState();
  }

  appendAgentChunk(text: string): void {
    this.post({ type: "chunk", text });
  }

  startAgentMessage(): void {
    this.post({ type: "start" });
  }

  finishAgentMessage(): void {
    this.post({ type: "finish" });
  }

  appendError(text: string): void {
    this.addToolCard({
      type: "error",
      title: "Error",
      status: "error",
      detail: text,
    });
  }

  addToolCard(input: Omit<ToolCard, "id"> & { id?: string }): ToolCard {
    const card: ToolCard = {
      id:
        input.id ??
        `tool_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      type: input.type,
      title: input.title,
      status: input.status,
      detail: input.detail,
      diff: input.diff,
      actions: input.actions,
    };
    this.state.toolCards = [card, ...this.state.toolCards].slice(0, 30);
    this.postState();
    return card;
  }

  updateToolCard(id: string, patch: Partial<ToolCard>): void {
    this.state.toolCards = this.state.toolCards.map((card) =>
      card.id === id ? { ...card, ...patch } : card,
    );
    this.postState();
  }

  private postState(): void {
    this.post({ type: "state", state: this.state });
  }

  private post(message: unknown): void {
    if (!this.view) {
      return;
    }
    void this.view.webview.postMessage(message).then(
      () => undefined,
      (error) =>
        this.log(
          `Webview post failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
    );
  }

  private html(webview: vscode.Webview): string {
    const scriptSource = this.webviewScriptSource();
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${this.cspSource} data: https:; style-src ${this.cspSource} 'unsafe-inline'; script-src ${this.cspSource} 'unsafe-inline';">
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    html {
      height: 100%;
      overflow: hidden;
    }
    body {
      margin: 0;
      height: 100vh;
      min-height: 0;
      overflow: hidden;
      display: grid;
      grid-template-rows: auto auto minmax(0, 1fr) auto;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
    }
    button, select, textarea { font: inherit; }
    button {
      height: 26px;
      padding: 0 8px;
      border: 1px solid transparent;
      border-radius: 4px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      cursor: pointer;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button:disabled { opacity: .55; cursor: default; }
    button.secondary {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button.ghost {
      color: var(--vscode-foreground);
      background: transparent;
      border-color: transparent;
    }
    button.ghost:hover { background: var(--vscode-toolbar-hoverBackground); }
    select, textarea {
      min-width: 0;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 4px;
      outline: none;
    }
    select:focus, textarea:focus { border-color: var(--vscode-focusBorder); }
    select { height: 26px; padding: 0 6px; }
    .topbar {
      display: grid;
      gap: 8px;
      padding: 8px 10px;
      border-bottom: 1px solid var(--vscode-sideBar-border);
      background: var(--vscode-sideBar-background);
    }
    .bar-row { display: flex; gap: 6px; align-items: center; min-width: 0; }
    .bar-row.wrap { flex-wrap: wrap; }
    .brand { display: flex; align-items: center; gap: 7px; min-width: 0; margin-right: auto; font-weight: 600; }
    .spark {
      width: 16px; height: 16px; display: grid; place-items: center;
      border-radius: 4px; color: var(--vscode-badge-foreground); background: var(--vscode-badge-background);
      font-size: 11px;
    }
    .select-stack { display: grid; grid-template-columns: 1fr; gap: 6px; width: 100%; }
    #agent, #model, #session, #mode, #responseLanguage { width: 100%; }
    .statusline {
      display: flex; align-items: center; gap: 6px; min-height: 18px;
      color: var(--vscode-descriptionForeground); font-size: 11px; overflow: hidden;
    }
    .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--vscode-testing-iconPassed); flex: 0 0 auto; }
    .dot.bad { background: var(--vscode-errorForeground); }
    .dot.warn { background: var(--vscode-charts-yellow); }
    .muted { color: var(--vscode-descriptionForeground); }
    #error {
      display: none;
      padding: 7px 10px;
      color: var(--vscode-errorForeground);
      background: var(--vscode-inputValidation-errorBackground);
      border-bottom: 1px solid var(--vscode-inputValidation-errorBorder);
      line-height: 1.35;
    }
    #error.visible { display: block; }
    .messages-section {
      min-height: 0;
      overflow: hidden;
      background: var(--vscode-editor-background);
    }
    #messages {
      height: 100%;
      min-height: 0;
      overflow-y: auto;
      overflow-x: hidden;
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 12px 10px 14px;
      background: var(--vscode-editor-background);
    }
    .empty {
      margin: auto;
      width: 100%;
      max-width: 340px;
      display: grid;
      gap: 12px;
      color: var(--vscode-descriptionForeground);
      line-height: 1.45;
    }
    .empty-title { color: var(--vscode-foreground); font-weight: 600; font-size: 14px; }
    .suggestions { display: grid; gap: 6px; }
    .suggestion {
      height: auto;
      min-height: 30px;
      padding: 6px 8px;
      text-align: left;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      border-color: var(--vscode-panel-border);
    }
    .message {
      display: grid;
      gap: 7px;
      padding: 0 0 0 24px;
      position: relative;
      line-height: 1.45;
    }
    .avatar {
      position: absolute; left: 0; top: 0;
      width: 17px; height: 17px; border-radius: 4px;
      display: grid; place-items: center;
      font-size: 10px; font-weight: 600;
      color: var(--vscode-badge-foreground);
      background: var(--vscode-badge-background);
    }
    .message.user .avatar { background: var(--vscode-button-background); }
    .message.system .avatar, .message.error .avatar { background: var(--vscode-inputValidation-warningBackground); color: var(--vscode-foreground); }
    .meta { display: flex; justify-content: space-between; gap: 8px; color: var(--vscode-descriptionForeground); font-size: 11px; min-width: 0; }
    .role { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bubble {
      display: grid;
      gap: 7px;
      padding: 8px;
      border: 1px solid transparent;
      border-radius: 6px;
      background: transparent;
    }
    .message.user .bubble {
      background: var(--vscode-input-background);
      border-color: var(--vscode-panel-border);
    }
    .message.tool .bubble {
      background: var(--vscode-sideBar-background);
      border-color: var(--vscode-panel-border);
      border-left: 3px solid var(--vscode-focusBorder);
    }
    .message.tool.pending .bubble, .message.tool.running .bubble { border-left-color: var(--vscode-charts-yellow); }
    .message.tool.error .bubble { border-left-color: var(--vscode-errorForeground); }
    .message.tool.approved .bubble, .message.tool.done .bubble { border-left-color: var(--vscode-testing-iconPassed); }
    .text { white-space: pre-wrap; overflow-wrap: anywhere; }
    .attachments, #attachments { display: flex; flex-wrap: wrap; gap: 5px; min-width: 0; }
    .chip {
      display: inline-flex; align-items: center; gap: 5px; max-width: 100%;
      min-height: 22px; padding: 2px 6px; border-radius: 4px;
      border: 1px solid var(--vscode-panel-border);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      overflow: hidden;
    }
    .chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .chip button { width: 18px; height: 18px; padding: 0; flex: 0 0 auto; }
    pre {
      margin: 0;
      overflow: auto;
      max-height: 260px;
      padding: 8px;
      border-radius: 4px;
      background: var(--vscode-textCodeBlock-background);
      white-space: pre;
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
    }
    .actions { display: flex; gap: 6px; flex-wrap: wrap; }
    .text h3, .text h4 { margin: 6px 0 3px; font-weight: 600; }
    .text ul, .text ol { margin: 4px 0; padding-left: 18px; }
    .text li { margin: 1px 0; }
    .text code {
      font-family: var(--vscode-editor-font-family);
      font-size: 0.9em;
      padding: 1px 4px;
      border-radius: 3px;
      background: var(--vscode-textCodeBlock-background);
    }
    .text pre { margin: 6px 0; line-height: 1.4; }
    .text pre code { padding: 0; background: none; font-size: inherit; }
    .text blockquote {
      margin: 4px 0;
      padding: 4px 10px;
      border-left: 3px solid var(--vscode-focusBorder);
      color: var(--vscode-descriptionForeground);
    }
    .text p { margin: 4px 0; }
    .text a { color: var(--vscode-textLink-foreground); }
    #composer {
      display: grid;
      gap: 8px;
      padding: 9px 10px 10px;
      border-top: 1px solid var(--vscode-sideBar-border);
      background: var(--vscode-sideBar-background);
    }
    .attachbar { display: flex; gap: 4px; flex-wrap: wrap; }
    .composer-box {
      display: grid;
      gap: 6px;
      padding: 7px;
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 6px;
      background: var(--vscode-input-background);
    }
    textarea {
      min-height: 68px;
      max-height: 170px;
      padding: 0;
      resize: vertical;
      border: 0;
      line-height: 1.45;
      background: transparent;
    }
    textarea:focus { border: 0; }
    .composer-actions { display: flex; gap: 6px; align-items: center; justify-content: space-between; }
    .hint { color: var(--vscode-descriptionForeground); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    /* ── Traffic Lane ── */
    #traffic-lane {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      align-items: center;
      gap: 8px;
      min-height: 58px;
      padding: 6px 10px;
      border-bottom: 1px solid var(--vscode-sideBar-border);
      background: var(--vscode-sideBar-background);
      overflow: hidden;
      position: relative;
    }
    #traffic-lane.hidden { display: none; }
    .road {
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 8px;
      height: 42px;
      padding: 2px 0 5px;
      position: relative;
      overflow-x: auto;
      overflow-y: hidden;
      scrollbar-width: thin;
    }
    .road::before {
      content: "";
      position: absolute;
      top: 50%;
      left: 0;
      right: 0;
      height: 2px;
      margin-top: -1px;
      background: repeating-linear-gradient(90deg, var(--vscode-panel-border) 0, var(--vscode-panel-border) 14px, transparent 14px, transparent 24px);
      opacity: 0.65;
      pointer-events: none;
    }
    .vehicle {
      position: relative;
      flex: 0 0 min(220px, 72vw);
      min-width: 142px;
      max-width: 240px;
      height: 34px;
      display: grid;
      grid-template-columns: 24px minmax(0, 1fr) auto;
      align-items: center;
      gap: 7px;
      padding: 3px 7px 3px 5px;
      border-radius: 8px;
      background: var(--vscode-sideBar-background);
      border: 1px solid var(--vscode-panel-border);
      color: var(--vscode-foreground);
      font-size: 11px;
      text-align: left;
      z-index: 2;
      cursor: pointer;
      transition: border-color 0.15s ease, background 0.15s ease, transform 0.15s ease;
    }
    .vehicle:hover {
      background: var(--vscode-toolbar-hoverBackground);
      border-color: var(--vscode-focusBorder);
    }
    .model-marker {
      width: 22px;
      height: 22px;
      border-radius: 7px;
      display: grid;
      place-items: center;
      color: var(--vscode-badge-foreground);
      background: var(--vscode-badge-background);
      font-weight: 700;
      font-size: 9px;
      line-height: 1;
    }
    .vehicle-text {
      min-width: 0;
      display: grid;
      gap: 1px;
    }
    .model-name,
    .agent-name {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      line-height: 1.15;
      white-space: nowrap;
    }
    .model-name { font-weight: 600; }
    .agent-name { color: var(--vscode-descriptionForeground); font-size: 10px; }
    .model-badges {
      display: flex;
      gap: 3px;
      align-items: center;
      min-width: 0;
    }
    .model-badge {
      max-width: 48px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      padding: 1px 4px;
      border-radius: 5px;
      border: 1px solid var(--vscode-panel-border);
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-editor-background);
      font-size: 9px;
      line-height: 1.25;
    }
    .vehicle.active {
      border-color: var(--vscode-focusBorder);
      background: var(--vscode-editor-background);
      box-shadow: 0 0 0 1px var(--vscode-focusBorder);
      z-index: 3;
    }
    .vehicle.parked { opacity: 0.82; }
    .vehicle.warn .model-marker { background: var(--vscode-inputValidation-warningBackground); color: var(--vscode-foreground); }
    @keyframes model-drive {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(-2px); }
    }
    .vehicle.moving { animation: model-drive 1.15s ease-in-out infinite; }
    .traffic-label {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
      writing-mode: vertical-lr;
      text-orientation: mixed;
      letter-spacing: 0;
      opacity: 0.5;
    }
    .traffic-label.busy { opacity: 1; color: var(--vscode-charts-yellow); }
  </style>
</head>
<body>
  <header class="topbar">
    <div class="bar-row">
      <div class="brand"><span class="spark">AI</span><span>CLI Agents</span></div>
      <button class="ghost" title="Open logs" data-action="openLogs">Logs</button>
    </div>
    <div class="select-stack">
      <select id="agent" title="Active agent"></select>
      <select id="mode" title="Agent mode">
        <option value="agent">Agent mode: Agent</option>
        <option value="ask">Agent mode: Ask</option>
        <option value="plan">Agent mode: Plan</option>
      </select>
      <select id="responseLanguage" title="Response language">
        <option value="auto">Response language: Auto</option>
        <option value="en">Response language: English</option>
        <option value="vi">Response language: Vietnamese</option>
      </select>
      <select id="model" title="Active model"></select>
      <select id="session" title="Chat session"></select>
    </div>
    <div class="statusline"><span id="statusDot" class="dot"></span><span id="statusText">Starting connector...</span></div>
    <div class="bar-row wrap">
      <button data-action="newSession">New Chat</button>
      <button class="secondary" data-action="renameSession">Rename</button>
      <button class="secondary" data-action="refreshLiveBench">Bench</button>
      <button class="secondary" data-action="retry">Retry</button>
      <button class="secondary" data-action="stop">Stop</button>
      <button class="ghost" data-action="clearView">Clear</button>
    </div>
  </header>
  <div id="error"></div>
  <div id="traffic-lane" class="hidden"><div class="traffic-label">MODELS</div><div class="road" id="traffic-road"></div></div>
  <section id="messages-section" class="messages-section"><main id="messages" aria-live="polite"></main></section>
  <section id="composer">
    <div class="attachbar">
      <button class="ghost" title="Attach current file" data-action="attachCurrentFile">File</button>
      <button class="ghost" title="Attach current selection" data-action="attachSelection">Selection</button>
      <button class="ghost" title="Pick files" data-action="attachFile">Pick</button>
      <button class="ghost" title="Attach folder text files" data-action="attachFolder">Folder</button>
      <button class="ghost" title="Attach open editors" data-action="attachOpenEditors">Editors</button>
    </div>
    <div class="composer-box">
      <div id="attachments"></div>
      <textarea id="input" placeholder="Ask the active CLI agent"></textarea>
      <div class="composer-actions"><span class="hint">Ctrl/Cmd+Enter to send</span><button id="send" data-action="send">Send</button></div>
    </div>
  </section>
  <script>
    (function () {
      try {
        var api = acquireVsCodeApi();
        window.__cliAgentConnectorVsCode = api;
        window.__cliAgentConnectorPost = function (message) { api.postMessage(message); };
        window.addEventListener('error', function (event) {
          var target = event && event.target;
          if (target && target.tagName === 'SCRIPT') {
            api.postMessage({
              type: 'webviewError',
              phase: 'script.load',
              message: 'Failed to load webview script: ' + (target.src || 'unknown script'),
              stack: ''
            });
          }
        }, true);
        api.postMessage({
          type: 'webviewBootstrap',
          userAgent: navigator.userAgent
        });
      } catch (error) {
        var errorBox = document.getElementById('error');
        if (errorBox) {
          errorBox.textContent = 'Webview bootstrap failed: ' + (error && error.message ? error.message : String(error));
          errorBox.className = 'visible';
        }
      }
    }());
  </script>
  <script>${escapeInlineScript(scriptSource)}</script>
</body>
</html>`;
  }

  private webviewScriptSource(): string {
    const scriptPath = vscode.Uri.joinPath(
      this.context.extensionUri,
      "dist",
      "webview.js",
    ).fsPath;
    try {
      return normalizeWebviewScriptSource(readFileSync(scriptPath, "utf8"));
    } catch (error) {
      const message = `Failed to read webview script at ${scriptPath}: ${
        error instanceof Error ? error.message : String(error)
      }`;
      this.log(`[webview] ${message}`);
      return `
(function () {
  var message = ${JSON.stringify(message)};
  var errorBox = document.getElementById('error');
  if (errorBox) {
    errorBox.textContent = message;
    errorBox.className = 'visible';
  }
  if (window.__cliAgentConnectorPost) {
    window.__cliAgentConnectorPost({
      type: 'webviewError',
      phase: 'script.read',
      message: message,
      stack: ''
    });
  }
}());
`;
    }
  }
}

class AgentTreeProvider implements vscode.TreeDataProvider<AgentItem> {
  private readonly emitter = new vscode.EventEmitter<
    AgentItem | undefined | null | void
  >();
  readonly onDidChangeTreeData = this.emitter.event;
  private agents: AgentView[] = [];

  setAgents(agents: AgentView[]): void {
    this.agents = agents;
    this.emitter.fire();
  }

  getTreeItem(element: AgentItem): vscode.TreeItem {
    return element;
  }

  getChildren(): AgentItem[] {
    return this.agents.map((agent) => new AgentItem(agent));
  }
}

class AgentItem extends vscode.TreeItem {
  constructor(readonly agent: AgentView) {
    super(agent.name, vscode.TreeItemCollapsibleState.None);
    this.description = `${agent.health.status} · p${agent.priority} · cost ${agent.costHint}`;
    const authActions = agent.auth?.configured
      ? Object.entries(agent.auth.actions)
          .filter(([, enabled]) => enabled)
          .map(([name]) => name)
          .join(", ")
      : "none";
    this.tooltip = [
      agent.persona,
      agent.health.reason,
      `Capabilities: ${agent.capabilities.join(", ")}`,
      `Auth: ${authActions}`,
    ]
      .filter(Boolean)
      .join("\n");
    this.iconPath = new vscode.ThemeIcon(
      agent.health.status === "healthy" ? "circle-filled" : "warning",
    );
    this.contextValue = "cliAgentConnector.agent";
    this.command = {
      command: "cliAgentConnector.openChat",
      title: "Open Agent Chat",
      arguments: [agent.name],
    };
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("CLI Agent Connector");
  const tree = new AgentTreeProvider();
  let client: ConnectorClient;
  const chatView = new AgentChatViewProvider(
    context,
    async (message) => await client.handleChatMessage(message),
    (message) => output.appendLine(message),
  );
  client = new ConnectorClient(context, output, chatView, (agents) =>
    tree.setAgents(agents),
  );

  context.subscriptions.push(
    output,
    vscode.window.registerWebviewViewProvider(
      "cliAgentConnector.chat",
      chatView,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
    vscode.window.registerTreeDataProvider("cliAgentConnector.agents", tree),
    vscode.workspace.onDidChangeWorkspaceFolders(async () =>
      client.handleWorkspaceChanged(),
    ),
    vscode.commands.registerCommand("cliAgentConnector.start", async () =>
      client.start(),
    ),
    vscode.commands.registerCommand("cliAgentConnector.newSession", async () =>
      client.newSession(),
    ),
    vscode.commands.registerCommand(
      "cliAgentConnector.openChat",
      async (agentName?: string) => client.openChat(agentName),
    ),
    vscode.commands.registerCommand("cliAgentConnector.sendPrompt", async () =>
      client.sendPrompt(),
    ),
    vscode.commands.registerCommand("cliAgentConnector.cancel", async () =>
      client.cancel(),
    ),
    vscode.commands.registerCommand(
      "cliAgentConnector.switchAgent",
      async (agentName?: string) => client.switchAgent(agentName),
    ),
    vscode.commands.registerCommand(
      "cliAgentConnector.login",
      async (agentName?: string) => client.login(agentName),
    ),
    vscode.commands.registerCommand(
      "cliAgentConnector.deviceLogin",
      async (agentName?: string) => client.deviceLogin(agentName),
    ),
    vscode.commands.registerCommand(
      "cliAgentConnector.authStatus",
      async (agentName?: string) => client.authStatus(agentName),
    ),
    vscode.commands.registerCommand(
      "cliAgentConnector.logout",
      async (agentName?: string) => client.logout(agentName),
    ),
    vscode.commands.registerCommand("cliAgentConnector.retry", async () =>
      client.retry(),
    ),
    vscode.commands.registerCommand(
      "cliAgentConnector.inspectContext",
      async () => client.inspectContext(),
    ),
    vscode.commands.registerCommand("cliAgentConnector.openLogs", () =>
      client.openLogs(),
    ),
    { dispose: () => void client.dispose() },
  );

  // The Agents tree can activate this extension before the Chat webview exists.
  // Start and refresh here so that tree is populated and its items are usable.
  void client.start().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(`Unable to start CLI Agent Connector: ${message}`);
    chatView.setError(message);
  });
}

export function deactivate(): void {}

function extractText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(extractText).filter(Boolean).join("");
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") {
      return record.text;
    }
    if (Array.isArray(record.content)) {
      return record.content.map(extractText).filter(Boolean).join("");
    }
    if (record.update && typeof record.update === "object") {
      return extractText(record.update);
    }
    if (record.params && typeof record.params === "object") {
      return extractText(record.params);
    }
    if ("sessionUpdate" in record || "type" in record) {
      return "";
    }
    return Object.values(record).map(extractText).filter(Boolean).join("");
  }
  return "";
}

function hasAuthAction(
  agent: AgentView,
  action: "login" | "device-login" | "status" | "logout",
): boolean {
  if (!agent.auth) {
    return false;
  }
  switch (action) {
    case "login":
      return agent.auth.actions.login;
    case "device-login":
      return agent.auth.actions.deviceLogin;
    case "status":
      return agent.auth.actions.status;
    case "logout":
      return agent.auth.actions.logout;
  }
}

function pathFromParams(params: unknown): string | undefined {
  if (!params || typeof params !== "object") {
    return undefined;
  }
  const record = params as Record<string, unknown>;
  const raw =
    typeof record.path === "string"
      ? record.path
      : typeof record.filePath === "string"
        ? record.filePath
        : typeof record.uri === "string"
          ? record.uri.replace(/^file:\/\//, "")
          : undefined;
  return raw ? resolve(raw) : undefined;
}

function makeAttachment(input: {
  kind: PromptAttachment["kind"];
  label: string;
  path?: string;
  range?: string;
  content?: string;
}): PromptAttachment {
  const content = input.content ? input.content.slice(0, 24_000) : undefined;
  return {
    id: `att_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    kind: input.kind,
    label: input.label,
    path: input.path,
    range: input.range,
    content,
    truncated: Boolean(
      input.content && content && content.length < input.content.length,
    ),
  };
}

function looksBinary(content: string): boolean {
  return (
    content.includes("\u0000") ||
    /[\u0001-\u0008\u000B\u000C\u000E-\u001F]/.test(content.slice(0, 1000))
  );
}

function escapeInlineScript(source: string): string {
  return source
    .replace(/<\/script/gi, "<\\/script")
    .replace(/<!--/g, "<\\!--");
}

function normalizeWebviewScriptSource(source: string): string {
  return source
    .replace(/\nexport\s*\{\};\s*/g, "\n")
    .replace(/\n\/\/# sourceMappingURL=.*\s*$/g, "\n");
}

async function collectTextFiles(
  root: string,
  limit: number,
): Promise<string[]> {
  const output: string[] = [];
  async function visit(dir: string): Promise<void> {
    if (output.length >= limit) {
      return;
    }
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (
        output.length >= limit ||
        entry.name === "node_modules" ||
        entry.name.startsWith(".")
      ) {
        continue;
      }
      const filePath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(filePath);
      } else if (entry.isFile()) {
        const info = await stat(filePath).catch(() => undefined);
        if (info && info.size <= 256_000) {
          output.push(filePath);
        }
      }
    }
  }
  await visit(root);
  return output;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

async function runWithInput(
  command: string,
  args: string[],
  input: string,
  cwd: string,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("exit", (code) =>
      resolvePromise({ exitCode: code, stdout, stderr }),
    );
    child.stdin.end(input);
  });
}
