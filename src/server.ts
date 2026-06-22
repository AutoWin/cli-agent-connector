import { Readable, Writable } from "node:stream";
import { cwd as processCwd } from "node:process";
import { AuthService } from "./auth.js";
import { BackendFactory } from "./backends/factory.js";
import { capacityKindToTrigger } from "./capacity.js";
import { ConnectorConfig, LogicalSessionState, SwitchProposal } from "./types.js";
import { AgentRouter } from "./router.js";
import { StateStore } from "./state.js";
import { appendMessage, buildHandoffSummary, estimateContextChars, maybeCompactSession } from "./handoff.js";
import { JsonRpcPeer } from "./jsonrpc.js";
import { EventLogger, Metrics } from "./metrics.js";
import { Redactor, truncateText } from "./redaction.js";
import { assemblePromptWithAttachments, normalizePromptAttachments } from "./chat-utils.js";
import { defaultModelIdForAgent, selectedModelForAgent } from "./config.js";

export class ConnectorServer {
  private readonly redactor: Redactor;
  private readonly store: StateStore;
  private readonly router: AgentRouter;
  private readonly auth: AuthService;
  private readonly backends: BackendFactory;
  private readonly metrics = new Metrics();
  private readonly logger: EventLogger;
  private readonly activeTurns = new Map<string, AbortController>();
  private readonly proposals = new Map<string, SwitchProposal>();
  private peer?: JsonRpcPeer;

  constructor(private readonly config: ConnectorConfig) {
    this.redactor = new Redactor(config.state.redactionRules);
    this.store = new StateStore(config, this.redactor);
    this.router = new AgentRouter(config);
    this.auth = new AuthService(config.agents, this.redactor);
    this.backends = new BackendFactory(config);
    this.logger = new EventLogger(config.state.path, this.redactor);
  }

  async start(input: Readable = process.stdin, output: Writable = process.stdout): Promise<void> {
    await this.store.init();
    this.peer = new JsonRpcPeer(input, output, {
      name: "cli-agent-connector",
      requestTimeoutMs: 30 * 60_000
    });
    this.registerHandlers(this.peer);
    this.peer.start();
    await this.logger.log("server_started", { agentCount: this.config.agents.length });
  }

  async stop(): Promise<void> {
    for (const controller of this.activeTurns.values()) {
      controller.abort();
    }
    await this.backends.disposeAll();
    await this.logger.log("server_stopped");
  }

  private registerHandlers(peer: JsonRpcPeer): void {
    peer.onRequest("initialize", async () => ({
      protocolVersion: 1,
      agentInfo: {
        name: "cli-agent-connector",
        title: "CLI Agent Connector",
        version: "0.1.0"
      },
      capabilities: {
        sessions: true,
        prompt: true,
        cancel: true,
        multiAgent: true,
        failoverProposal: true,
        browserAuth: true
      }
    }));

    peer.onRequest("session/new", async (params) => await this.newSession(params));
    peer.onRequest("session/prompt", async (params) => await this.prompt(params));
    peer.onRequest("session/cancel", async (params) => await this.cancel(params));
    peer.onRequest("sessions/list", async () => await this.store.listSessions());
    peer.onRequest("sessions/inspect", async (params) => await this.inspectSession(params));
    peer.onRequest("sessions/export", async (params) => await this.exportSession(params));
    peer.onRequest("connector/agents/list", async () => this.publicAgentList());
    peer.onRequest("connector/agents/health", async () =>
      (this.publicAgentList() as Array<{ health: unknown }>).map((agent) => agent.health)
    );
    peer.onRequest("connector/agent/switch", async (params) => await this.manualSwitch(params));
    peer.onRequest("connector/model/switch", async (params) => await this.switchModel(params));
    peer.onRequest("connector/agent/disable", async (params) => this.disableAgentForSession(params));
    peer.onRequest("connector/auth/list", async () => this.auth.list());
    peer.onRequest("connector/auth/login", async (params) => await this.runAuth("login", params));
    peer.onRequest("connector/auth/device-login", async (params) => await this.runAuth("device-login", params));
    peer.onRequest("connector/auth/status", async (params) => await this.runAuth("status", params));
    peer.onRequest("connector/auth/logout", async (params) => await this.runAuth("logout", params));
    peer.onRequest("connector/failover/approve", async (params) => await this.approveFailover(params));
    peer.onRequest("connector/metrics", async () => this.metrics.snapshot());
    peer.onRequest("connector/debug/export", async (params) => await this.exportDebugBundle(params));
  }

