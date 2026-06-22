import * as vscode from "vscode";
import { spawn, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { buildTextDiff, DiffProposal, parseDiffProposals } from "./chat-utils.js";
import { JsonRpcPeer } from "./jsonrpc.js";
import { LogicalMessage, LogicalSessionState, PromptAttachment } from "./types.js";

interface AgentModelView {
  id: string;
  label?: string;
  description?: string;
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

interface ChatState {
  agents: AgentView[];
  sessions: Array<Pick<LogicalSessionState, "id" | "activeAgent" | "activeModelByAgent" | "createdAt" | "updatedAt" | "currentTurnState">>;
  activeSessionId?: string;
  activeAgent?: string;
  activeModelByAgent?: Record<string, string>;
  transcript: LogicalMessage[];
  attachments: PromptAttachment[];
  toolCards: ToolCard[];
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
  private peer?: JsonRpcPeer;
  private sessionId?: string;
  private lastPrompt?: string;
  private lastAttachments: PromptAttachment[] = [];
  private activeAgent?: string;
  private currentTurnOutput = "";
  private stderrBuffer = "";
  private readonly openedAuthUrls = new Set<string>();
  private readonly pendingWrites = new Map<string, PendingWrite>();
  private readonly patchProposals = new Map<string, DiffProposal>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly chat: AgentChatViewProvider,
    private readonly onAgentsChanged: (agents: AgentView[]) => void
  ) {}

  async start(): Promise<void> {
    if (this.child && this.peer) {
      return;
    }

    const workspaceFolder = this.workspaceFolder();
    const config = vscode.workspace.getConfiguration("cliAgentConnector");
    const configuredCommand = config.get<string>("command") ?? "cli-agent-connector";
    const configuredArgs = config.get<string[]>("args") ?? ["serve", "--config", "${workspaceFolder}/cli-agent-connector.config.json"];
    const expandedArgs = configuredArgs.map((arg) => arg.replaceAll("${workspaceFolder}", workspaceFolder));
    const { command, args } = this.resolveCommand(configuredCommand, expandedArgs);

    this.child = spawn(command, args, {
      cwd: workspaceFolder,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
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
    this.child.on("exit", (code, signal) => {
      this.output.appendLine(`Connector exited: code=${code ?? "none"} signal=${signal ?? "none"}`);
      this.child = undefined;
      this.peer = undefined;
      this.chat.setError("CLI Agent Connector stopped.");
      void vscode.window.showWarningMessage("CLI Agent Connector stopped.");
    });

    this.peer = new JsonRpcPeer(this.child.stdout, this.child.stdin, { name: "vscode-client", requestTimeoutMs: 30 * 60_000 });
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
        }`
      );
    }
  }

  async newSession(agentName?: string): Promise<void> {
    await this.start();
    const cwd = this.workspaceFolder();
    const result = (await this.peer!.request("session/new", { cwd, agentName })) as { sessionId?: string; activeAgent?: string };
    if (!result.sessionId) {
      throw new Error("Connector did not return a sessionId.");
    }
    this.sessionId = result.sessionId;
    this.activeAgent = result.activeAgent;
    this.lastPrompt = undefined;
    this.lastAttachments = [];
    this.chat.setAttachments([]);
    this.output.appendLine(`New session: ${this.sessionId}${result.activeAgent ? ` (${result.activeAgent})` : ""}`);
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

  async sendPrompt(prompt?: string, attachments = this.chat.attachments): Promise<void> {
    await this.start();
    if (!this.sessionId) {
      await this.newSession(this.activeAgent);
    }
    const text =
      prompt ??
      (await vscode.window.showInputBox({
        title: "Send prompt to active CLI agent",
        prompt: "What should the agent do?",
        ignoreFocusOut: true
      }));
    if (!text || !this.sessionId) {
      return;
    }

    this.lastPrompt = text;
    this.lastAttachments = attachments;
    this.currentTurnOutput = "";
    this.chat.setBusy(true);
    this.chat.appendLocalUserMessage(text, attachments);
    this.output.show(true);
    this.output.appendLine(`\n> ${text}\n`);
    this.chat.startAgentMessage();

    try {
      await this.peer!.request("session/prompt", {
        sessionId: this.sessionId,
        prompt: text,
        attachments
      });
      this.chat.finishAgentMessage();
      this.addDiffProposalCards(parseDiffProposals(this.currentTurnOutput));
      this.chat.setAttachments([]);
      await this.refreshAll();
      await this.loadSession(this.sessionId);
    } catch (error) {
      this.chat.appendError(error instanceof Error ? error.message : String(error));
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
    const agents = (await this.peer!.request("connector/agents/list", {})) as AgentView[];
    const picked =
      agentName ??
      (await vscode.window.showQuickPick(
        agents
          .filter((agent) => agent.enabled)
          .map((agent) => ({
            label: agent.name,
            description: `${agent.health.status} · priority ${agent.priority} · cost ${agent.costHint}`,
            detail: agent.persona,
            agent
          })),
        { title: "Switch active CLI agent" }
      ))?.agent.name;
    if (!picked) {
      return;
    }
    if (!this.sessionId) {
      await this.newSession(picked);
      return;
    }
    await this.peer!.request("connector/agent/switch", { sessionId: this.sessionId, agentName: picked });
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
    await this.peer!.request("connector/model/switch", { sessionId: this.sessionId, agentName, modelId });
    this.output.appendLine(`Active model for ${agentName}: ${modelId}`);
    await this.refreshAll();
    await this.loadSession(this.sessionId);
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
      await this.sendPrompt(this.lastPrompt, this.lastAttachments);
    }
  }

  async inspectContext(): Promise<void> {
    if (!this.peer || !this.sessionId) {
      await vscode.window.showInformationMessage("No active CLI Agent Connector session.");
      return;
    }
    const context = await this.peer.request("sessions/inspect", { sessionId: this.sessionId });
    const doc = await vscode.workspace.openTextDocument({
      language: "json",
      content: JSON.stringify(context, null, 2)
    });
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  openLogs(): void {
    this.output.show(true);
  }

  async handleChatMessage(message: unknown): Promise<void> {
    const record = message && typeof message === "object" ? (message as Record<string, unknown>) : {};
    try {
      switch (record.type) {
        case "ready":
          await this.start();
          await this.loadLatestSession();
          return;
        case "send":
          if (typeof record.text === "string") {
            await this.sendPrompt(record.text, this.chat.attachments);
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
        case "switchAgent":
          if (typeof record.agentName === "string") {
            await this.switchAgent(record.agentName);
          }
          return;
        case "switchModel":
          if (typeof record.agentName === "string" && typeof record.modelId === "string") {
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
            this.chat.updateToolCard(record.id, { status: "denied", detail: "Rejected." });
          }
          return;
        case "approveFailover":
          if (typeof record.id === "string") {
            await this.peer?.request("connector/failover/approve", { proposalId: record.id });
            this.chat.updateToolCard(record.id, { status: "approved", detail: "Switched." });
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
      this.chat.appendError(error instanceof Error ? error.message : String(error));
    }
  }

  async refreshAgents(): Promise<void> {
    if (!this.peer) {
      this.onAgentsChanged([]);
      this.chat.setAgents([]);
      return;
    }
    try {
      const agents = (await this.peer.request("connector/agents/list", {})) as AgentView[];
      this.onAgentsChanged(agents);
      this.chat.setAgents(agents);
    } catch (error) {
      this.output.appendLine(`Unable to refresh agents: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async dispose(): Promise<void> {
    this.child?.kill("SIGTERM");
  }

  private async refreshAll(): Promise<void> {
    await this.refreshAgents();
    await this.refreshSessions();
    this.chat.setActive(this.sessionId, this.activeAgent);
  }

  private async refreshSessions(): Promise<void> {
    if (!this.peer) {
      this.chat.setSessions([]);
      return;
    }
    const sessions = (await this.peer.request("sessions/list", {})) as LogicalSessionState[];
    this.chat.setSessions(sessions);
  }

  private async loadLatestSession(): Promise<void> {
    if (!this.peer) {
      return;
    }
    const sessions = (await this.peer.request("sessions/list", {})) as LogicalSessionState[];
    this.chat.setSessions(sessions);
    if (!this.sessionId && sessions[0]) {
      await this.loadSession(sessions[0].id);
    }
  }

  private async loadSession(sessionId: string): Promise<void> {
    if (!this.peer) {
      return;
    }
    const session = (await this.peer.request("sessions/inspect", { sessionId })) as LogicalSessionState;
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

  private resolveCommand(command: string, args: string[]): { command: string; args: string[] } {
    if (command !== "cli-agent-connector") {
      return { command, args };
    }
    const localCli = join(this.context.extensionUri.fsPath, "dist", "cli.js");
    if (existsSync(localCli)) {
      return { command: process.execPath, args: [localCli, ...args] };
    }
    return { command, args };
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
    peer.onNotification("connector/agent_switched", (params) => {
      const record = params as { fromAgent?: string; toAgent?: string; reason?: string };
      this.activeAgent = record.toAgent;
      this.chat.setActive(this.sessionId, record.toAgent);
      this.output.appendLine(`\nSwitched agent: ${record.fromAgent} -> ${record.toAgent} (${record.reason})`);
      void this.refreshAll();
    });
    peer.onNotification("connector/auth_update", (params) => {
      void this.handleAuthUpdate(params);
    });
    peer.onRequest("session/request_permission", async (params) => await this.requestPermission(params));
    peer.onRequest("fs/read_text_file", async (params) => await this.readTextFile(params));
    peer.onRequest("fs/write_text_file", async (params) => await this.writeTextFile(params));
    peer.onRequest("terminal/execute", async (params) => await this.executeTerminal(params));
  }

  private async runAuth(action: "login" | "device-login" | "status" | "logout", agentName?: string): Promise<void> {
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
      status: "running"
    });
    const method = `connector/auth/${action}`;
    const result = (await this.peer!.request(method, { agentName: picked }, 10 * 60_000)) as {
      status?: string;
      message?: string;
      urls?: string[];
    };
    this.chat.updateToolCard(card.id, { status: result.status === "succeeded" ? "done" : "error", detail: result.message ?? result.status });
    if (result.urls?.length) {
      await this.offerOpenUrls(result.urls);
    }
    await this.refreshAll();
  }

  private async pickAgentForAuth(action: "login" | "device-login" | "status" | "logout"): Promise<string | undefined> {
    const agents = (await this.peer!.request("connector/agents/list", {})) as AgentView[];
    return (
      await vscode.window.showQuickPick(
        agents
          .filter((agent) => agent.auth?.configured && hasAuthAction(agent, action))
          .map((agent) => ({
            label: agent.name,
            description: `${agent.driver} · ${agent.health.status}`,
            detail: agent.persona,
            agent
          })),
        { title: `Choose agent for ${action}` }
      )
    )?.agent.name;
  }

  private async handleAuthUpdate(params: unknown): Promise<void> {
    const record = params && typeof params === "object" ? (params as { text?: string; urls?: string[]; stream?: string; action?: string }) : {};
    if (record.text) {
      this.output.append(record.stream === "lifecycle" ? `${record.text}\n` : record.text);
      this.chat.addToolCard({ type: "auth", title: `Auth update${record.action ? `: ${record.action}` : ""}`, status: "done", detail: record.text });
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
      const answer = await vscode.window.showInformationMessage("Open CLI agent login URL in your browser?", "Open Browser", "Copy URL");
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
      actions: ["approveFailover", "rejectPatch"]
    });
  }

  private async requestPermission(params: unknown): Promise<unknown> {
    const text = JSON.stringify(params, null, 2).slice(0, 1600);
    const card = this.chat.addToolCard({ type: "permission", title: "Permission requested", status: "pending", detail: text });
    const answer = await vscode.window.showWarningMessage(`Agent requests permission:\n${text}`, { modal: true }, "Allow", "Deny");
    const approved = answer === "Allow";
    this.chat.updateToolCard(card.id, { status: approved ? "approved" : "denied" });
    return approved ? { outcome: "approved" } : { outcome: "denied", reason: "User denied permission." };
  }

  private async readTextFile(params: unknown): Promise<unknown> {
    const filePath = pathFromParams(params);
    if (!filePath || !this.isInsideWorkspace(filePath)) {
      throw new Error("Blocked file read outside the current workspace.");
    }
    const card = this.chat.addToolCard({ type: "read", title: `Read ${relative(this.workspaceFolder(), filePath)}`, status: "running" });
    try {
      const content = await readFile(filePath, "utf8");
      this.chat.updateToolCard(card.id, { status: "done", detail: `${content.length} chars` });
      return { content };
    } catch (error) {
      this.chat.updateToolCard(card.id, { status: "error", detail: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  private async writeTextFile(params: unknown): Promise<unknown> {
    const record = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
    const filePath = pathFromParams(params);
    if (!filePath || !this.isInsideWorkspace(filePath)) {
      throw new Error("Blocked file write outside the current workspace.");
    }
    const content = typeof record.content === "string" ? record.content : typeof record.text === "string" ? record.text : "";
    const oldContent = await readFile(filePath, "utf8").catch(() => "");
    const relativePath = relative(this.workspaceFolder(), filePath);
    const card = this.chat.addToolCard({
      type: "write",
      title: `Write ${relativePath}`,
      status: "pending",
      detail: "Review the proposed file change.",
      diff: buildTextDiff(oldContent, content, relativePath),
      actions: ["applyWrite", "rejectWrite"]
    });
    await this.chat.reveal();
    return await new Promise((resolvePromise) => {
      this.pendingWrites.set(card.id, { filePath, content, resolve: resolvePromise });
    });
  }

  private async executeTerminal(params: unknown): Promise<unknown> {
    const record = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
    const command = typeof record.command === "string" ? record.command : undefined;
    const args = Array.isArray(record.args) ? record.args.filter((item): item is string => typeof item === "string") : [];
    if (!command) {
      throw new Error("terminal/execute requires command.");
    }
    const card = this.chat.addToolCard({ type: "terminal", title: `Run ${command} ${args.join(" ")}`, status: "pending" });
    const answer = await vscode.window.showWarningMessage(
      `Allow agent to run: ${command} ${args.join(" ")}`,
      { modal: true },
      "Allow",
      "Deny"
    );
    if (answer !== "Allow") {
      this.chat.updateToolCard(card.id, { status: "denied", detail: "User denied terminal command." });
      return { outcome: "denied", reason: "User denied terminal command." };
    }
    this.chat.updateToolCard(card.id, { status: "running" });
    return await new Promise((resolvePromise) => {
      execFile(command, args, { cwd: this.workspaceFolder(), timeout: 120_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        this.chat.updateToolCard(card.id, {
          status: error ? "error" : "done",
          detail: `${stdout}${stderr ? `\n${stderr}` : ""}`.slice(0, 4000)
        });
        resolvePromise({
          outcome: error ? "failed" : "completed",
          exitCode: error && "code" in error ? error.code : 0,
          stdout,
          stderr
        });
      });
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
      pending.resolve({ outcome: "denied", reason: "User rejected file write." });
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
        detail: proposal.applicable ? "Patch can be applied with review." : "Patch target is unsafe or unknown. Copy manually.",
        diff: proposal.diff,
        actions: proposal.applicable ? ["applyPatch", "rejectPatch"] : ["rejectPatch"]
      });
    }
  }

  private async applyPatchProposal(id: string): Promise<void> {
    const proposal = this.patchProposals.get(id);
    if (!proposal || !proposal.applicable) {
      return;
    }
    this.chat.updateToolCard(id, { status: "running", detail: "Applying patch..." });
    const result = await runWithInput("git", ["apply", "--whitespace=nowarn"], proposal.diff, this.workspaceFolder());
    this.chat.updateToolCard(id, {
      status: result.exitCode === 0 ? "approved" : "error",
      detail: result.exitCode === 0 ? "Applied." : result.stderr || result.stdout || `git apply exited ${result.exitCode}`
    });
  }

  private async attachCurrentFile(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      this.chat.setError("No active editor.");
      return;
    }
    this.chat.addAttachments([this.attachmentFromDocument(editor.document, "file")]);
  }

  private async attachSelection(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      this.chat.setError("No active selection.");
      return;
    }
    this.chat.addAttachments([this.attachmentFromDocument(editor.document, "selection", editor.selection)]);
  }

  private async attachPickedFiles(folder: boolean): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: !folder,
      canSelectFolders: folder,
      canSelectMany: true,
      openLabel: folder ? "Attach Folder" : "Attach File"
    });
    if (!picked?.length) {
      return;
    }
    const attachments: PromptAttachment[] = [];
    for (const uri of picked) {
      attachments.push(...(folder ? await this.attachmentsFromFolder(uri.fsPath) : [await this.attachmentFromFile(uri.fsPath, "file")]));
    }
    this.chat.addAttachments(attachments);
  }

  private async attachOpenEditors(): Promise<void> {
    const attachments = vscode.workspace.textDocuments
      .filter((document) => document.uri.scheme === "file" && !document.isUntitled)
      .slice(0, 20)
      .map((document) => this.attachmentFromDocument(document, "open-editor"));
    this.chat.addAttachments(attachments);
  }

  private attachmentFromDocument(document: vscode.TextDocument, kind: PromptAttachment["kind"], range?: vscode.Range): PromptAttachment {
    const text = range ? document.getText(range) : document.getText();
    return makeAttachment({
      kind,
      label: range ? `${basename(document.uri.fsPath)} ${range.start.line + 1}:${range.start.character + 1}-${range.end.line + 1}:${range.end.character + 1}` : basename(document.uri.fsPath),
      path: document.uri.fsPath,
      range: range ? `${range.start.line + 1}:${range.start.character + 1}-${range.end.line + 1}:${range.end.character + 1}` : undefined,
      content: text
    });
  }

  private async attachmentFromFile(filePath: string, kind: PromptAttachment["kind"]): Promise<PromptAttachment> {
    try {
      const content = await readFile(filePath, "utf8");
      if (looksBinary(content)) {
        return makeAttachment({ kind: "unsupported", label: basename(filePath), path: filePath });
      }
      return makeAttachment({ kind, label: relative(this.workspaceFolder(), filePath) || basename(filePath), path: filePath, content });
    } catch {
      return makeAttachment({ kind: "unsupported", label: basename(filePath), path: filePath });
    }
  }

  private async attachmentsFromFolder(folderPath: string): Promise<PromptAttachment[]> {
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
  private readonly state: ChatState = {
    agents: [],
    sessions: [],
    transcript: [],
    attachments: [],
    toolCards: [],
    busy: false
  };

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly onMessage: (message: unknown) => Promise<void>
  ) {}

  get attachments(): PromptAttachment[] {
    return this.state.attachments;
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [this.context.extensionUri] };
    webviewView.webview.html = this.html();
    webviewView.webview.onDidReceiveMessage((message) => void this.onMessage(message));
    this.post({ type: "state", state: this.state });
  }

  async reveal(): Promise<void> {
    await vscode.commands.executeCommand("cliAgentConnector.chat.focus");
  }

  setAgents(agents: AgentView[]): void {
    this.state.agents = agents;
    this.postState();
  }

  setSessions(sessions: LogicalSessionState[]): void {
    this.state.sessions = sessions.map((session) => ({
      id: session.id,
      activeAgent: session.activeAgent,
      activeModelByAgent: session.activeModelByAgent,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      currentTurnState: session.currentTurnState
    }));
    this.postState();
  }

  setSession(session: LogicalSessionState): void {
    this.state.activeSessionId = session.id;
    this.state.activeAgent = session.activeAgent;
    this.state.activeModelByAgent = session.activeModelByAgent;
    this.state.transcript = session.transcript;
    this.state.busy = session.currentTurnState === "running";
    this.postState();
  }

  setActive(sessionId?: string, agentName?: string): void {
    this.state.activeSessionId = sessionId;
    this.state.activeAgent = agentName;
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

  addAttachments(attachments: PromptAttachment[]): void {
    const existing = new Set(this.state.attachments.map((attachment) => attachment.id));
    this.state.attachments = [...this.state.attachments, ...attachments.filter((attachment) => !existing.has(attachment.id))].slice(0, 60);
    this.postState();
  }

  removeAttachment(id: string): void {
    this.state.attachments = this.state.attachments.filter((attachment) => attachment.id !== id);
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

  appendLocalUserMessage(text: string, attachments: PromptAttachment[]): void {
    this.state.transcript = [
      ...this.state.transcript,
      {
        role: "user",
        text,
        attachments,
        at: new Date().toISOString()
      }
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
    this.addToolCard({ type: "error", title: "Error", status: "error", detail: text });
  }

  addToolCard(input: Omit<ToolCard, "id"> & { id?: string }): ToolCard {
    const card: ToolCard = {
      id: input.id ?? `tool_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      type: input.type,
      title: input.title,
      status: input.status,
      detail: input.detail,
      diff: input.diff,
      actions: input.actions
    };
    this.state.toolCards = [card, ...this.state.toolCards].slice(0, 30);
    this.postState();
    return card;
  }

  updateToolCard(id: string, patch: Partial<ToolCard>): void {
    this.state.toolCards = this.state.toolCards.map((card) => (card.id === id ? { ...card, ...patch } : card));
    this.postState();
  }

  private postState(): void {
    this.post({ type: "state", state: this.state });
  }

  private post(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }

  private html(): string {
    const nonce = nonceValue();
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      grid-template-rows: auto auto 1fr auto;
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
    #agent, #model, #session { width: 100%; }
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
    #messages {
      overflow: auto;
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
      <select id="model" title="Active model"></select>
      <select id="session" title="Chat session"></select>
    </div>
    <div class="statusline"><span id="statusDot" class="dot"></span><span id="statusText">Starting connector...</span></div>
    <div class="bar-row wrap">
      <button data-action="newSession">New Chat</button>
      <button class="secondary" data-action="retry">Retry</button>
      <button class="secondary" data-action="stop">Stop</button>
      <button class="ghost" data-action="clearView">Clear</button>
    </div>
  </header>
  <div id="error"></div>
  <main id="messages" aria-live="polite"></main>
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
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const state = { agents: [], sessions: [], transcript: [], attachments: [], toolCards: [], busy: false };
    let streaming;

    const messages = document.getElementById('messages');
    const input = document.getElementById('input');
    const agent = document.getElementById('agent');
    const model = document.getElementById('model');
    const session = document.getElementById('session');
    const attachments = document.getElementById('attachments');
    const error = document.getElementById('error');
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');

    function post(message) { vscode.postMessage(message); }
    function activeAgent() { return state.agents.find((item) => item.name === state.activeAgent) || state.agents[0]; }
    function enabledModels(item) { return item && item.models ? item.models.filter((entry) => entry.enabled !== false) : []; }
    function selectedModelId(item) {
      const models = enabledModels(item);
      if (!item || !models.length) return '__agent_default__';
      const existing = state.activeModelByAgent && state.activeModelByAgent[item.name];
      if (existing && models.some((entry) => entry.id === existing)) return existing;
      if (item.defaultModel && models.some((entry) => entry.id === item.defaultModel)) return item.defaultModel;
      return models[0].id;
    }
    function modelLabel(item, modelId) {
      const found = enabledModels(item).find((entry) => entry.id === modelId);
      return found ? (found.label || found.id) : 'Agent default';
    }
    function labelSession(item) {
      const active = state.agents.find((entry) => entry.name === item.activeAgent);
      const modelId = item.activeModelByAgent && item.activeModelByAgent[item.activeAgent];
      const modelText = modelId ? ' · ' + modelLabel(active, modelId) : '';
      return item.id.slice(0, 12) + ' · ' + item.activeAgent + modelText;
    }
    function fmtTime(value) { try { return new Date(value).toLocaleTimeString(); } catch { return ''; } }
    function el(tag, className, text) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    }
    function iconForRole(role) {
      if (role === 'user') return 'U';
      if (role === 'system') return '!';
      return 'AI';
    }
    function healthClass(item) {
      if (!item || item.health.status === 'healthy') return '';
      if (item.health.status === 'limited') return 'warn';
      return 'bad';
    }

    function render() {
      error.textContent = state.error || '';
      error.className = state.error ? 'visible' : '';
      const currentAgent = activeAgent();
      agent.innerHTML = '';
      for (const item of state.agents) {
        const option = document.createElement('option');
        option.value = item.name;
        option.textContent = item.name + ' · ' + item.health.status;
        option.disabled = !item.enabled;
        option.selected = item.name === state.activeAgent;
        agent.appendChild(option);
      }
      renderModelSelect(currentAgent);
      session.innerHTML = '';
      for (const item of state.sessions) {
        const option = document.createElement('option');
        option.value = item.id;
        option.textContent = labelSession(item);
        option.selected = item.id === state.activeSessionId;
        session.appendChild(option);
      }
      renderAttachments();
      renderMessages();
      statusDot.className = 'dot ' + healthClass(currentAgent);
      const modelText = modelLabel(currentAgent, selectedModelId(currentAgent));
      statusText.textContent = currentAgent
        ? currentAgent.health.status + ' · ' + currentAgent.driver + ' · ' + modelText
        : 'No agent configured';
      const send = document.getElementById('send');
      send.textContent = state.busy ? 'Running' : 'Send';
      send.disabled = state.busy;
    }

    function renderModelSelect(currentAgent) {
      model.innerHTML = '';
      const models = enabledModels(currentAgent);
      if (!models.length) {
        const option = document.createElement('option');
        option.value = '__agent_default__';
        option.textContent = 'Agent default';
        option.selected = true;
        model.appendChild(option);
        model.disabled = true;
        return;
      }
      model.disabled = false;
      const selected = selectedModelId(currentAgent);
      for (const item of models) {
        const option = document.createElement('option');
        option.value = item.id;
        option.textContent = (item.label || item.id) + (item.costHint !== undefined ? ' · cost ' + item.costHint : '');
        option.title = item.description || item.id;
        option.selected = item.id === selected;
        model.appendChild(option);
      }
    }

    function renderAttachments() {
      attachments.innerHTML = '';
      for (const item of state.attachments) {
        const chip = el('span', 'chip');
        chip.appendChild(el('span', '', item.label + (item.truncated ? ' · truncated' : '')));
        const remove = el('button', 'ghost', 'x');
        remove.dataset.action = 'removeAttachment';
        remove.dataset.id = item.id;
        chip.appendChild(remove);
        attachments.appendChild(chip);
      }
    }

    function renderMessages() {
      const previousScroll = messages.scrollTop;
      messages.innerHTML = '';
      if (!state.transcript.length && !state.toolCards.length) {
        messages.appendChild(renderEmpty());
        return;
      }
      for (const msg of state.transcript) {
        const box = el('article', 'message ' + msg.role);
        box.appendChild(el('div', 'avatar', iconForRole(msg.role)));
        const meta = el('div', 'meta');
        meta.appendChild(el('span', 'role', msg.role + (msg.agentName ? ' · ' + msg.agentName : '')));
        meta.appendChild(el('span', '', fmtTime(msg.at)));
        const bubble = el('div', 'bubble');
        bubble.appendChild(meta);
        bubble.appendChild(el('div', 'text' + (msg.pending ? ' muted' : ''), msg.text || (msg.pending ? 'Working...' : '')));
        if (msg.attachments && msg.attachments.length) {
          const list = el('div', 'attachments');
          for (const att of msg.attachments) list.appendChild(el('span', 'chip', att.label));
          bubble.appendChild(list);
        }
        box.appendChild(bubble);
        messages.appendChild(box);
      }
      for (const card of state.toolCards) {
        messages.appendChild(renderTool(card));
      }
      messages.scrollTop = Math.max(previousScroll, messages.scrollHeight);
    }

    function renderEmpty() {
      const wrap = el('div', 'empty');
      const currentAgent = activeAgent();
      wrap.appendChild(el('div', 'empty-title', currentAgent ? 'Chat with ' + currentAgent.name : 'CLI Agent Chat'));
      wrap.appendChild(el('div', '', 'Attach code context, choose a model, then ask for implementation, review, or debugging help.'));
      const suggestions = el('div', 'suggestions');
      const items = [
        'Review the current file and suggest fixes',
        'Explain the selected code and edge cases',
        'Implement the next small change safely'
      ];
      for (const text of items) {
        const button = el('button', 'suggestion', text);
        button.dataset.action = 'suggest';
        button.dataset.text = text;
        suggestions.appendChild(button);
      }
      wrap.appendChild(suggestions);
      return wrap;
    }

    function renderTool(card) {
      const box = el('article', 'message tool ' + card.status);
      box.appendChild(el('div', 'avatar', toolIcon(card.type)));
      const bubble = el('div', 'bubble');
      const meta = el('div', 'meta');
      meta.appendChild(el('span', 'role', card.title));
      meta.appendChild(el('span', '', card.status));
      bubble.appendChild(meta);
      if (card.detail) bubble.appendChild(el('div', 'text', card.detail));
      if (card.diff) bubble.appendChild(el('pre', '', card.diff));
      if (card.actions && card.actions.length) {
        const row = el('div', 'actions');
        for (const action of card.actions) {
          const button = el('button', action.includes('reject') ? 'secondary' : '', actionLabel(action));
          button.dataset.action = action;
          button.dataset.id = card.id;
          row.appendChild(button);
        }
        bubble.appendChild(row);
      }
      box.appendChild(bubble);
      return box;
    }

    function toolIcon(type) {
      if (type === 'terminal') return '$';
      if (type === 'write' || type === 'diff') return '+-';
      if (type === 'read') return 'R';
      if (type === 'auth') return 'A';
      if (type === 'failover') return '>';
      return '*';
    }

    function actionLabel(action) {
      if (action === 'applyWrite' || action === 'applyPatch') return 'Apply';
      if (action === 'approveFailover') return 'Switch';
      return 'Reject';
    }

    document.body.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !target.dataset.action) return;
      const action = target.dataset.action;
      if (action === 'send') {
        const text = input.value.trim();
        if (!text) return;
        input.value = '';
        streaming = undefined;
        post({ type: 'send', text });
        return;
      }
      if (action === 'suggest') {
        input.value = target.dataset.text || '';
        input.focus();
        return;
      }
      post({ type: action, id: target.dataset.id });
    });

    agent.addEventListener('change', () => post({ type: 'switchAgent', agentName: agent.value }));
    model.addEventListener('change', () => post({ type: 'switchModel', agentName: agent.value, modelId: model.value }));
    session.addEventListener('change', () => post({ type: 'selectSession', sessionId: session.value }));
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        document.getElementById('send').click();
      }
      if (event.key === 'Escape') input.focus();
    });

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'state') {
        Object.assign(state, message.state);
        streaming = undefined;
        render();
      }
      if (message.type === 'start') {
        if (!streaming) {
          streaming = { role: 'agent', text: '', pending: true, at: new Date().toISOString(), agentName: state.activeAgent };
          state.transcript = [...state.transcript, streaming];
          renderMessages();
        }
      }
      if (message.type === 'chunk') {
        if (!streaming) {
          streaming = { role: 'agent', text: '', at: new Date().toISOString(), agentName: state.activeAgent };
          state.transcript = [...state.transcript, streaming];
          render();
        }
        streaming.pending = false;
        streaming.text += message.text;
        renderMessages();
      }
      if (message.type === 'finish') streaming = undefined;
    });

    post({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}

class AgentTreeProvider implements vscode.TreeDataProvider<AgentItem> {
  private readonly emitter = new vscode.EventEmitter<AgentItem | undefined | null | void>();
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
    this.tooltip = [agent.persona, agent.health.reason, `Capabilities: ${agent.capabilities.join(", ")}`, `Auth: ${authActions}`]
      .filter(Boolean)
      .join("\n");
    this.iconPath = new vscode.ThemeIcon(agent.health.status === "healthy" ? "circle-filled" : "warning");
    this.contextValue = "cliAgentConnector.agent";
    this.command = {
      command: "cliAgentConnector.openChat",
      title: "Open Agent Chat",
      arguments: [agent.name]
    };
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("CLI Agent Connector");
  const tree = new AgentTreeProvider();
  let client: ConnectorClient;
  const chatView = new AgentChatViewProvider(context, async (message) => await client.handleChatMessage(message));
  client = new ConnectorClient(context, output, chatView, (agents) => tree.setAgents(agents));

  context.subscriptions.push(
    output,
    vscode.window.registerWebviewViewProvider("cliAgentConnector.chat", chatView, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerTreeDataProvider("cliAgentConnector.agents", tree),
    vscode.commands.registerCommand("cliAgentConnector.start", async () => client.start()),
    vscode.commands.registerCommand("cliAgentConnector.newSession", async () => client.newSession()),
    vscode.commands.registerCommand("cliAgentConnector.openChat", async (agentName?: string) => client.openChat(agentName)),
    vscode.commands.registerCommand("cliAgentConnector.sendPrompt", async () => client.sendPrompt()),
    vscode.commands.registerCommand("cliAgentConnector.cancel", async () => client.cancel()),
    vscode.commands.registerCommand("cliAgentConnector.switchAgent", async (agentName?: string) => client.switchAgent(agentName)),
    vscode.commands.registerCommand("cliAgentConnector.login", async (agentName?: string) => client.login(agentName)),
    vscode.commands.registerCommand("cliAgentConnector.deviceLogin", async (agentName?: string) => client.deviceLogin(agentName)),
    vscode.commands.registerCommand("cliAgentConnector.authStatus", async (agentName?: string) => client.authStatus(agentName)),
    vscode.commands.registerCommand("cliAgentConnector.logout", async (agentName?: string) => client.logout(agentName)),
    vscode.commands.registerCommand("cliAgentConnector.retry", async () => client.retry()),
    vscode.commands.registerCommand("cliAgentConnector.inspectContext", async () => client.inspectContext()),
    vscode.commands.registerCommand("cliAgentConnector.openLogs", () => client.openLogs()),
    { dispose: () => void client.dispose() }
  );
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

function hasAuthAction(agent: AgentView, action: "login" | "device-login" | "status" | "logout"): boolean {
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
    truncated: Boolean(input.content && content && content.length < input.content.length)
  };
}

function looksBinary(content: string): boolean {
  return content.includes("\u0000") || /[\u0001-\u0008\u000B\u000C\u000E-\u001F]/.test(content.slice(0, 1000));
}

async function collectTextFiles(root: string, limit: number): Promise<string[]> {
  const output: string[] = [];
  async function visit(dir: string): Promise<void> {
    if (output.length >= limit) {
      return;
    }
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (output.length >= limit || entry.name === "node_modules" || entry.name.startsWith(".")) {
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

function nonceValue(): string {
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let index = 0; index < 32; index += 1) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

async function runWithInput(
  command: string,
  args: string[],
  input: string,
  cwd: string
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("exit", (code) => resolvePromise({ exitCode: code, stdout, stderr }));
    child.stdin.end(input);
  });
}
