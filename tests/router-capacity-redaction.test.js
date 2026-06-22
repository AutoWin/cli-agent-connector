import test from "node:test";
import assert from "node:assert/strict";
import { detectCapacity } from "../dist/capacity.js";
import { AgentRouter } from "../dist/router.js";
import { Redactor } from "../dist/redaction.js";

const config = {
  defaultAgent: "a",
  agents: [
    {
      name: "a",
      driver: "stdio-text",
      command: "node",
      args: [],
      env: {},
      priority: 1,
      enabled: true,
      capabilities: ["code"],
      costHint: 5,
      idleTimeoutMs: 1000
    },
    {
      name: "b",
      driver: "stdio-text",
      command: "node",
      args: [],
      env: {},
      priority: 2,
      enabled: true,
      capabilities: ["code"],
      costHint: 1,
      idleTimeoutMs: 1000
    }
  ],
  failover: {
    mode: "ask",
    triggers: ["quota", "rate_limit", "context", "model_unavailable"],
    contextTransfer: "summary_files",
    cooldownMs: 60000,
    maxRetriesPerAgent: 1
  },
  capacityDetectors: {
    default: {
      quota: ["quota exceeded"],
      rate_limit: ["rate limit"],
      context: ["context window"],
      model_unavailable: ["model unavailable"]
    }
  },
  state: {
    path: "/tmp/unused",
    retentionDays: 1,
    redactionRules: [],
    contextBudgetChars: 1000
  }
};

test("router selects failover agent after capacity limit", () => {
  const router = new AgentRouter(config);
  assert.equal(router.chooseInitialAgent().name, "a");
  router.markLimited("a", "quota_exhausted", "quota exceeded");
  assert.equal(router.chooseFailoverAgent("a", "quota_exhausted", "s1").name, "b");
});

test("capacity detectors normalize known limit messages", () => {
  assert.equal(detectCapacity("a", config, "quota exceeded for account"), "quota_exhausted");
  assert.equal(detectCapacity("a", config, "context window is full"), "context_exhausted");
});

test("redactor removes secrets recursively", () => {
  const redactor = new Redactor([]);
  const result = redactor.redact({ env: { OPENAI_API_KEY: "sk-abc123SECRET" }, text: "token=abcdef0123456789" });
  assert.equal(result.env.OPENAI_API_KEY, "[REDACTED]");
  assert.match(result.text, /\[REDACTED\]/);
});