  private async newSession(params: unknown): Promise<unknown> {
    const record = asRecord(params);
    const requestedAgent = typeof record.agentName === "string" ? this.router.getAgent(record.agentName) : undefined;
    const agent = requestedAgent ?? this.router.chooseInitialAgent();
    const session = await this.store.createSession({
      cwd: typeof record.cwd === "string" ? record.cwd : processCwd(),
      additionalDirectories: stringArray(record.additionalDirectories),
      mcpServers: Array.isArray(record.mcpServers) ? record.mcpServers : [],
      activeAgent: agent.name
    });

    const started = await this.ensureBackendSession(session, agent.name);
    this.backends.release(agent.name);
    this.router.incrementActive(agent.name);
    await this.logger.log("session_created", { sessionId: session.id, agent: agent.name });
    return {
      sessionId: started.id,
      activeAgent: agent.name,
      backendSessionId: started.backendSessionIds[agent.name],
      agents: this.publicAgentList()
    };
  }

  private async prompt(params: unknown): Promise<unknown> {
    if (!this.peer) {
      throw new Error("Server is not started.");
    }

    const record = asRecord(params);
    const sessionId = stringField(record, "sessionId");
    const prompt = extractPromptText(record);
    const attachments = normalizePromptAttachments(record.attachments);
    if (!sessionId) {
      throw new Error("session/prompt requires sessionId.");
    }
    if (!prompt) {
      throw new Error("session/prompt requires text prompt content.");
    }
    if (this.activeTurns.has(sessionId)) {
      throw new Error("A turn is already running for this session.");
    }

    let session = maybeCompactSession(await this.store.getSession(sessionId), this.config);
    session = await this.ensureActiveModel(session, session.activeAgent);
    session = appendMessage(
      {
        ...session,
        currentTurnState: "running",
        pendingTask: prompt,
        lastPrompt: prompt,
        relevantFiles: mergeUnique(session.relevantFiles, [...extractFileRefs(record), ...attachments.map((item) => item.path).filter(isString)])
      },
      "user",
      prompt,
      undefined,
      attachments
    );
    await this.store.saveSession(session);

    const controller = new AbortController();
    this.activeTurns.set(sessionId, controller);
    const startedAt = Date.now();
    const agentName = session.activeAgent;
    const backendSessionId = await this.ensureBackendSession(session, agentName).then(
      (updated) => updated.backendSessionIds[agentName]
    );
    const backend = this.backends.get(this.router.getAgent(agentName)!);
    let agentOutput = "";

    const backendPrompt = assemblePromptWithAttachments(prompt, attachments);

    await this.logger.log("prompt_started", {
      sessionId,
      agent: agentName,
      model: session.activeModelByAgent?.[agentName],
      estimatedContextChars: estimateContextChars(session, backendPrompt)
    });
    this.metrics.increment("turn.started");

    try {
      const result = await backend.prompt({
        session,
        backendSessionId,
        prompt: backendPrompt,
        handoffSummary: session.handoffSummary,
        signal: controller.signal,
        onUpdate: (update) => {
          const text = extractUpdateText(update.params);
          if (text) {
            agentOutput += text;
          }
          this.peer!.notify(update.method ?? "session/update", update.params);
        },
        requestClient: async (method, requestParams) => {
          try {
            return await this.peer!.request(method, requestParams, 5 * 60_000);
          } catch (error) {
            return {
              outcome: "denied",
              reason: error instanceof Error ? error.message : String(error)
            };
          }
        }
      });

      const durationMs = Date.now() - startedAt;
      this.metrics.observeMs("turn.duration", durationMs);
      this.metrics.increment(`turn.stop.${result.stopReason}`);

      session = await this.store.getSession(sessionId);
      session = appendMessage(session, "agent", agentOutput || stringifyResult(result), agentName);

      if (result.capacityKind) {
        const proposal = await this.handleCapacityLimit(session, result.capacityKind, result.message ?? result.stopReason, prompt);
        return {
          stopReason: result.stopReason,
          capacityKind: result.capacityKind,
          proposal,
          message: result.message
        };
      }

      this.router.markHealthy(agentName);
      session.currentTurnState = "idle";
      session.pendingTask = undefined;
      await this.store.saveSession(session);
      await this.logger.log("prompt_completed", { sessionId, agent: agentName, durationMs, stopReason: result.stopReason });
      return {
        stopReason: result.stopReason,
        activeAgent: agentName,
        activeModel: session.activeModelByAgent?.[agentName]
      };
    } finally {
      this.activeTurns.delete(sessionId);
      this.backends.release(agentName);
    }
  }

