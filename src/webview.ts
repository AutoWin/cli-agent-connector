// @ts-nocheck
// Browser-side script for the CLI Agent Connector VS Code webview.
const vscode = window.__cliAgentConnectorVsCode || acquireVsCodeApi();
window.__cliAgentConnectorVsCode = vscode;
const state = {
  agents: [],
  sessions: [],
  transcript: [],
  attachments: [],
  toolCards: [],
  mode: "agent",
  responseLanguage: "auto",
  busy: false,
};
let streaming;
let receivedAgentState = false;
let readyAttempts = 0;

const messages = document.getElementById("messages");
const input = document.getElementById("input");
const agent = document.getElementById("agent");
const mode = document.getElementById("mode");
const responseLanguage = document.getElementById("responseLanguage");
const model = document.getElementById("model");
const session = document.getElementById("session");
const attachments = document.getElementById("attachments");
const error = document.getElementById("error");
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");

function post(message) {
  vscode.postMessage(message);
}
function reportError(phase, error) {
  post({
    type: "webviewError",
    phase: phase,
    message: error && error.message ? error.message : String(error),
    stack: error && error.stack ? error.stack : "",
  });
}
window.addEventListener("error", (event) =>
  reportError("window.error", event.error || event.message),
);
window.addEventListener("unhandledrejection", (event) =>
  reportError("unhandledrejection", event.reason),
);
post({ type: "webviewReady" });
function activeAgent() {
  return (
    state.agents.find((item) => item.name === state.activeAgent) ||
    state.agents[0]
  );
}
function enabledModels(item) {
  return item && item.models
    ? item.models.filter((entry) => entry.enabled !== false)
    : [];
}
function selectedModelId(item) {
  const models = enabledModels(item);
  if (!item || !models.length) return "__agent_default__";
  const selection =
    state.modelSelectionByAgent && state.modelSelectionByAgent[item.name];
  if (selection === "__auto__") return "__auto__";
  if (selection && models.some((entry) => entry.id === selection))
    return selection;
  const existing =
    state.activeModelByAgent && state.activeModelByAgent[item.name];
  if (existing && models.some((entry) => entry.id === existing))
    return existing;
  if (
    item.defaultModel &&
    models.some((entry) => entry.id === item.defaultModel)
  )
    return item.defaultModel;
  return models[0].id;
}
function modelLabel(item, modelId) {
  if (modelId === "__auto__") {
    const resolved =
      item && state.activeModelByAgent && state.activeModelByAgent[item.name];
    const resolvedLabel = resolved ? modelLabel(item, resolved) : undefined;
    return resolvedLabel ? "Auto model -> " + resolvedLabel : "Auto model";
  }
  const found = enabledModels(item).find((entry) => entry.id === modelId);
  return found ? found.label || found.id : "Agent default";
}
function labelSession(item) {
  const active = state.agents.find((entry) => entry.name === item.activeAgent);
  const modelId =
    item.modelSelectionByAgent && item.modelSelectionByAgent[item.activeAgent]
      ? item.modelSelectionByAgent[item.activeAgent]
      : item.activeModelByAgent && item.activeModelByAgent[item.activeAgent];
  const modelText = modelId ? " · " + modelLabel(active, modelId) : "";
  return (
    (item.title || item.id.slice(0, 12)) + " · " + item.activeAgent + modelText
  );
}
function fmtTime(value) {
  try {
    return new Date(value).toLocaleTimeString();
  } catch {
    return "";
  }
}
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function iconForRole(role) {
  if (role === "user") return "U";
  if (role === "system") return "!";
  return "AI";
}
function healthClass(item) {
  if (!item || item.health.status === "healthy") return "";
  if (item.health.status === "limited") return "warn";
  return "bad";
}
function resolvedTrafficModel(agentItem) {
  const models = enabledModels(agentItem);
  const selection =
    state.modelSelectionByAgent && state.modelSelectionByAgent[agentItem.name];
  const active =
    state.activeModelByAgent && state.activeModelByAgent[agentItem.name];
  const isAuto = selection === "__auto__";
  const findModel = (id) => models.find((entry) => entry.id === id);
  if (!models.length) {
    return {
      id: "__agent_default__",
      label: "Agent default",
      isAuto,
    };
  }
  const selected = !isAuto && selection ? findModel(selection) : undefined;
  const resolved = active ? findModel(active) : undefined;
  const fallback = agentItem.defaultModel
    ? findModel(agentItem.defaultModel)
    : undefined;
  const modelItem = selected || resolved || fallback || models[0];
  return {
    id: modelItem.id,
    label: modelItem.label || modelItem.id,
    description: modelItem.description,
    benchmarkModelId: modelItem.benchmarkModelId,
    costHint: modelItem.costHint,
    isAuto,
  };
}
function modelInitial(label) {
  const trimmed = (label || "?").trim();
  return (trimmed[0] || "?").toUpperCase();
}
function trafficEntries() {
  return state.agents
    .filter((item) => item.enabled)
    .map((item) => ({
      agent: item,
      model: resolvedTrafficModel(item),
      active: item.name === state.activeAgent,
    }))
    .sort((a, b) => {
      if (a.active) return -1;
      if (b.active) return 1;
      const priority = a.agent.priority - b.agent.priority;
      return priority || a.agent.name.localeCompare(b.agent.name);
    });
}
function renderTraffic() {
  const lane = document.getElementById("traffic-lane");
  if (!lane) return;
  const road = document.getElementById("traffic-road");
  const labelEl = lane.querySelector(".traffic-label");
  const busy = state.busy;
  const entries = trafficEntries();
  var hide = !entries.length;
  lane.className = hide ? "hidden" : "";
  labelEl.className = "traffic-label" + (busy ? " busy" : "");
  road.innerHTML = "";
  for (const entry of entries) {
    const item = entry.agent;
    const modelItem = entry.model;
    var veh = document.createElement("button");
    veh.type = "button";
    veh.className = "vehicle";
    veh.dataset.action = "switchAgent";
    veh.dataset.agentName = item.name;
    if (entry.active) veh.classList.add("active");
    if (entry.active && busy) veh.classList.add("moving");
    if (!entry.active) veh.classList.add("parked");
    if (item.health.status !== "healthy") veh.classList.add("warn");
    veh.title = item.name + " using " + modelItem.label;
    veh.setAttribute("aria-label", item.name + " using " + modelItem.label);

    var marker = document.createElement("span");
    marker.className = "model-marker";
    marker.textContent = modelInitial(modelItem.label);
    veh.appendChild(marker);

    var text = document.createElement("span");
    text.className = "vehicle-text";
    var nameSpan = document.createElement("span");
    nameSpan.className = "model-name";
    nameSpan.textContent = modelItem.label;
    text.appendChild(nameSpan);
    var agentSpan = document.createElement("span");
    agentSpan.className = "agent-name";
    agentSpan.textContent = item.name;
    text.appendChild(agentSpan);
    veh.appendChild(text);

    var badges = document.createElement("span");
    badges.className = "model-badges";
    if (modelItem.isAuto) badges.appendChild(el("span", "model-badge", "AUTO"));
    if (modelItem.costHint !== undefined) {
      badges.appendChild(el("span", "model-badge", "C" + modelItem.costHint));
    }
    if (modelItem.benchmarkModelId) {
      badges.appendChild(el("span", "model-badge", "BENCH"));
    }
    if (badges.childNodes.length) veh.appendChild(badges);
    road.appendChild(veh);
  }
}

