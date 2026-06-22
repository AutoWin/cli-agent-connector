import { CapacityDetectorConfig, CapacityKind, ConnectorConfig } from "./types.js";

const STRUCTURED_KEYWORDS: Array<[CapacityKind, RegExp[]]> = [
  ["quota_exhausted", [/quota/i, /insufficient[_\s-]?quota/i, /billing/i, /credit/i]],
  ["rate_limited", [/rate[_\s-]?limit/i, /too many requests/i, /\b429\b/i]],
  ["context_exhausted", [/context/i, /too many tokens/i, /maximum tokens/i]],
  ["model_unavailable", [/model[_\s-]?(unavailable|not_found)/i, /overloaded/i]]
];

export function capacityKindToTrigger(kind: CapacityKind): "quota" | "rate_limit" | "context" | "model_unavailable" | "unknown" {
  switch (kind) {
    case "quota_exhausted":
      return "quota";
    case "rate_limited":
      return "rate_limit";
    case "context_exhausted":
      return "context";
    case "model_unavailable":
      return "model_unavailable";
    default:
      return "unknown";
  }
}

export function detectCapacity(
  agentName: string,
  config: ConnectorConfig,
  text: string,
  structured?: unknown
): CapacityKind | undefined {
  const structuredKind = detectStructuredCapacity(structured);
  if (structuredKind) {
    return structuredKind;
  }

  const detector = {
    ...config.capacityDetectors.default,
    ...(config.capacityDetectors[agentName] ?? {})
  } satisfies CapacityDetectorConfig;

  const normalizedText = text.toLowerCase();
  if (matchesAny(normalizedText, detector.quota)) {
    return "quota_exhausted";
  }
  if (matchesAny(normalizedText, detector.rate_limit)) {
    return "rate_limited";
  }
  if (matchesAny(normalizedText, detector.context)) {
    return "context_exhausted";
  }
  if (matchesAny(normalizedText, detector.model_unavailable)) {
    return "model_unavailable";
  }
  return undefined;
}

export function isFailoverTriggerEnabled(config: ConnectorConfig, kind: CapacityKind): boolean {
  const trigger = capacityKindToTrigger(kind);
  return trigger !== "unknown" && config.failover.triggers.includes(trigger);
}

function matchesAny(text: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    try {
      return new RegExp(pattern, "i").test(text);
    } catch {
      return text.includes(pattern.toLowerCase());
    }
  });
}

function detectStructuredCapacity(value: unknown): CapacityKind | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const json = JSON.stringify(value);

  const direct = findCapacityByString(json);
  if (direct) {
    return direct;
  }

  const maybeStopReason = extractString(value, ["stopReason", "reason", "code", "message"]);
  return maybeStopReason ? findCapacityByString(maybeStopReason) : undefined;
}

function findCapacityByString(value: string): CapacityKind | undefined {
  for (const [kind, patterns] of STRUCTURED_KEYWORDS) {
    if (patterns.some((pattern) => pattern.test(value))) {
      return kind;
    }
  }
  return undefined;
}

function extractString(value: unknown, keys: string[]): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const field = record[key];
    if (typeof field === "string") {
      return field;
    }
  }
  for (const field of Object.values(record)) {
    const nested = extractString(field, keys);
    if (nested) {
      return nested;
    }
  }
  return undefined;
}
