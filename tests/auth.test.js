import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { AuthService } from "../dist/auth.js";
import { Redactor } from "../dist/redaction.js";

test("AuthService runs browser login command and extracts URLs", async () => {
  const fakeAuth = resolve("tests/fixtures/fake-auth-agent.mjs");
  const updates = [];
  const auth = new AuthService(
    [
      {
        name: "codex",
        driver: "stdio-text",
        command: "node",
        args: [],
        env: {},
        auth: {
          login: {
            command: process.execPath,
            args: [fakeAuth, "login"],
            env: {},
            timeoutMs: 10000,
            interactive: false
          },
          status: {
            command: process.execPath,
            args: [fakeAuth, "status"],
            env: {},
            timeoutMs: 10000,
            interactive: false
          },
          successPatterns: ["logged in"],
          loggedInPatterns: ["signed in"],
          loggedOutPatterns: ["not logged in"]
        },
        priority: 1,
        enabled: true,
        capabilities: ["code"],
        costHint: 1,
        idleTimeoutMs: 1000
      }
    ],
    new Redactor([])
  );

  const result = await auth.run("codex", "login", (update) => updates.push(update));
  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.urls, ["https://login.example.test/device"]);
  assert.equal(updates.some((update) => update.urls.includes("https://login.example.test/device")), true);

  const status = await auth.run("codex", "status");
  assert.equal(status.status, "succeeded");
});