function render() {
  error.textContent = state.error || "";
  error.className = state.error ? "visible" : "";
  const currentAgent = activeAgent();
  mode.value = state.mode || "agent";
  responseLanguage.value = state.responseLanguage || "auto";
  agent.innerHTML = "";
  for (const item of state.agents) {
    const option = document.createElement("option");
    option.value = item.name;
    option.textContent = item.name + " · " + item.health.status;
    option.disabled = !item.enabled;
    option.selected = item.name === state.activeAgent;
    agent.appendChild(option);
  }
  renderModelSelect(currentAgent);
  session.innerHTML = "";
  for (const item of state.sessions) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = labelSession(item);
    option.selected = item.id === state.activeSessionId;
    session.appendChild(option);
  }
  renderAttachments();
  renderMessages();
  renderTraffic();
  statusDot.className = "dot " + healthClass(currentAgent);
  const modelText = modelLabel(currentAgent, selectedModelId(currentAgent));
  statusText.textContent = currentAgent
    ? currentAgent.health.status +
      " · " +
      currentAgent.driver +
      " · " +
      modeLabel(state.mode) +
      " · " +
      languageLabel(state.responseLanguage) +
      " · " +
      modelText
    : "No agent configured";
  const send = document.getElementById("send");
  send.textContent = state.busy ? "Running" : "Send";
  send.disabled = state.busy;
}

