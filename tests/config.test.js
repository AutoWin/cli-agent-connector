import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateConfig } from "../dist/config.js";

test("validateConfig applies defaults and rejects inline secrets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cac-config-"));
  const badConfig = join(dir, "bad.json");
  await writeFile(
    badConfig,
    JSON.stringify({
      agents: [
        {
          name: "codex",
          driver: "stdio-text",
          command: "node",
          env: { OPENAI_API_KEY: "sk-inline-secret" }
        }
      ]
    })
  );

  const bad = await validateConfig(badConfig);
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join("\n"), /appears to contain a secret/);

  const goodConfig = join(dir, "good.json");
  await writeFile(
    goodConfig,
    JSON.stringify({
      defaultAgent: "codex",
      agents: [
        {
          name: "codex",
          driver: "stdio-text",
          command: "node",
          env: { OPENAI_API_KEY: "${env:OPENAI_API_KEY}" }
        }
      ]
    })
  );
  const good = await validateConfig(goodConfig);
  assert.equal(good.ok, true);
  assert.equal(good.config.agents[0].priority, 100);
  assert.equal(good.config.failover.mode, "ask");
});

test("validateConfig normalizes models and rejects invalid defaults", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cac-config-models-"));
  const goodConfig = join(dir, "good-models.json");
  await writeFile(
    goodConfig,
    JSON.stringify({
      defaultAgent: "antigravity",
      agents: [
        {
          name: "antigravity",
          driver: "stdio-text",
          command: "agy",
          args: ["--print", "{prompt}"],
          defaultModel: "flash",
          models: [
            {
              id: "flash",
              label: "Flash",
              args: ["--model", "Flash"],
              env: { SAFE_MODEL_ENV: "ok" },
              costHint: 1
            }
          ]
        }
      ]
    })
  );
  const good = await validateConfig(goodConfig);
  assert.equal(good.ok, true);
  assert.equal(good.config.agents[0].models[0].enabled, true);
  assert.deepEqual(good.config.agents[0].models[0].args, ["--model", "Flash"]);

  const badConfig = join(dir, "bad-models.json");
  await writeFile(
    badConfig,
    JSON.stringify({
      agents: [
        {
          name: "bad",
          driver: "stdio-text",
          command: "node",
          defaultModel: "missing",
          models: [
            { id: "dup", args: [] },
            { id: "dup", args: [] },
            { id: "off", enabled: false, args: [] }
          ]
        }
      ]
    })
  );
  const bad = await validateConfig(badConfig);
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join("\n"), /duplicate model id/);
  assert.match(bad.errors.join("\n"), /defaultModel "missing"/);

  const disabledDefaultConfig = join(dir, "disabled-default.json");
  await writeFile(
    disabledDefaultConfig,
    JSON.stringify({
      agents: [
        {
          name: "bad-default",
          driver: "stdio-text",
          command: "node",
          defaultModel: "off",
          models: [{ id: "off", enabled: false }]
        }
      ]
    })
  );
  const disabledDefault = await validateConfig(disabledDefaultConfig);
  assert.equal(disabledDefault.ok, false);
  assert.match(disabledDefault.errors.join("\n"), /cannot reference a disabled model/);
});