  private async handleCapacityLimit(
    session: LogicalSessionState,
    capacityKind: import("./types.js").CapacityKind,
    reason: string,
    pendingPrompt: string
  ): Promise<SwitchProposal | undefined> {
    const fromAgent = session.activeAgent;
    this.metrics.increment(`capacity.${capacityKind}`);
    this.router.markLimited(fromAgent, capacityKind, reason);
    const handoffSummary = buildHandoffSummary(session, pendingPrompt);
    const target = this.router.chooseFailoverAgent(fromAgent, capacityKind, session.id);
    const updatedSession: LogicalSessionState = {
      ...session,
      currentTurnState: "idle",
      pendingTask: pendingPrompt,
      handoffSummary,
      lastLimitReason: {
        kind: capacityKind,
        agentName: fromAgent,
        message: truncateText(reason, 2000),
        at: new Date().toISOString()
      }
    };

    await this.store.saveSession(updatedSession);
    await this.logger.log("capacity_limit_detected", {
      sessionId: session.id,
      agent: fromAgent,
      capacityKind,
      trigger: capacityKindToTrigger(capacityKind),
      hasTarget: Boolean(target)
    });

    if (!target || this.config.failover.mode === "manual") {
      return undefined;
    }

    const proposal = this.router.createSwitchProposal(session.id, fromAgent, target, capacityKind, reason, handoffSummary);
    this.proposals.set(proposal.id, proposal);
    this.metrics.increment("failover.proposed");
    this.peer?.notify("connector/failover_proposal", proposal);
    await this.logger.log("failover_proposed", {
      proposalId: proposal.id,
      sessionId: session.id,
      fromAgent,
      toAgent: target.name,
      capacityKind
    });

    if (this.config.failover.mode === "auto") {
      await this.switchSessionAgent(session.id, target.name, `auto_failover:${capacityKind}`, proposal.handoffSummary);
      this.metrics.increment("failover.auto_switched");
    }

    return proposal;
  }

  private async cancel(params: unknown): Promise<unknown> {
    const sessionId = stringField(asRecord(params), "sessionId");
    if (!sessionId) {
      throw new Error("session/cancel requires sessionId.");
    }
    const controller = this.activeTurns.get(sessionId);
    if (controller) {
      controller.abort();
    }
    const session = await this.store.getSession(sessionId);
    await this.backends.get(this.router.getAgent(session.activeAgent)!).cancel(sessionId);
    this.backends.release(session.activeAgent);
    await this.store.saveSession({
      ...session,
      currentTurnState: "idle",
      pendingTask: undefined
    });
    this.metrics.increment("turn.cancelled");
    await this.logger.log("prompt_cancelled", { sessionId, agent: session.activeAgent });
    return { cancelled: true };
  }

  private async manualSwitch(params: unknown): Promise<unknown> {
    const record = asRecord(params);
    const sessionId = stringField(record, "sessionId");
    const agentName = stringField(record, "agentName");
    if (!sessionId || !agentName) {
      throw new Error("connector/agent/switch requires sessionId and agentName.");
    }
    const session = await this.store.getSession(sessionId);
    if (session.currentTurnState !== "idle") {
      throw new Error("Cannot switch agents while a turn is running.");
    }
    const handoffSummary = buildHandoffSummary(session, session.pendingTask);
    return await this.switchSessionAgent(sessionId, agentName, "manual_switch", handoffSummary);
  }