function safeRender(phase) {
  try {
    render();
    return true;
  } catch (error) {
    reportError(phase, error);
    return false;
  }
}

function renderModelSelect(currentAgent) {
  model.innerHTML = "";
  const models = enabledModels(currentAgent);
  if (!models.length) {
    const option = document.createElement("option");
    option.value = "__agent_default__";
    option.textContent = "Agent default";
    option.selected = true;
    model.appendChild(option);
    model.disabled = true;
    return;
  }
  model.disabled = false;
  const selected = selectedModelId(currentAgent);
  const autoOption = document.createElement("option");
  autoOption.value = "__auto__";
  autoOption.textContent = modelLabel(currentAgent, "__auto__");
  autoOption.title =
    "Automatically choose the best configured model for the current task.";
  autoOption.selected = selected === "__auto__";
  model.appendChild(autoOption);
  for (const item of models) {
    const option = document.createElement("option");
    option.value = item.id;
    const bench = item.benchmarkModelId
      ? " · bench " + item.benchmarkModelId
      : "";
    option.textContent =
      (item.label || item.id) +
      (item.costHint !== undefined ? " · cost " + item.costHint : "") +
      bench;
    option.title = item.description || item.id;
    option.selected = item.id === selected;
    model.appendChild(option);
  }
}

function modeLabel(value) {
  if (value === "ask") return "Ask";
  if (value === "plan") return "Plan";
  return "Agent";
}

function languageLabel(value) {
  if (value === "en") return "English";
  if (value === "vi") return "Vietnamese";
  return "Auto language";
}

function renderAttachments() {
  attachments.innerHTML = "";
  for (const item of state.attachments) {
    const chip = el("span", "chip");
    chip.appendChild(
      el("span", "", item.label + (item.truncated ? " · truncated" : "")),
    );
    const remove = el("button", "ghost", "x");
    remove.dataset.action = "removeAttachment";
    remove.dataset.id = item.id;
    chip.appendChild(remove);
    attachments.appendChild(chip);
  }
}

