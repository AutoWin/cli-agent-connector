const DEFAULT_SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]+/g,
  /ghp_[A-Za-z0-9_]+/g,
  /github_pat_[A-Za-z0-9_]+/g,
  /xox[baprs]-[A-Za-z0-9-]+/g,
  /api[_-]?key["'=:\s]{0,8}[A-Za-z0-9_.-]{16,}/gi,
  /token["'=:\s]{0,8}[A-Za-z0-9_.-]{16,}/gi
];

export class Redactor {
  private readonly patterns: RegExp[];

  constructor(extraPatterns: string[] = []) {
    this.patterns = [
      ...DEFAULT_SECRET_PATTERNS,
      ...extraPatterns.map((pattern) => new RegExp(pattern, "g"))
    ];
  }

  redactText(value: string): string {
    return this.patterns.reduce((text, pattern) => text.replace(pattern, "[REDACTED]"), value);
  }

  redact<T>(value: T): T {
    if (typeof value === "string") {
      return this.redactText(value) as T;
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.redact(item)) as T;
    }

    if (value && typeof value === "object") {
      const output: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        if (/secret|token|password|api[_-]?key/i.test(key)) {
          output[key] = "[REDACTED]";
        } else {
          output[key] = this.redact(item);
        }
      }
      return output as T;
    }

    return value;
  }
}

export function truncateText(value: string, max = 8000): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}\n[...truncated ${value.length - max} chars...]`;
}
