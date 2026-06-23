import { access, readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { constants } from "node:fs";
import {
  AgentAuthConfig,
  AgentConfig,
  AgentDriver,
  AgentModelConfig,
  CommandSpec,
  ConnectorConfig,
  LogicalSessionState,
  ValidationResult
} from "./types.js";

type RawObject = Record<string, unknown>;

const DEFAULT_FAILOVER = {
  mode: "ask" as const,
  triggers: ["quota", "rate_limit", "context", "model_unavailable"] as const,
  contextTransfer: "summary_files" as const,
  cooldownMs: 60_000,
  maxRetriesPerAgent: 1
};

const DEFAULT_STATE = {
  path: ".cli-agent-connector/state",
  retentionDays: 14,
  redactionRules: [] as string[],
  contextBudgetChars: 120_000
};

const DEFAULT_LIVEBENCH = {
  enabled: true,
  release: "2026-01-08",
  baseUrl: "https://raw.githubusercontent.com/LiveBench/livebench.github.io/main/public",
  cacheTtlMs: 24 * 60 * 60 * 1000
};

const DEFAULT_LEARNING = {
  mentorContext: {
    enabled: true,
    minScoreGap: 5,
    maxChars: 4000
  }
};

const DEFAULT_DETECTORS = {
  quota: ["quota exceeded", "insufficient_quota", "credit balance", "billing limit"],
  rate_limit: ["rate limit", "rate_limited", "too many requests", "\\b429\\b"],
  context: ["context length", "context window", "too many tokens", "maximum context"],
  model_unavailable: ["model unavailable", "model_not_found", "model is overloaded"]
};

export async function loadConfig(configPath: string): Promise<ConnectorConfig> {
  const validation = await validateConfig(configPath);
  if (!validation.ok || !validation.config) {
    throw new Error(validation.errors.join("\n"));
  }
  return validation.config;
}

export async function validateConfig(configPath: string): Promise<ValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const absolutePath = resolve(configPath);
  let parsed: RawObject;

  try {
    parsed = JSON.parse(await readFile(absolutePath, "utf8")) as RawObject;
  } catch (error) {
    return {
      ok: false,
      errors: [`Unable to read or parse config ${absolutePath}: ${errorMessage(error)}`],
      warnings
    };
  }

  const agentsRaw = Array.isArray(parsed.agents) ? parsed.agents : [];
  if (agentsRaw.length === 0) {
    errors.push("Config must define at least one agent.");
  }

  const agentNames = new Set<string>();
  const agents = agentsRaw.map((item, index) => {
    const raw = asObject(item);
    const name = stringValue(raw.name, `agent-${index + 1}`);
    if (agentNames.has(name)) {
      errors.push(`Duplicate agent name: ${name}`);
    }
    agentNames.add(name);

    const driver: AgentDriver | undefined =
      raw.driver === "stdio-text" ? "stdio-text" : raw.driver === "acp-proxy" ? "acp-proxy" : undefined;
    if (!driver) {
      errors.push(`Agent ${name} must use driver "acp-proxy" or "stdio-text".`);
    }

    const command = stringValue(raw.command, "");
    if (!command) {
      errors.push(`Agent ${name} must define command.`);
    } else {
      warnings.push(...validateCommandHint(name, command));
    }

    const env = normalizeEnv(asObject(raw.env));
    for (const [envName, envValue] of Object.entries(env)) {
      if (looksLikeSecretEnv(envName, envValue) && !isEnvReference(envValue)) {
        errors.push(`Agent ${name} env.${envName} appears to contain a secret. Use "\${env:${envName}}" instead.`);
      }
    }
    const auth = normalizeAuthConfig(asObject(raw.auth), name, errors);
    const models = normalizeModels(raw.models, name, errors);
    const defaultModel = optionalString(raw.defaultModel);
    if (defaultModel) {
      const defaultModelConfig = models.find((model) => model.id === defaultModel);
      if (!defaultModelConfig) {
        errors.push(`Agent ${name} defaultModel "${defaultModel}" does not match any configured model.`);
      } else if (!defaultModelConfig.enabled) {
        errors.push(`Agent ${name} defaultModel "${defaultModel}" cannot reference a disabled model.`);
      }
    }

    return {
      name,
      persona: optionalString(raw.persona),
      driver: driver ?? "stdio-text",
      command,
      args: stringArray(raw.args),
      env,
      models: models.length > 0 ? models : undefined,
      defaultModel,
      auth,
      priority: numberValue(raw.priority, 100),
      enabled: booleanValue(raw.enabled, true),
      capabilities: stringArray(raw.capabilities),
      costHint: numberValue(raw.costHint, 5),
      idleTimeoutMs: numberValue(raw.idleTimeoutMs, 10 * 60_000)
    };
  });

  const failoverRaw = asObject(parsed.failover);
  const stateRaw = asObject(parsed.state);
  const livebenchRaw = asObject(asObject(parsed.benchmarks).livebench);
  const learningRaw = asObject(parsed.learning);
  const mentorRaw = asObject(learningRaw.mentorContext);
  const statePath = stringValue(stateRaw.path, DEFAULT_STATE.path);
  const configDir = dirname(absolutePath);
  const livebenchRelease = stringValue(livebenchRaw.release, DEFAULT_LIVEBENCH.release);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(livebenchRelease)) {
    errors.push(`benchmarks.livebench.release must use YYYY-MM-DD format.`);
  }

  const config: ConnectorConfig = {
    defaultAgent: optionalString(parsed.defaultAgent),
    agents,
    failover: {
      mode: failoverRaw.mode === "auto" || failoverRaw.mode === "manual" ? failoverRaw.mode : DEFAULT_FAILOVER.mode,
      triggers: normalizeTriggers(failoverRaw.triggers),
      contextTransfer:
        failoverRaw.contextTransfer === "full_transcript" || failoverRaw.contextTransfer === "fresh_session"
          ? failoverRaw.contextTransfer
          : DEFAULT_FAILOVER.contextTransfer,
      cooldownMs: numberValue(failoverRaw.cooldownMs, DEFAULT_FAILOVER.cooldownMs),
      maxRetriesPerAgent: numberValue(failoverRaw.maxRetriesPerAgent, DEFAULT_FAILOVER.maxRetriesPerAgent)
    },
    capacityDetectors: normalizeDetectors(asObject(parsed.capacityDetectors)),
    state: {
      path: isAbsolute(statePath) ? statePath : resolve(configDir, statePath),
      retentionDays: numberValue(stateRaw.retentionDays, DEFAULT_STATE.retentionDays),
      redactionRules: stringArray(stateRaw.redactionRules),
      contextBudgetChars: numberValue(stateRaw.contextBudgetChars, DEFAULT_STATE.contextBudgetChars)
    },
    benchmarks: {
      livebench: {
        enabled: booleanValue(livebenchRaw.enabled, DEFAULT_LIVEBENCH.enabled),
        release: livebenchRelease,
        baseUrl: stringValue(livebenchRaw.baseUrl, DEFAULT_LIVEBENCH.baseUrl).replace(/\/+$/, ""),
        cacheTtlMs: numberValue(livebenchRaw.cacheTtlMs, DEFAULT_LIVEBENCH.cacheTtlMs)
      }
    },
    learning: {
      mentorContext: {
        enabled: booleanValue(mentorRaw.enabled, DEFAULT_LEARNING.mentorContext.enabled),
        minScoreGap: numberValue(mentorRaw.minScoreGap, DEFAULT_LEARNING.mentorContext.minScoreGap),
        maxChars: numberValue(mentorRaw.maxChars, DEFAULT_LEARNING.mentorContext.maxChars)
      }
    }
  };

  if (config.defaultAgent && !agentNames.has(config.defaultAgent)) {
    errors.push(`defaultAgent "${config.defaultAgent}" does not match any configured agent.`);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    config: errors.length === 0 ? config : undefined
  };
}