function renderMarkdown(text) {
  if (!text) return "";
  var blocks = [];
  var codeBlock = "";
  var inCode = false;
  var lines = text.split("\n");
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (line.trim().startsWith("\x60\x60\x60") && !inCode) {
      inCode = true;
      codeBlock = "";
      continue;
    }
    if (line.trim() === "\x60\x60\x60" && inCode) {
      inCode = false;
      blocks.push("<pre><code>" + escapeHtml(codeBlock) + "</code></pre>");
      continue;
    }
    if (inCode) {
      codeBlock += (codeBlock ? "\n" : "") + line;
      continue;
    }
    var processed = escapeHtml(line);
    processed = processed.replace(/\x60([^\x60]+)\x60/g, "<code>$1</code>");
    processed = processed.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    processed = processed.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    if (/^#{1,3}\s/.test(processed)) {
      processed = processed.replace(/^### (.+)/, "<h4>$1</h4>");
      processed = processed.replace(/^## (.+)/, "<h3>$1</h3>");
      processed = processed.replace(/^# (.+)/, "<h3>$1</h3>");
      blocks.push(processed);
      continue;
    }
    if (/^[-*]\s/.test(processed)) {
      processed = processed.replace(/^[-*] (.+)/, "<li>$1</li>");
      if (i === 0 || !/^[-*]\s/.test(lines[i - 1])) blocks.push("<ul>");
      blocks.push(processed);
      if (i === lines.length - 1 || !/^[-*]\s/.test(lines[i + 1]))
        blocks.push("</ul>");
      continue;
    }
    if (processed.trim()) blocks.push("<p>" + processed + "</p>");
    else blocks.push("<br>");
  }
  return blocks.join("");
}
function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderMessages() {
  var prevScroll = messages.scrollTop;
  messages.innerHTML = "";
  if (!state.transcript.length && !state.toolCards.length) {
    messages.appendChild(renderEmpty());
    return;
  }
  for (var mi = 0; mi < state.transcript.length; mi++) {
    var msg = state.transcript[mi];
    var box = el("article", "message " + msg.role);
    box.appendChild(el("div", "avatar", iconForRole(msg.role)));
    var meta = el("div", "meta");
    meta.appendChild(
      el(
        "span",
        "role",
        msg.role + (msg.agentName ? " · " + msg.agentName : ""),
      ),
    );
    meta.appendChild(el("span", "", fmtTime(msg.at)));
    var bubble = el("div", "bubble");
    bubble.appendChild(meta);
    var textDiv = el("div", "text" + (msg.pending ? " muted" : ""));
    if (msg.role === "agent" && msg.text && !msg.pending) {
      textDiv.innerHTML = renderMarkdown(msg.text);
    } else {
      textDiv.textContent = msg.text || (msg.pending ? "Working..." : "");
    }
    bubble.appendChild(textDiv);
    if (msg.attachments && msg.attachments.length) {
      var list = el("div", "attachments");
      for (var ai = 0; ai < msg.attachments.length; ai++)
        list.appendChild(el("span", "chip", msg.attachments[ai].label));
      bubble.appendChild(list);
    }
    box.appendChild(bubble);
    messages.appendChild(box);
  }
  for (var ci = 0; ci < state.toolCards.length; ci++) {
    messages.appendChild(renderTool(state.toolCards[ci]));
  }
  messages.scrollTop = Math.max(prevScroll, messages.scrollHeight);
}

function renderEmpty() {
  const wrap = el("div", "empty");
  const currentAgent = activeAgent();
  wrap.appendChild(
    el(
      "div",
      "empty-title",
      currentAgent ? "Chat with " + currentAgent.name : "CLI Agent Chat",
    ),
  );
  wrap.appendChild(
    el(
      "div",
      "",
      "Attach code context, choose a model, then ask for implementation, review, or debugging help.",
    ),
  );
  const suggestions = el("div", "suggestions");
  const items = [
    "Review the current file and suggest fixes",
    "Explain the selected code and edge cases",
    "Implement the next small change safely",
  ];
  for (const text of items) {
    const button = el("button", "suggestion", text);
    button.dataset.action = "suggest";
    button.dataset.text = text;
    suggestions.appendChild(button);
  }
  wrap.appendChild(suggestions);
  return wrap;
}

function renderTool(card) {
  const box = el("article", "message tool " + card.status);
  box.appendChild(el("div", "avatar", toolIcon(card.type)));
  const bubble = el("div", "bubble");
  const meta = el("div", "meta");
  meta.appendChild(el("span", "role", card.title));
  meta.appendChild(el("span", "", card.status));
  bubble.appendChild(meta);
  if (card.detail) bubble.appendChild(el("div", "text", card.detail));
  if (card.diff) bubble.appendChild(el("pre", "", card.diff));
  if (card.actions && card.actions.length) {
    const row = el("div", "actions");
    for (const action of card.actions) {
      const button = el(
        "button",
        action.includes("reject") ? "secondary" : "",
        actionLabel(action),
      );
      button.dataset.action = action;
      button.dataset.id = card.id;
      row.appendChild(button);
    }
    bubble.appendChild(row);
  }
  box.appendChild(bubble);
  return box;
}

function toolIcon(type) {
  if (type === "terminal") return "$";
  if (type === "write" || type === "diff") return "+-";
  if (type === "read") return "R";
  if (type === "auth") return "A";
  if (type === "failover") return ">";
  if (type === "mentor") return "M";
  if (type === "benchmark") return "B";
  return "*";
}

function actionLabel(action) {
  if (action === "applyWrite" || action === "applyPatch") return "Apply";
  if (action === "approveFailover") return "Switch";
  return "Reject";
}

document.body.addEventListener("click", (event) => {
  const origin = event.target;
  const target =
    origin instanceof HTMLElement ? origin.closest("[data-action]") : undefined;
  if (!(target instanceof HTMLElement) || !target.dataset.action) return;
  const action = target.dataset.action;
  if (action === "send") {
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    streaming = undefined;
    post({
      type: "send",
      text,
      mode: mode.value,
      responseLanguage: responseLanguage.value,
    });
    return;
  }
  if (action === "suggest") {
    input.value = target.dataset.text || "";
    input.focus();
    return;
  }
  if (action === "switchAgent" && target.dataset.agentName) {
    post({ type: "switchAgent", agentName: target.dataset.agentName });
    return;
  }
  post({ type: action, id: target.dataset.id });
});

agent.addEventListener("change", () =>
  post({ type: "switchAgent", agentName: agent.value }),
);
mode.addEventListener("change", () =>
  post({ type: "setMode", mode: mode.value }),
);
responseLanguage.addEventListener("change", () =>
  post({
    type: "setResponseLanguage",
    responseLanguage: responseLanguage.value,
  }),
);
model.addEventListener("change", () =>
  post({ type: "switchModel", agentName: agent.value, modelId: model.value }),
);
session.addEventListener("change", () =>
  post({ type: "selectSession", sessionId: session.value }),
);
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    document.getElementById("send").click();
  }
  if (event.key === "Escape") input.focus();
});

