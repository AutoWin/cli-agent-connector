import { mkdir, appendFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Redactor } from "./redaction.js";

export interface MetricSnapshot {
  counters: Record<string, number>;
  timers: Record<string, { count: number; totalMs: number; maxMs: number }>;
}

export class Metrics {
  private readonly counters = new Map<string, number>();
  private readonly timers = new Map<string, { count: number; totalMs: number; maxMs: number }>();

  increment(name: string, value = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + value);
  }

  observeMs(name: string, value: number): void {
    const existing = this.timers.get(name) ?? { count: 0, totalMs: 0, maxMs: 0 };
    existing.count += 1;
    existing.totalMs += value;
    existing.maxMs = Math.max(existing.maxMs, value);
    this.timers.set(name, existing);
  }

  snapshot(): MetricSnapshot {
    return {
      counters: Object.fromEntries(this.counters.entries()),
      timers: Object.fromEntries(this.timers.entries())
    };
  }
}

export class EventLogger {
  private readonly logPath: string;
  private readonly redactor: Redactor;
  private ready = false;

  constructor(statePath: string, redactor: Redactor) {
    this.logPath = join(statePath, "events.jsonl");
    this.redactor = redactor;
  }

  async log(event: string, data: Record<string, unknown> = {}): Promise<void> {
    const payload = this.redactor.redact({
      at: new Date().toISOString(),
      event,
      ...data
    });
    const line = `${JSON.stringify(payload)}\n`;
    process.stderr.write(line);
    try {
      if (!this.ready) {
        await mkdir(dirname(this.logPath), { recursive: true });
        this.ready = true;
      }
      await appendFile(this.logPath, line, "utf8");
    } catch (error) {
      process.stderr.write(
        `${JSON.stringify({ at: new Date().toISOString(), event: "log_write_failed", error: String(error) })}\n`
      );
    }
  }

  async tail(maxLines = 200): Promise<string> {
    try {
      const content = await readFile(this.logPath, "utf8");
      return content.split("\n").filter(Boolean).slice(-maxLines).join("\n");
    } catch {
      return "";
    }
  }
}