export function resolveAgentEnv(env: Record<string, string>): NodeJS.ProcessEnv {
  const resolved: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value.startsWith("${env:") && value.endsWith("}")) {
      const envName = value.slice(6, -1);
      if (process.env[envName] !== undefined) {
        resolved[key] = process.env[envName];
      }
    } else if (value.startsWith("env:")) {
      const envName = value.slice(4);
      if (process.env[envName] !== undefined) {
        resolved[key] = process.env[envName];
      }
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}

export function selectedModelForAgent(agent: AgentConfig, session?: LogicalSessionState): AgentModelConfig | undefined {
  const selected = session?.activeModelByAgent?.[agent.name] ?? agent.defaultModel;
  return agent.models?.find((model) => model.id === selected && model.enabled);
}

export function defaultModelIdForAgent(agent: AgentConfig): string | undefined {
  if (agent.defaultModel && agent.models?.some((model) => model.id === agent.defaultModel && model.enabled)) {
    return agent.defaultModel;
  }
  return agent.models?.find((model) => model.enabled)?.id;
}

export function modelKeyForAgent(agent: AgentConfig, session?: LogicalSessionState): string {
  return selectedModelForAgent(agent, session)?.id ?? "__agent_default__";
}

export function resolveAgentArgs(agent: AgentConfig, session?: LogicalSessionState): string[] {
  const model = selectedModelForAgent(agent, session);
  return [...agent.args, ...(model?.args ?? [])];
}