window.addEventListener("message", (event) => {
  const message = event.data;
  console.log(
    "[webview debug] received message type:",
    message && message.type,
  );
  if (message.type === "state") {
    console.log(
      "[webview debug] state message:",
      JSON.stringify({
        agentCount:
          message.state && message.state.agents
            ? message.state.agents.length
            : 0,
        sessionCount:
          message.state && message.state.sessions
            ? message.state.sessions.length
            : 0,
        activeAgent: message.state && message.state.activeAgent,
      }),
    );
    Object.assign(state, message.state);
    receivedAgentState = state.agents.length > 0;
    console.log(
      "[webview debug] state.agents after assign:",
      state.agents.length,
      "receivedAgentState:",
      receivedAgentState,
    );
    streaming = undefined;
    if (safeRender("render.state")) {
      post({
        type: "stateReceived",
        agentCount: state.agents.length,
        sessionCount: state.sessions.length,
        activeAgent: state.activeAgent || "",
      });
    }
  }
  if (message.type === "start") {
    if (!streaming) {
      streaming = {
        role: "agent",
        text: "",
        pending: true,
        at: new Date().toISOString(),
        agentName: state.activeAgent,
      };
      state.transcript = [...state.transcript, streaming];
      renderMessages();
    }
  }
  if (message.type === "chunk") {
    if (!streaming) {
      streaming = {
        role: "agent",
        text: "",
        at: new Date().toISOString(),
        agentName: state.activeAgent,
      };
      state.transcript = [...state.transcript, streaming];
      safeRender("render.chunk");
    }
    streaming.pending = false;
    streaming.text += message.text;
    renderMessages();
  }
  if (message.type === "finish") streaming = undefined;
});

function requestInitialState() {
  if (receivedAgentState || readyAttempts >= 12) {
    console.log(
      "[webview debug] requestInitialState: stopping, receivedAgentState=" +
        receivedAgentState +
        " readyAttempts=" +
        readyAttempts,
    );
    return;
  }
  readyAttempts += 1;
  console.log(
    "[webview debug] requestInitialState: sending ready #" + readyAttempts,
  );
  post({ type: "ready" });
  setTimeout(requestInitialState, 300);
}

requestInitialState();
