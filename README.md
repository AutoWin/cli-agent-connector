# CLI Agent Connector

Multi-agent CLI connector that exposes local coding agents to IDEs through the Agent Client Protocol (ACP).

The MVP focuses on local stdio ACP, multi-agent routing, quota/rate/context failover proposals, deterministic handoff summaries, redacted state, structured logs, and a VS Code client surface.

## Quick Start

```bash
npm install
npm run build
node dist/cli.js validate --config cli-agent-connector.config.example.json
node dist/cli.js serve --config cli-agent-connector.config.example.json
```

If you are following the local `AGENTS.md` convention for this workspace, prefix shell commands with `rtk`:

```bash
rtk npm install
rtk npm run build
rtk node dist/cli.js validate --config cli-agent-connector.config.example.json
```

## CLI

```bash
cli-agent-connector serve --config <path>
cli-agent-connector validate --config <path>
cli-agent-connector agents list --config <path>
cli-agent-connector agents health --config <path>
cli-agent-connector auth list --config <path>
cli-agent-connector auth login <agent> --config <path>
cli-agent-connector auth device-login <agent> --config <path>
cli-agent-connector auth logout <agent> --config <path>
cli-agent-connector sessions list --config <path>
cli-agent-connector sessions inspect <id> --config <path>
cli-agent-connector sessions export <id> --config <path>
```

## Config

See `cli-agent-connector.config.example.json`.

Secret values should not be placed in config. Use `${env:NAME}` references and provide the actual values via your shell, VS Code secret storage, or local environment files.

## Browser Login

Agents can define auth commands for browser and device-code login. The connector runs those commands, streams output back to the IDE, detects login URLs, and never reads or stores provider tokens.

For Codex-style auth, configure `auth.login` as `codex login`, `auth.deviceLogin` as `codex login --device-auth`, and `auth.logout` as `codex logout`. Codex owns the credential cache and browser callback.

### Run Codex Login

Build the connector first:

```bash
rtk npm install
rtk npm run build
```

Check that the `codex` auth actions are configured:

```bash
rtk node dist/cli.js auth list --config cli-agent-connector.config.example.json
```

Start browser login for the `codex` agent:

```bash
rtk node dist/cli.js auth login codex --config cli-agent-connector.config.example.json
```

Codex will open a browser window or print a login URL. Complete the login in the browser; Codex stores its own credential cache.

If browser login does not work in a remote or headless environment, use device-code login:

```bash
rtk node dist/cli.js auth device-login codex --config cli-agent-connector.config.example.json
```

To log out:

```bash
rtk node dist/cli.js auth logout codex --config cli-agent-connector.config.example.json
```

### Use Your Local Config

For day-to-day usage, copy the `auth` block from `cli-agent-connector.config.example.json` into your local `cli-agent-connector.config.json` under the `codex` agent, then run:

```bash
rtk node dist/cli.js validate --config cli-agent-connector.config.json
rtk node dist/cli.js auth login codex --config cli-agent-connector.config.json
```

After login succeeds, start the connector:

```bash
rtk node dist/cli.js serve --config cli-agent-connector.config.json
```

### Run Gemini Login Through Antigravity

Gemini CLI may reject Google-account browser login with `IneligibleTierError` / `UNSUPPORTED_CLIENT` for Gemini Code Assist individual tiers. When that happens, use Antigravity CLI (`agy`) for browser login instead.

This repo configures the `gemini` agent auth command to launch Antigravity interactively:

```json
"auth": {
  "login": {
    "command": "agy",
    "args": [],
    "timeoutMs": 600000,
    "interactive": true
  }
}
```

Run it with:

```bash
rtk npm run build
rtk node dist/cli.js auth login gemini --config cli-agent-connector.config.json
```

When Antigravity opens its interactive auth menu, choose the Google sign-in option and complete the browser flow.

You can also run Antigravity as its own fallback agent. The example config includes:

```json
{
  "name": "antigravity",
  "driver": "stdio-text",
  "command": "agy",
  "args": ["--print", "{prompt}", "--print-timeout", "10m"],
  "enabled": false
}
```

Enable it when you want the connector to route directly to Antigravity print mode.

For non-interactive/headless Gemini CLI usage, prefer setting `GEMINI_API_KEY` in your shell and keeping `"GEMINI_API_KEY": "${env:GEMINI_API_KEY}"` in the `gemini` agent config:

```bash
export GEMINI_API_KEY="YOUR_GEMINI_API_KEY"
rtk node dist/cli.js serve --config cli-agent-connector.config.json
```

The config includes `--skip-trust` for Gemini CLI so trusted-directory checks do not block the connector in this workspace.
