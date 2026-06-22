import { AgentConfig, AgentHealth, CapacityKind, ConnectorConfig, SwitchProposal } from "./types.js";
import { capacityKindToTrigger, isFailoverTriggerEnabled } from "./capacity.js";

export class AgentRouter {
  private readonly health = new Map<string, AgentHealth>();
  private readonly disabledForSession = new Map<string, Set<string>>();

  constructor(private readonly config: ConnectorConfig) {
    for (const agent of config.agents) {
      this.health.set(agent.name, {
        name: agent.name,
        status: agent.enabled ? "healthy" : "disabled",
        reason: agent.enabled ? undefined : "Agent is disabled in config.",
        activeSessionCount: 0
      });
    }
  }

  listAgents(): Array<AgentConfig & { health: AgentHealth }> {
    return this.config.agents.map((agent) => ({
      ...agent,
      health: this.getHealth(agent.name)
    }));
  }

  getHealth(name: string): AgentHealth {
    return (
      this.health.get(name) ?? {
        name,
        status: "unavailable",
        reason: "Agent is not configured.",
        activeSessionCount: 0
      }
    );
  }

  chooseInitialAgent(sessionId?: string): AgentConfig {
    const defaultAgent = this.config.defaultAgent ? this.getAgent(this.config.defaultAgent) : undefined;
    if (defaultAgent && this.isSelectable(defaultAgent, sessionId)) {
      return defaultAgent;
    }

    const selected = this.sortedAgents().find((agent) => this.isSelectable(agent, sessionId));
    if (!selected) {
      throw new Error("No enabled and healthy agents are available.");
    }
    return selected;
  }

  chooseFailoverAgent(currentAgent: string, kind: CapacityKind, sessionId: string): AgentConfig | undefined {
    if (!isFailoverTriggerEnabled(this.config, kind)) {
      return undefined;
    }
    return this.sortedAgents().find((agent) => agent.name !== currentAgent && this.isSelectable(agent, sessionId));
  }

  createSwitchProposal(
    sessionId: string,
    fromAgent: string,
    target: AgentConfig,
    kind: CapacityKind,
    reason: string,
    handoffSummary: string
  ): SwitchProposal {
    return {
      id: `sw_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      sessionId,
      fromAgent,
      toAgent: target.name,
      capacityKind: kind,
      reason,
      handoffSummary,
      createdAt: new Date().toISOString()
    };
  }

  markLimited(agentName: string, kind: CapacityKind, reason: string): void {
    const existing = this.getHealth(agentName);
    const trigger = capacityKindToTrigger(kind);
    const limitedUntil =
      trigger === "rate_limit" || trigger === "quota" ? Date.now() + this.config.failover.cooldownMs : undefined;
    this.health.set(agentName, {
      ...existing,
      status: "limited",
      reason,
      limitedKind: kind,
      limitedUntil
    });
  }

  markHealthy(agentName: string): void {
    const existing = this.getHealth(agentName);
    this.health.set(agentName, {
      ...existing,
      status: "healthy",
      reason: undefined,
      limitedKind: undefined,
      limitedUntil: undefined,
      lastCheckedAt: Date.now()
    });
  }

  markUnavailable(agentName: string, reason: string): void {
    const existing = this.getHealth(agentName);
    this.health.set(agentName, {
      ...existing,
      status: "unavailable",
      reason,
      lastCheckedAt: Date.now()
    });
  }

  disableForSession(sessionId: string, agentName: string): void {
    const disabled = this.disabledForSession.get(sessionId) ?? new Set<string>();
    disabled.add(agentName);
    this.disabledForSession.set(sessionId, disabled);
  }

  incrementActive(agentName: string): void {
    const existing = this.getHealth(agentName);
    this.health.set(agentName, {
      ...existing,
      activeSessionCount: existing.activeSessionCount + 1
    });
  }

  decrementActive(agentName: string): void {
    const existing = this.getHealth(agentName);
    this.health.set(agentName, {
      ...existing,
      activeSessionCount: Math.max(0, existing.activeSessionCount - 1)
    });
  }

  getAgent(name: string): AgentConfig | undefined {
    return this.config.agents.find((agent) => agent.name === name);
  }

  private isSelectable(agent: AgentConfig, sessionId?: string): boolean {
    if (!agent.enabled) {
      return false;
    }
    if (sessionId && this.disabledForSession.get(sessionId)?.has(agent.name)) {
      return false;
    }
    const health = this.getHealth(agent.name);
    if (health.status === "disabled" || health.status === "unavailable") {
      return false;
    }
    if (health.status === "limited" && (!health.limitedUntil || health.limitedUntil > Date.now())) {
      return false;
    }
    if (health.status === "limited" && health.limitedUntil && health.limitedUntil <= Date.now()) {
      this.markHealthy(agent.name);
    }
    return true;
  }

  private sortedAgents(): AgentConfig[] {
    return [...this.config.agents].sort((a, b) => {
      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }
      return a.costHint - b.costHint;
    });
  }
}
