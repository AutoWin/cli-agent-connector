import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ConnectorServer } from "../dist/server.js";
import { JsonRpcPeer } from "../dist/jsonrpc.js";

test("server proposes and approves failover for text backend quota exhaustion", async () => {
  const statePath = await mkdtemp(join(tmpdir(), "cac-state-"));
  const fakeText = resolve("tests/fixtures/fake-text-agent.mjs");
  const config = makeConfig(statePath, fakeText);
  const { server, client } = await startInProcessServer(config);
  const proposals = [];
  client.onNotification("connector/failover_proposal", (params) => proposals.push(params));
  client.onRequest("session/request_permission", () => ({ outcome: "approved" }));

  const created = await client.request("session/new", { cwd: process.cwd() });
  assert.equal(created.activeAgent, "primary");
  const result = await client.request("session/prompt", { sessionId: created.sessionId, prompt: "please hit TRIGGER_QUOTA" });
  assert.equal(result.capacityKind, "quota_exhausted");
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].toAgent, "fallback");

  const switched = await client.request("connector/failover/approve", { proposalId: proposals[0].id });
  assert.equal(switched.activeAgent, "fallback");

  const ok = await client.request("session/prompt", { sessionId: created.sessionId, prompt: "continue normally" });
  assert.equal(ok.activeAgent, "fallback");
  assert.equal(ok.stopReason, "end_turn");

  await server.stop();
});

test("server handles ACP proxy streaming and structured quota failover", async () => {
  const statePath = await mkdtemp(join(tmpdir(), "cac-state-"));
  const fakeText = resolve("tests/fixtures/fake-text-agent.mjs");
  const fakeAcp = resolve("tests/fixtures/fake-acp-agent.mjs");
  const config = makeConfig(statePath, fakeText);
  config.defaultAgent = "primary-acp";
  config.agents[0] = {
    ...config.agents[0],
    name: "primary-acp",
    driver: "acp-proxy",
    command: process.execPath,
    args: [fakeAcp]
  };

  const { server, client } = await startInProcessServer(config);
  const proposals = [];
  const updates = [];
  client.onNotification("connector/failover_proposal", (params) => proposals.push(params));
  client.onNotification("session/update", (params) => updates.push(params));

  const created = await client.request("session/new", { cwd: process.cwd() });
  assert.equal(created.activeAgent, "primary-acp");

  const normal = await client.request("session/prompt", { sessionId: created.sessionId, prompt: "hello acp" });
  assert.equal(normal.stopReason, "end_turn");
  assert.equal(updates.length > 0, true);
  const inspectedNormal = await client.request("sessions/inspect", { sessionId: created.sessionId });
  assert.doesNotMatch(inspectedNormal.transcript.at(-1).text, /agent_message_chunk/);
  assert.match(inspectedNormal.transcript.at(-1).text, /fake-acp-stream/);

  const result = await client.request("session/prompt", { sessionId: created.sessionId, prompt: "quota please" });
  assert.equal(result.capacityKind, "quota_exhausted");
  assert.equal(proposals.at(-1).toAgent, "fallback");

  await server.stop();
});

test("text backend closes stdin when prompt is supplied as an argument", async () => {
  const statePath = await mkdtemp(join(tmpdir(), "cac-state-"));
  const fakeText = resolve("tests/fixtures/fake-text-agent.mjs");
  const fakeArgAgent = resolve("tests/fixtures/fake-arg-stdin-agent.mjs");
  const config = makeConfig(statePath, fakeText);
  config.agents[0] = {
    ...config.agents[0],
    command: process.execPath,
    args: [fakeArgAgent, "{prompt}"]
  };

  const { server, client } = await startInProcessServer(config);
  const updates = [];
  client.onNotification("session/update", (params) => updates.push(params));

  const created = await client.request("session/new", { cwd: process.cwd() });
  const result = await client.request("session/prompt", { sessionId: created.sessionId, prompt: "hello arg prompt" });

  assert.equal(result.stopReason, "end_turn");
  assert.match(JSON.stringify(updates), /arg-agent-ok: hello arg prompt; stdin=0/);

  await server.stop();
});

test("server persists prompt attachments and sends attachment context to backend", async () => {
  const statePath = await mkdtemp(join(tmpdir(), "cac-state-"));
  const fakeText = resolve("tests/fixtures/fake-text-agent.mjs");
  const config = makeConfig(statePath, fakeText);
  const { server, client } = await startInProcessServer(config);

  const created = await client.request("session/new", { cwd: process.cwd() });
  await client.request("session/prompt", {
    sessionId: created.sessionId,
    prompt: "use attached context",
    attachments: [
      {
        id: "att1",
        kind: "file",
        label: "notes.txt",
        path: "notes.txt",
        content: "ATTACHMENT_SENTINEL"
      }
    ]
  });
  const inspected = await client.request("sessions/inspect", { sessionId: created.sessionId });

  assert.equal(inspected.transcript[0].attachments[0].label, "notes.txt");
  assert.equal(inspected.relevantFiles.includes("notes.txt"), true);
  assert.match(inspected.transcript.at(-1).text, /ATTACHMENT_SENTINEL/);

  await server.stop();
});