export function resolveAgentEnvForSession(agent: AgentConfig, session?: LogicalSessionState): NodeJS.ProcessEnv {
  const model = selectedModelForAgent(agent, session);
  return resolveAgentEnv({
    ...agent.env,
    ...(model?.env ?? {})
  });
}

export function resolveCommandEnv(spec: CommandSpec, inheritedEnv: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...resolveAgentEnv(inheritedEnv),
    ...resolveAgentEnv(spec.env)
  };
}

async function commandExists(command: string): Promise<boolean> {
  if (command.includes("/") || command.includes("\\")) {
    try {
      await access(command, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  const pathParts = (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":");
  const extensions = process.platform === "win32" ? ["", ".cmd", ".exe", ".bat"] : [""];
  for (const part of pathParts) {
    for (const ext of extensions) {
      try {
        await access(resolve(part, `${command}${ext}`), constants.X_OK);
        return true;
      } catch {
        // Continue searching PATH.
      }
    }
  }
  return false;
}

async function validateCommandAvailability(name: string, command: string): Promise<string | undefined> {
  return (await commandExists(command)) ? undefined : `Agent ${name} command "${command}" was not found on PATH.`;
}

export async function validateConfigWithCommandChecks(configPath: string): Promise<ValidationResult> {
  const result = await validateConfig(configPath);
  if (result.config) {
    for (const agent of result.config.agents) {
      const warning = await validateCommandAvailability(agent.name, agent.command);
      if (warning) {
        result.warnings.push(warning);
      }
      for (const [label, command] of authCommands(agent.auth)) {
        const authWarning = await validateCommandAvailability(agent.name, command);
        if (authWarning) {
          result.warnings.push(authWarning.replace(`Agent ${agent.name} command`, `Agent ${agent.name} auth.${label} command`));
        }
      }
    }
  }
  return result;
}

function normalizeTriggers(value: unknown): Array<"quota" | "rate_limit" | "context" | "model_unavailable"> {
  const allowed = new Set(["quota", "rate_limit", "context", "model_unavailable"]);
  const input = Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : DEFAULT_FAILOVER.triggers;
  const normalized = input.filter((item): item is "quota" | "rate_limit" | "context" | "model_unavailable" => allowed.has(item));
  return normalized.length > 0 ? normalized : [...DEFAULT_FAILOVER.triggers];
}

function normalizeDetectors(value: RawObject): ConnectorConfig["capacityDetectors"] {
  const output: ConnectorConfig["capacityDetectors"] = {};
  for (const [agentName, detector] of Object.entries(value)) {
    const raw = asObject(detector);
    output[agentName] = {
      quota: stringArray(raw.quota, DEFAULT_DETECTORS.quota),
      rate_limit: stringArray(raw.rate_limit, DEFAULT_DETECTORS.rate_limit),
      context: stringArray(raw.context, DEFAULT_DETECTORS.context),
      model_unavailable: stringArray(raw.model_unavailable, DEFAULT_DETECTORS.model_unavailable)
    };
  }
  output.default = {
    quota: [...DEFAULT_DETECTORS.quota],
    rate_limit: [...DEFAULT_DETECTORS.rate_limit],
    context: [...DEFAULT_DETECTORS.context],
    model_unavailable: [...DEFAULT_DETECTORS.model_unavailable]
  };
  return output;
}

function normalizeAuthConfig(raw: RawObject, agentName: string, errors: string[]): AgentAuthConfig | undefined {
  if (Object.keys(raw).length === 0) {
    return undefined;
  }

  const auth: AgentAuthConfig = {
    login: normalizeCommandSpec(raw.login, agentName, "login", errors),
    deviceLogin: normalizeCommandSpec(raw.deviceLogin, agentName, "deviceLogin", errors),
    status: normalizeCommandSpec(raw.status, agentName, "status", errors),
    logout: normalizeCommandSpec(raw.logout, agentName, "logout", errors),
    successPatterns: stringArray(raw.successPatterns, ["logged in", "authenticated", "success", "complete"]),
    loggedInPatterns: stringArray(raw.loggedInPatterns, ["logged in", "authenticated", "signed in", "already logged in"]),
    loggedOutPatterns: stringArray(raw.loggedOutPatterns, ["not logged in", "logged out", "not authenticated", "signed out"])
  };

  if (!auth.login && !auth.deviceLogin && !auth.status && !auth.logout) {
    errors.push(`Agent ${agentName} auth must define at least one command: login, deviceLogin, status, or logout.`);
  }

  return auth;
}

function normalizeModels(value: unknown, agentName: string, errors: string[]): AgentModelConfig[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const modelIds = new Set<string>();
  return value
    .map((item, index) => {
      const raw = asObject(item);
      const id = stringValue(raw.id, "");
      if (!id) {
        errors.push(`Agent ${agentName} models[${index}] must define id.`);
      } else if (modelIds.has(id)) {
        errors.push(`Agent ${agentName} has duplicate model id: ${id}`);
      }
      modelIds.add(id);
      const env = normalizeEnv(asObject(raw.env));
      for (const [envName, envValue] of Object.entries(env)) {
        if (looksLikeSecretEnv(envName, envValue) && !isEnvReference(envValue)) {
          errors.push(`Agent ${agentName} model ${id || index} env.${envName} appears to contain a secret. Use "\${env:${envName}}" instead.`);
        }
      }
      return {
        id: id || `model-${index + 1}`,
        label: optionalString(raw.label),
        description: optionalString(raw.description),
        benchmarkModelId: normalizeBenchmarkModelId(raw.benchmarkModelId, agentName, id || `models[${index}]`, errors),
        enabled: booleanValue(raw.enabled, true),
        costHint: typeof raw.costHint === "number" && Number.isFinite(raw.costHint) ? raw.costHint : undefined,
        args: stringArray(raw.args),
        env
      };
    })
    .filter((model) => model.id.length > 0);
}

function normalizeCommandSpec(value: unknown, agentName: string, label: string, errors: string[]): CommandSpec | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as RawObject;
  const command = stringValue(raw.command, "");
  if (!command) {
    errors.push(`Agent ${agentName} auth.${label} must define command.`);
    return undefined;
  }
  const env = normalizeEnv(asObject(raw.env));
  for (const [envName, envValue] of Object.entries(env)) {
    if (looksLikeSecretEnv(envName, envValue) && !isEnvReference(envValue)) {
      errors.push(`Agent ${agentName} auth.${label}.env.${envName} appears to contain a secret. Use "\${env:${envName}}" instead.`);
    }
  }
  return {
    command,
    args: stringArray(raw.args),
    env,
    timeoutMs: numberValue(raw.timeoutMs, 5 * 60_000),
    cwd: optionalString(raw.cwd),
    interactive: booleanValue(raw.interactive, false)
  };
}

function authCommands(auth: AgentAuthConfig | undefined): Array<[string, string]> {
  if (!auth) {
    return [];
  }
  return [
    ["login", auth.login?.command],
    ["deviceLogin", auth.deviceLogin?.command],
    ["status", auth.status?.command],
    ["logout", auth.logout?.command]
  ].filter((entry): entry is [string, string] => typeof entry[1] === "string");
}

function asObject(value: unknown): RawObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RawObject) : {};
}

function stringArray(value: unknown, fallback: string[] = []): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : fallback;
}

function normalizeEnv(raw: RawObject): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") {
      output[key] = value;
    }
  }
  return output;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeBenchmarkModelId(value: unknown, agentName: string, modelId: string, errors: string[]): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    errors.push(`Agent ${agentName} model ${modelId} benchmarkModelId must be a string.`);
    return undefined;
  }
  return value.trim() || undefined;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function isEnvReference(value: string): boolean {
  return (value.startsWith("${env:") && value.endsWith("}")) || value.startsWith("env:");
}

function looksLikeSecretEnv(key: string, value: string): boolean {
  return /secret|token|password|api[_-]?key/i.test(key) || /^sk-[A-Za-z0-9_-]+/.test(value);
}

function validateCommandHint(name: string, command: string): string[] {
  if (/^https?:\/\//.test(command)) {
    return [`Agent ${name} command looks like a URL. Remote ACP transports are not supported in the MVP.`];
  }
  return [];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