  private async switchModel(params: unknown): Promise<unknown> {
    const record = asRecord(params);
    const sessionId = stringField(record, "sessionId");
    const agentName = stringField(record, "agentName");
    const modelId = stringField(record, "modelId");
    if (!sessionId || !agentName || !modelId) {
      throw new Error("connector/model/switch requires sessionId, agentName, and modelId.");
    }
    const agent = this.router.getAgent(agentName);
    if (!agent) {
      throw new Error(`Unknown agent: ${agentName}`);
    }
    const model = agent.models?.find((item) => item.id === modelId && item.enabled);
    if (!model) {
      throw new Error(`Agent ${agentName} does not support enabled model "${modelId}".`);
    }
    let session = await this.store.getSession(sessionId);
    if (session.currentTurnState !== "idle") {
      throw new Error("Cannot switch model while a turn is running.");
    }
    const activeModelByAgent = {
      ...(session.activeModelByAgent ?? {}),
      [agentName]: modelId
    };
    const backendSessionIds = { ...session.backendSessionIds };
    delete backendSessionIds[agentName];
    session = {
      ...session,
      activeModelByAgent,
      backendSessionIds
    };
    await this.backends.dispose(agentName);
    if (session.activeAgent === agentName) {
      session = await this.ensureBackendSession(session, agentName);
      this.backends.release(agentName);
    } else {
      await this.store.saveSession(session);
    }
    await this.logger.log("model_switched", { sessionId, agent: agentName, model: modelId });
    return {
      sessionId,
      agentName,
      activeModel: modelId,
      backendSessionId: session.backendSessionIds[agentName]
    };
  }

  private disableAgentForSession(params: unknown): unknown {
    const record = asRecord(params);
    const sessionId = stringField(record, "sessionId");
    const agentName = stringField(record, "agentName");
    if (!sessionId || !agentName) {
      throw new Error("connector/agent/disable requires sessionId and agentName.");
    }
    this.router.disableForSession(sessionId, agentName);
    return { disabled: true, sessionId, agentName };
  }

  private async runAuth(action: import("./types.js").AuthAction, params: unknown): Promise<unknown> {
    const record = asRecord(params);
    const agentName = stringField(record, "agentName") ?? this.config.defaultAgent ?? this.router.chooseInitialAgent().name;
    this.metrics.increment(`auth.${action}.started`);
    await this.logger.log("auth_started", { agent: agentName, action });
    const result = await this.auth.run(agentName, action, (update) => {
      this.peer?.notify("connector/auth_update", update);
    });
    this.metrics.increment(`auth.${action}.${result.status}`);
    await this.logger.log("auth_finished", {
      agent: agentName,
      action,
      status: result.status,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      urls: result.urls
    });
    return result;
  }

  private async approveFailover(params: unknown): Promise<unknown> {
    const record = asRecord(params);
    const proposalId = stringField(record, "proposalId");
    const sessionId = stringField(record, "sessionId");
    const targetAgent = stringField(record, "targetAgent");
    const proposal = proposalId ? this.proposals.get(proposalId) : undefined;
    const resolvedSessionId = proposal?.sessionId ?? sessionId;
    const resolvedTargetAgent = proposal?.toAgent ?? targetAgent;
    if (!resolvedSessionId || !resolvedTargetAgent) {
      throw new Error("connector/failover/approve requires proposalId or sessionId + targetAgent.");
    }
    const session = await this.store.getSession(resolvedSessionId);
    if (session.currentTurnState !== "idle") {
      throw new Error("Cannot approve failover while a turn is running.");
    }
    const result = await this.switchSessionAgent(
      resolvedSessionId,
      resolvedTargetAgent,
      proposal ? `approved_failover:${proposal.capacityKind}` : "approved_failover",
      proposal?.handoffSummary ?? buildHandoffSummary(session, session.pendingTask)
    );
    if (proposalId) {
      this.proposals.delete(proposalId);
    }
    this.metrics.increment("failover.approved");
    return result;
  }

