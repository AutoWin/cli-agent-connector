import readline from "node:readline";

let nextId = 1;
const sessions = new Set();
const pending = new Map();
const modelArgIndex = process.argv.indexOf("--model");
const activeModel = modelArgIndex >= 0 ? process.argv[modelArgIndex + 1] : "agent-default";

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) {
    return;
  }
  const msg = JSON.parse(line);
  if ("id" in msg && !msg.method) {
    const pendingRequest = pending.get(msg.id);
    if (pendingRequest) {
      pending.delete(msg.id);
      pendingRequest(msg);
    }
    return;
  }
  if (!msg.method) {
    return;
  }

  if (msg.method === "initialize") {
    respond(msg.id, { protocolVersion: 1, agentInfo: { name: "fake-acp-agent" } });
    return;
  }
  if (msg.method === "initialized") {
    return;
  }
  if (msg.method === "session/new") {
    const sessionId = `fake-session-${activeModel}-${nextId++}`;
    sessions.add(sessionId);
    respond(msg.id, { sessionId });
    return;
  }
  if (msg.method === "session/prompt") {
    const text = JSON.stringify(msg.params ?? {});
    notify("session/update", {
      sessionId: msg.params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: [{ type: "text", text: `fake-acp-stream:${activeModel}` }]
      }
    });
    if (/quota/i.test(text)) {
      respond(msg.id, { stopReason: "quota_exhausted" });
      return;
    }
    respond(msg.id, { stopReason: "end_turn" });
    return;
  }
  if (msg.method === "session/cancel") {
    respond(msg.id, { cancelled: true });
    return;
  }
  respondError(msg.id, -32601, `Method not found: ${msg.method}`);
});

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function respondError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

function notify(method, params) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}