test("server switches configured stdio model and passes model args/env", async () => {
  const statePath = await mkdtemp(join(tmpdir(), "cac-state-"));
  const fakeText = resolve("tests/fixtures/fake-text-agent.mjs");
  const fakeModelAgent = resolve("tests/fixtures/fake-model-agent.mjs");
  const config = makeConfig(statePath, fakeText);
  config.agents[0] = {
    ...config.agents[0],
    command: process.execPath,
    args: [fakeModelAgent, "{prompt}"],
    defaultModel: "small",
    models: [
      {
        id: "small",
        label: "Small",
        enabled: true,
        args: ["--model", "small-model"],
        env: { FAKE_MODEL: "small-env" }
      },
      {
        id: "large",
        label: "Large",
        enabled: true,
        args: ["--model", "large-model"],
        env: { FAKE_MODEL: "large-env" }
      }
    ]
  };

  const { server, client } = await startInProcessServer(config);
  const created = await client.request("session/new", { cwd: process.cwd() });
  let inspected = await client.request("sessions/inspect", { sessionId: created.sessionId });
  assert.equal(inspected.activeModelByAgent.primary, "small");

  await client.request("connector/model/switch", { sessionId: created.sessionId, agentName: "primary", modelId: "large" });
  await client.request("session/prompt", { sessionId: created.sessionId, prompt: "hello model" });
  inspected = await client.request("sessions/inspect", { sessionId: created.sessionId });
  assert.equal(inspected.activeModelByAgent.primary, "large");
  assert.match(inspected.transcript.at(-1).text, /large-model/);
  assert.match(inspected.transcript.at(-1).text, /large-env/);

  await assert.rejects(
    () => client.request("connector/model/switch", { sessionId: created.sessionId, agentName: "primary", modelId: "missing" }),
    /does not support enabled model/
  );

  await server.stop();
});

test("ACP backend restarts with selected model after model switch", async () => {
  const statePath = await mkdtemp(join(tmpdir(), "cac-state-"));
  const fakeText = resolve("tests/fixtures/fake-text-agent.mjs");
  const fakeAcp = resolve("tests/fixtures/fake-acp-agent.mjs");
  const config = makeConfig(statePath, fakeText);
  config.defaultAgent = "primary-acp";
  config.agents[0] = {
    ...config.agents[0],
    name: "primary-acp",
    driver: "acp-proxy",
    command: process.execPath,
    args: [fakeAcp],
    defaultModel: "m1",
    models: [
      { id: "m1", label: "Model One", enabled: true, args: ["--model", "m1"], env: {} },
      { id: "m2", label: "Model Two", enabled: true, args: ["--model", "m2"], env: {} }
    ]
  };

  const { server, client } = await startInProcessServer(config);
  const updates = [];
  client.onNotification("session/update", (params) => updates.push(params));

  const created = await client.request("session/new", { cwd: process.cwd() });
  await client.request("session/prompt", { sessionId: created.sessionId, prompt: "first" });
  assert.match(JSON.stringify(updates), /fake-acp-stream:m1/);

  await client.request("connector/model/switch", { sessionId: created.sessionId, agentName: "primary-acp", modelId: "m2" });
  await client.request("session/prompt", { sessionId: created.sessionId, prompt: "second" });
  assert.match(JSON.stringify(updates), /fake-acp-stream:m2/);

  const inspected = await client.request("sessions/inspect", { sessionId: created.sessionId });
  assert.equal(inspected.activeModelByAgent["primary-acp"], "m2");

  await server.stop();
});

test("server exposes auth login over JSON-RPC with streaming updates", async () => {
  const statePath = await mkdtemp(join(tmpdir(), "cac-state-"));
  const fakeText = resolve("tests/fixtures/fake-text-agent.mjs");
  const fakeAuth = resolve("tests/fixtures/fake-auth-agent.mjs");
  const config = makeConfig(statePath, fakeText);
  config.agents[0].auth = {
    login: {
      command: process.execPath,
      args: [fakeAuth, "login"],
      env: {},
      timeoutMs: 10000,
      interactive: false
    },
    successPatterns: ["logged in"],
    loggedInPatterns: ["signed in"],
    loggedOutPatterns: ["not logged in"]
  };

  const { server, client } = await startInProcessServer(config);
  const updates = [];
  client.onNotification("connector/auth_update", (params) => updates.push(params));

  const result = await client.request("connector/auth/login", { agentName: "primary" });
  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.urls, ["https://login.example.test/device"]);
  assert.equal(updates.some((update) => update.urls.includes("https://login.example.test/device")), true);

  await server.stop();
});

async function startInProcessServer(config) {
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();
  const server = new ConnectorServer(config);
  await server.start(clientToServer, serverToClient);
  const client = new JsonRpcPeer(serverToClient, clientToServer, { requestTimeoutMs: 10000 });
  client.start();
  await client.request("initialize", {});
  return { server, client };
}

function makeConfig(statePath, fakeText) {
  return {
    defaultAgent: "primary",
    agents: [
      {
        name: "primary",
        persona: "Primary test agent",
        driver: "stdio-text",
        command: process.execPath,
        args: [fakeText],
        env: {},
        priority: 1,
        enabled: true,
        capabilities: ["code"],
        costHint: 3,
        idleTimeoutMs: 1000
      },
      {
        name: "fallback",
        persona: "Fallback test agent",
        driver: "stdio-text",
        command: process.execPath,
        args: [fakeText],
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
      path: statePath,
      retentionDays: 1,
      redactionRules: [],
      contextBudgetChars: 1000
    }
  };
}