  private async switchSessionAgent(
    sessionId: string,
    agentName: string,
    reason: string,
    handoffSummary: string
  ): Promise<unknown> {
    const agent = this.router.getAgent(agentName);
    if (!agent) {
      throw new Error(`Unknown agent: ${agentName}`);
    }
    let session = await this.store.getSession(sessionId);
    const previous = session.activeAgent;
    session = await this.ensureActiveModel(session, agentName);
    session = {
      ...session,
      activeAgent: agentName,
      handoffSummary,
      routingHistory: [
        ...session.routingHistory,
        {
          at: new Date().toISOString(),
          from: previous,
          to: agentName,
          reason
        }
      ],
      currentTurnState: "idle"
    };
    session = await this.ensureBackendSession(session, agentName);
    this.backends.release(agentName);
    await this.store.saveSession(session);
    this.router.decrementActive(previous);
    this.router.incrementActive(agentName);
    this.metrics.increment("agent.switched");
    await this.logger.log("agent_switched", { sessionId, from: previous, to: agentName, reason });
    this.peer?.notify("connector/agent_switched", {
      sessionId,
      fromAgent: previous,
      toAgent: agentName,
      reason
    });
    return {
      sessionId,
      activeAgent: agentName,
      activeModel: session.activeModelByAgent?.[agentName],
      backendSessionId: session.backendSessionIds[agentName]
    };
  }

