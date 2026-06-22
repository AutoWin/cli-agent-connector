import { isAbsolute, normalize } from "node:path";
import { PromptAttachment } from "./types.js";
import { truncateText } from "./redaction.js";

const MAX_ATTACHMENT_CHARS = 24_000;
const MAX_TOTAL_ATTACHMENT_CHARS = 80_000;

export interface DiffProposal {
  id: string;
  title: string;
  diff: string;
  targetPaths: string[];
  applicable: boolean;
}

export function normalizePromptAttachments(value: unknown): PromptAttachment[] {
  if (!Array.isArray(value)) {
    return [];
  }

  let remaining = MAX_TOTAL_ATTACHMENT_CHARS;
  const normalized: PromptAttachment[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    const label = typeof record.label === "string" ? record.label : typeof record.path === "string" ? record.path : "attachment";
    const rawContent = typeof record.content === "string" ? record.content : undefined;
    const capped = rawContent ? truncateText(rawContent, Math.min(MAX_ATTACHMENT_CHARS, Math.max(0, remaining))) : undefined;
    remaining -= capped?.length ?? 0;
    normalized.push({
      id: typeof record.id === "string" ? record.id : `att_${normalized.length + 1}`,
      kind: isAttachmentKind(record.kind) ? record.kind : "file",
      label,
      path: typeof record.path === "string" ? record.path : undefined,
      range: typeof record.range === "string" ? record.range : undefined,
      content: capped,
      truncated: Boolean(record.truncated) || Boolean(rawContent && capped && capped.length < rawContent.length)
    });
    if (remaining <= 0) {
      break;
    }
  }
  return normalized;
}

export function assemblePromptWithAttachments(prompt: string, attachments: PromptAttachment[]): string {
  const usable = normalizePromptAttachments(attachments).filter((attachment) => attachment.content);
  if (usable.length === 0) {
    return prompt;
  }

  const context = usable
    .map((attachment, index) => {
      const header = [
        `[${index + 1}] ${attachment.label}`,
        attachment.kind ? `Kind: ${attachment.kind}` : undefined,
        attachment.path ? `Path: ${attachment.path}` : undefined,
        attachment.range ? `Range: ${attachment.range}` : undefined,
        attachment.truncated ? "Note: content was truncated." : undefined
      ]
        .filter(Boolean)
        .join("\n");
      return `${header}\nContent:\n${attachment.content}`;
    })
    .join("\n\n---\n\n");

  return `Context attachments:\n\n${context}\n\nUser request:\n${prompt}`;
}

export function parseDiffProposals(text: string): DiffProposal[] {
  const diffs: string[] = [];
  const fenced = /```(?:diff|patch)\s*\n([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fenced.exec(text)) !== null) {
    diffs.push(match[1].trim());
  }
  if (diffs.length === 0 && /^\s*(diff --git|---\s+)/m.test(text)) {
    diffs.push(text.trim());
  }

  return diffs.map((diff, index) => {
    const targetPaths = extractDiffPaths(diff);
    return {
      id: `diff_${index + 1}_${hashText(diff).slice(0, 8)}`,
      title: targetPaths.length > 0 ? `Proposed diff: ${targetPaths.join(", ")}` : "Proposed diff",
      diff,
      targetPaths,
      applicable: targetPaths.length > 0 && targetPaths.every(isSafeRelativePath)
    };
  });
}

export function buildTextDiff(oldContent: string, newContent: string, filePath: string): string {
  if (oldContent === newContent) {
    return `No changes for ${filePath}`;
  }
  const oldLines = oldContent.split(/\r?\n/);
  const newLines = newContent.split(/\r?\n/);
  return [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    "@@",
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`)
  ].join("\n");
}

export function isSafeRelativePath(filePath: string): boolean {
  const cleaned = filePath.replace(/^([ab])\//, "");
  if (!cleaned || isAbsolute(cleaned)) {
    return false;
  }
  const normalized = normalize(cleaned).replace(/\\/g, "/");
  return normalized !== ".." && !normalized.startsWith("../") && !normalized.includes("/../");
}

function extractDiffPaths(diff: string): string[] {
  const paths = new Set<string>();
  for (const line of diff.split(/\r?\n/)) {
    const gitMatch = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (gitMatch) {
      paths.add(gitMatch[2]);
      continue;
    }
    const plusMatch = /^\+\+\+\s+(?:b\/)?(.+)$/.exec(line);
    if (plusMatch && plusMatch[1] !== "/dev/null") {
      paths.add(plusMatch[1]);
    }
  }
  return [...paths].map((path) => path.replace(/^b\//, ""));
}

function isAttachmentKind(value: unknown): value is PromptAttachment["kind"] {
  return value === "file" || value === "selection" || value === "folder" || value === "open-editor" || value === "unsupported";
}

function hashText(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16);
}
