import { AcpProxyBackend } from "./acp-proxy.js";
import { StdioTextBackend } from "./stdio-text.js";
import { AgentBackend, AgentConfig, ConnectorConfig } from "../types.js";

export class BackendFactory {
  private readonly backends = new Map<string, AgentBackend>();
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly config: ConnectorConfig) {}

  get(agent: AgentConfig): AgentBackend {
    this.clearIdleTimer(agent.name);
    const existing = this.backends.get(agent.name);
    if (existing) {
      return existing;
    }
    const backend =
      agent.driver === "acp-proxy" ? new AcpProxyBackend(agent, this.config) : new StdioTextBackend(agent, this.config);
    this.backends.set(agent.name, backend);
    return backend;
  }

  release(agentName: string): void {
    const backend = this.backends.get(agentName);
    if (!backend || backend.agent.idleTimeoutMs <= 0) {
      return;
    }
    this.clearIdleTimer(agentName);
    const timer = setTimeout(() => {
      void backend.dispose().finally(() => {
        this.backends.delete(agentName);
        this.idleTimers.delete(agentName);
      });
    }, backend.agent.idleTimeoutMs);
    timer.unref();
    this.idleTimers.set(agentName, timer);
  }

  async dispose(agentName: string): Promise<void> {
    this.clearIdleTimer(agentName);
    const backend = this.backends.get(agentName);
    if (!backend) {
      return;
    }
    await backend.dispose();
    this.backends.delete(agentName);
  }

  async disposeAll(): Promise<void> {
    for (const timer of this.idleTimers.values()) {
      clearTimeout(timer);
    }
    this.idleTimers.clear();
    await Promise.all([...this.backends.values()].map((backend) => backend.dispose()));
    this.backends.clear();
  }

  private clearIdleTimer(agentName: string): void {
    const timer = this.idleTimers.get(agentName);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(agentName);
    }
  }
}
