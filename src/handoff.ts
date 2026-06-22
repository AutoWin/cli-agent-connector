import { ConnectorConfig, LogicalMessage, LogicalSessionState, PromptAttachment } from "./types.js";
import { truncateText } from "./redaction.js";

export function estimateContextChars(session: LogicalSessionState, nextPrompt = ""): number {
  return (
    nextPrompt.length +
    (session.handoffSummary?.length ?? 0) +
    session.transcript.reduce(
      (total, message) =>
        total + message.text.length + (message.attachments ?? []).reduce((sum, attachment) => sum + (attachment.content?.length ?? 0), 0) + 32,
      0
    )
  );
}

export function maybeCompactSession(session: LogicalSessionState, config: ConnectorConfig): LogicalSessionState {
  if (estimateContextChars(session) <= config.state.contextBudgetChars) {
    return session;
  }

  const keep = session.transcript.slice(-8);
  const compacted = session.transcript.slice(0, -8);
  const compactedSummary = summarizeMessages(compacted, 12);
  return {
    ...session,
    handoffSummary: truncateText(
      [
        session.handoffSummary ? `Previous summary:\n${session.handoffSummary}` : undefined,
        compactedSummary ? `Compacted earlier turns:\n${compactedSummary}` : undefined
      ]
        .filter(Boolean)
        .join("\n\n"),
      12_000
    ),
    transcript: keep
  };
}

export function buildHandoffSummary(session: LogicalSessionState, pendingPrompt?: string): string {
  const recent = summarizeMessages(session.transcript.slice(-10), 10);
  const files = session.relevantFiles.length > 0 ? session.relevantFiles.join(", ") : "none recorded";
  const changed = session.changedFiles.length > 0 ? session.changedFiles.join(", ") : "none recorded";
  const routes = session.routingHistory
    .slice(-5)
    .map((event) => `${event.at}: ${event.from ? `${event.from} -> ` : ""}${event.to} (${event.reason})`)
    .join("\n");

  return truncateText(
    [
      "Handoff summary for a new backend coding agent.",
      `Workspace: ${session.cwd}`,
      `Active agent before handoff: ${session.activeAgent}`,
      `Relevant files: ${files}`,
      `Changed files: ${changed}`,
      `Pending task: ${pendingPrompt ?? session.pendingTask ?? session.lastPrompt ?? "none recorded"}`,
      session.handoffSummary ? `Existing summary:\n${session.handoffSummary}` : undefined,
      recent ? `Recent conversation:\n${recent}` : undefined,
      routes ? `Recent routing:\n${routes}` : undefined
    ]
      .filter(Boolean)
      .join("\n\n"),
    16_000
  );
}

export function appendMessage(
  session: LogicalSessionState,
  role: LogicalMessage["role"],
  text: string,
  agentName?: string,
  attachments?: PromptAttachment[]
): LogicalSessionState {
  return {
    ...session,
    transcript: [
      ...session.transcript,
      {
        role,
        text: truncateText(text, 12_000),
        agentName,
        attachments,
        at: new Date().toISOString()
      }
    ],
    updatedAt: new Date().toISOString()
  };
}

function summarizeMessages(messages: LogicalMessage[], max = 10): string {
  return messages
    .slice(-max)
    .map((message) => `- ${message.role}${message.agentName ? `/${message.agentName}` : ""}: ${truncateText(message.text, 900)}`)
    .join("\n");
}