  private async ensureBackendSession(session: LogicalSessionState, agentName: string): Promise<LogicalSessionState> {
    session = await this.ensureActiveModel(session, agentName);
    if (session.backendSessionIds[agentName]) {
      return session;
    }
    const agent = this.router.getAgent(agentName);
    if (!agent) {
      throw new Error(`Unknown agent: ${agentName}`);
    }
    const backend = this.backends.get(agent);
    await this.logger.log("backend_session_starting", { sessionId: session.id, agent: agentName });
    try {
      const backendSessionId = await backend.startSession(session);
      const updated = {
        ...session,
        backendSessionIds: {
          ...session.backendSessionIds,
          [agentName]: backendSessionId
        }
      };
      await this.store.saveSession(updated);
      await this.logger.log("backend_session_started", { sessionId: session.id, agent: agentName, backendSessionId });
      return updated;
    } catch (error) {
      this.router.markUnavailable(agentName, error instanceof Error ? error.message : String(error));
      await this.logger.log("backend_session_failed", {
        sessionId: session.id,
        agent: agentName,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  private async ensureActiveModel(session: LogicalSessionState, agentName: string): Promise<LogicalSessionState> {
    const agent = this.router.getAgent(agentName);
    if (!agent?.models?.length) {
      return session;
    }
    const existing = selectedModelForAgent(agent, session);
    if (existing && session.activeModelByAgent?.[agentName] === existing.id) {
      return session;
    }
    const modelId = defaultModelIdForAgent(agent);
    if (!modelId) {
      return session;
    }
    const updated = {
      ...session,
      activeModelByAgent: {
        ...(session.activeModelByAgent ?? {}),
        [agentName]: modelId
      }
    };
    await this.store.saveSession(updated);
    return updated;
  }

  private async inspectSession(params: unknown): Promise<unknown> {
    const id = stringField(asRecord(params), "sessionId") ?? stringField(asRecord(params), "id");
    if (!id) {
      throw new Error("sessions/inspect requires sessionId.");
    }
    return await this.store.getSession(id);
  }

  private async exportSession(params: unknown): Promise<unknown> {
    const id = stringField(asRecord(params), "sessionId") ?? stringField(asRecord(params), "id");
    if (!id) {
      throw new Error("sessions/export requires sessionId.");
    }
    return await this.store.exportSupportBundle({
      sessionId: id,
      configShape: this.configShape(),
      agents: this.publicAgentList(),
      metrics: this.metrics.snapshot(),
      recentEvents: await this.logger.tail()
    });
  }

  private async exportDebugBundle(params: unknown): Promise<unknown> {
    const sessionId = stringField(asRecord(params), "sessionId");
    return await this.store.exportSupportBundle({
      sessionId,
      configShape: this.configShape(),
      agents: this.publicAgentList(),
      metrics: this.metrics.snapshot(),
      recentEvents: await this.logger.tail()
    });
  }

  private publicAgentList(): unknown[] {
    return this.router.listAgents().map((agent) => ({
      name: agent.name,
      persona: agent.persona,
      driver: agent.driver,
      priority: agent.priority,
      enabled: agent.enabled,
      capabilities: agent.capabilities,
      costHint: agent.costHint,
      models: agent.models?.map((model) => ({
        id: model.id,
        label: model.label,
        description: model.description,
        enabled: model.enabled,
        costHint: model.costHint
      })),
      defaultModel: agent.defaultModel,
      auth: {
        configured: Boolean(agent.auth),
        actions: {
          login: Boolean(agent.auth?.login),
          deviceLogin: Boolean(agent.auth?.deviceLogin),
          status: Boolean(agent.auth?.status),
          logout: Boolean(agent.auth?.logout)
        }
      },
      health: agent.health
    }));
  }

  private configShape(): unknown {
    return {
      defaultAgent: this.config.defaultAgent,
      agents: this.config.agents.map((agent) => ({
        name: agent.name,
        driver: agent.driver,
        command: agent.command,
        args: agent.args,
        priority: agent.priority,
        enabled: agent.enabled,
        capabilities: agent.capabilities,
        costHint: agent.costHint,
        models: agent.models?.map((model) => ({
          id: model.id,
          label: model.label,
          enabled: model.enabled,
          costHint: model.costHint,
          args: model.args,
          envKeys: Object.keys(model.env)
        })),
        defaultModel: agent.defaultModel,
        authActions: {
          login: Boolean(agent.auth?.login),
          deviceLogin: Boolean(agent.auth?.deviceLogin),
          status: Boolean(agent.auth?.status),
          logout: Boolean(agent.auth?.logout)
        },
        envKeys: Object.keys(agent.env)
      })),
      failover: this.config.failover,
      state: {
        path: this.config.state.path,
        retentionDays: this.config.state.retentionDays,
        contextBudgetChars: this.config.state.contextBudgetChars
      }
    };
  }
}

function extractPromptText(record: Record<string, unknown>): string {
  if (typeof record.prompt === "string") {
    return record.prompt;
  }
  if (Array.isArray(record.prompt)) {
    return extractTextRecursive(record.prompt);
  }
  if (record.message) {
    return extractTextRecursive(record.message);
  }
  if (record.content) {
    return extractTextRecursive(record.content);
  }
  return extractTextRecursive(record);
}

function extractTextRecursive(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(extractTextRecursive).filter(Boolean).join("\n");
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") {
      return record.text;
    }
    if (Array.isArray(record.content)) {
      return record.content.map(extractTextRecursive).filter(Boolean).join("");
    }
    if (record.update && typeof record.update === "object") {
      return extractTextRecursive(record.update);
    }
    if (record.params && typeof record.params === "object") {
      return extractTextRecursive(record.params);
    }
    if ("sessionUpdate" in record || "type" in record) {
      return "";
    }
    return Object.entries(record)
      .filter(([key]) => !["sessionId", "cwd"].includes(key))
      .map(([, item]) => extractTextRecursive(item))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function extractUpdateText(value: unknown): string {
  return extractTextRecursive(value);
}

function extractFileRefs(record: Record<string, unknown>): string[] {
  const refs = new Set<string>();
  walk(record, (key, value) => {
    if (typeof value === "string" && /file|path|uri/i.test(key) && !value.startsWith("http")) {
      refs.add(value);
    }
  });
  return [...refs].slice(0, 100);
}

function walk(value: unknown, visit: (key: string, value: unknown) => void, key = ""): void {
  visit(key, value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, visit, String(index)));
  } else if (value && typeof value === "object") {
    for (const [childKey, item] of Object.entries(value)) {
      walk(item, visit, childKey);
    }
  }
}

function mergeUnique(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])].slice(0, 200);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  return typeof record[key] === "string" ? (record[key] as string) : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function stringifyResult(value: unknown): string {
  return truncateText(JSON.stringify(value, null, 2), 4000);
}
