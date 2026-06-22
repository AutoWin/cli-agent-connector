#!/usr/bin/env node
import { loadConfig, validateConfigWithCommandChecks } from "./config.js";
import { ConnectorServer } from "./server.js";
import { AgentRouter } from "./router.js";
import { StateStore } from "./state.js";
import { Redactor } from "./redaction.js";
import { AuthService } from "./auth.js";
import { AuthAction } from "./types.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  const configPath = readFlag(args, "--config") ?? "cli-agent-connector.config.json";

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "serve") {
    const config = await loadConfig(configPath);
    const server = new ConnectorServer(config);
    process.on("SIGINT", () => {
      void server.stop().finally(() => process.exit(130));
    });
    process.on("SIGTERM", () => {
      void server.stop().finally(() => process.exit(143));
    });
    await server.start(process.stdin, process.stdout);
    return;
  }

  if (command === "validate") {
    const result = await validateConfigWithCommandChecks(configPath);
    for (const warning of result.warnings) {
      process.stderr.write(`warning: ${warning}\n`);
    }
    if (!result.ok) {
      for (const error of result.errors) {
        process.stderr.write(`error: ${error}\n`);
      }
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify({ ok: true, agentCount: result.config?.agents.length ?? 0 }, null, 2));
    return;
  }

  if (command === "agents") {
    await handleAgents(args.slice(1), configPath);
    return;
  }

  if (command === "sessions") {
    await handleSessions(args.slice(1), configPath);
    return;
  }

  if (command === "auth") {
    await handleAuth(args.slice(1), configPath);
    return;
  }

  printHelp();
  process.exitCode = 1;
}

async function handleAgents(args: string[], configPath: string): Promise<void> {
  const subcommand = args[0] ?? "list";
  const config = await loadConfig(configPath);
  const router = new AgentRouter(config);
  if (subcommand === "list") {
    console.log(JSON.stringify(router.listAgents(), null, 2));
    return;
  }
  if (subcommand === "health") {
    console.log(JSON.stringify(router.listAgents().map((agent) => agent.health), null, 2));
    return;
  }
  if (subcommand === "switch") {
    const agentName = args[1];
    if (!agentName) {
      throw new Error("agents switch requires an agent name. Runtime switching should normally use connector/agent/switch.");
    }
    const agent = router.getAgent(agentName);
    if (!agent) {
      throw new Error(`Unknown agent: ${agentName}`);
    }
    console.log(JSON.stringify({ ok: true, agent }, null, 2));
    return;
  }
  throw new Error(`Unknown agents subcommand: ${subcommand}`);
}

async function handleSessions(args: string[], configPath: string): Promise<void> {
  const subcommand = args[0] ?? "list";
  const config = await loadConfig(configPath);
  const store = new StateStore(config, new Redactor(config.state.redactionRules));
  await store.init();

  if (subcommand === "list") {
    const sessions = await store.listSessions();
    console.log(JSON.stringify(sessions, null, 2));
    return;
  }

  if (subcommand === "inspect") {
    const id = args[1];
    if (!id) {
      throw new Error("sessions inspect requires a session id.");
    }
    console.log(JSON.stringify(await store.getSession(id), null, 2));
    return;
  }

  if (subcommand === "export") {
    const id = args[1];
    if (!id) {
      throw new Error("sessions export requires a session id.");
    }
    console.log(
      JSON.stringify(
        await store.exportSupportBundle({
          sessionId: id,
          configShape: {
            defaultAgent: config.defaultAgent,
            agents: config.agents.map((agent) => ({
              name: agent.name,
              driver: agent.driver,
              command: agent.command,
              envKeys: Object.keys(agent.env)
            }))
          },
          agents: config.agents.map((agent) => ({ name: agent.name, driver: agent.driver, enabled: agent.enabled })),
          metrics: {},
          recentEvents: ""
        }),
        null,
        2
      )
    );
    return;
  }

  throw new Error(`Unknown sessions subcommand: ${subcommand}`);
}

async function handleAuth(args: string[], configPath: string): Promise<void> {
  const subcommand = args[0] as AuthAction | "list" | undefined;
  const config = await loadConfig(configPath);
  const redactor = new Redactor(config.state.redactionRules);
  const auth = new AuthService(config.agents, redactor);

  if (!subcommand || subcommand === "list") {
    console.log(JSON.stringify(auth.list(), null, 2));
    return;
  }

  if (!["login", "device-login", "status", "logout"].includes(subcommand)) {
    throw new Error(`Unknown auth subcommand: ${subcommand}`);
  }

  const agentName = args[1] ?? config.defaultAgent;
  if (!agentName) {
    throw new Error("auth command requires an agent name when defaultAgent is not configured.");
  }

  const result = await auth.run(agentName, subcommand, (update) => {
    if (update.stream === "stderr") {
      process.stderr.write(update.text);
    } else if (update.stream === "stdout") {
      process.stdout.write(update.text);
    } else {
      process.stderr.write(`${update.text}\n`);
    }
    for (const url of update.urls) {
      process.stderr.write(`auth URL: ${url}\n`);
    }
  });
  console.log(`\n${JSON.stringify(result, null, 2)}`);
  if (result.status === "failed" || result.status === "not_configured") {
    process.exitCode = 1;
  }
}

function readFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function printHelp(): void {
  console.log(`cli-agent-connector

Usage:
  cli-agent-connector serve --config <path>
  cli-agent-connector validate --config <path>
  cli-agent-connector agents list|health|switch <name> --config <path>
  cli-agent-connector auth list|login|device-login|status|logout [agent] --config <path>
  cli-agent-connector sessions list|inspect <id>|export <id> --config <path>
`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
