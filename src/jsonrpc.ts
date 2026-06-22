import { createInterface } from "node:readline";
import { Readable, Writable } from "node:stream";
import { JsonRpcRequest, JsonRpcResponse } from "./types.js";

type RequestHandler = (params: unknown, request: JsonRpcRequest) => Promise<unknown> | unknown;
type NotificationHandler = (params: unknown, request: JsonRpcRequest) => Promise<void> | void;

export class JsonRpcPeer {
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private readonly notificationHandlers = new Map<string, NotificationHandler[]>();
  private readonly pending = new Map<
    string | number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timeout: NodeJS.Timeout;
    }
  >();
  private nextId = 1;
  private started = false;

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly options: { name?: string; requestTimeoutMs?: number } = {}
  ) {}

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    const rl = createInterface({ input: this.input });
    rl.on("line", (line) => {
      void this.handleLine(line);
    });
    rl.on("close", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error(`${this.options.name ?? "peer"} closed`));
      }
      this.pending.clear();
    });
  }

  onRequest(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  onNotification(method: string, handler: NotificationHandler): void {
    const handlers = this.notificationHandlers.get(method) ?? [];
    handlers.push(handler);
    this.notificationHandlers.set(method, handlers);
  }

  async request(method: string, params?: unknown, timeoutMs = this.options.requestTimeoutMs ?? 120_000): Promise<unknown> {
    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method, params };
    const promise = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`JSON-RPC request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
    });
    this.write(message);
    return promise;
  }

  notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  respond(id: string | number | null, result: unknown): void {
    this.write({ jsonrpc: "2.0", id, result });
  }

  respondError(id: string | number | null, code: number, message: string, data?: unknown): void {
    this.write({ jsonrpc: "2.0", id, error: { code, message, data } });
  }

  private async handleLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let message: JsonRpcRequest | JsonRpcResponse;
    try {
      message = JSON.parse(trimmed) as JsonRpcRequest | JsonRpcResponse;
    } catch {
      this.respondError(null, -32700, "Parse error");
      return;
    }

    if ("id" in message && !("method" in message)) {
      this.handleResponse(message as JsonRpcResponse);
      return;
    }

    const request = message as JsonRpcRequest;
    if (!request.method) {
      this.respondError("id" in request ? request.id ?? null : null, -32600, "Invalid Request");
      return;
    }

    if ("id" in request && request.id !== undefined && request.id !== null) {
      await this.handleRequest(request);
      return;
    }

    await this.handleNotification(request);
  }

  private handleResponse(response: JsonRpcResponse): void {
    const id = response.id;
    if (id === null) {
      return;
    }
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pending.delete(id);
    if (response.error) {
      const error = new Error(response.error.message);
      Object.assign(error, { code: response.error.code, data: response.error.data });
      pending.reject(error);
    } else {
      pending.resolve(response.result);
    }
  }

  private async handleRequest(request: JsonRpcRequest): Promise<void> {
    const handler = this.requestHandlers.get(request.method);
    if (!handler) {
      this.respondError(request.id ?? null, -32601, `Method not found: ${request.method}`);
      return;
    }
    try {
      const result = await handler(request.params, request);
      this.respond(request.id ?? null, result);
    } catch (error) {
      this.respondError(request.id ?? null, -32000, error instanceof Error ? error.message : String(error));
    }
  }

  private async handleNotification(request: JsonRpcRequest): Promise<void> {
    const handlers = this.notificationHandlers.get(request.method) ?? [];
    await Promise.all(handlers.map((handler) => handler(request.params, request)));
  }

  private write(message: unknown): void {
    this.output.write(`${JSON.stringify(message)}\n`);
  }
}
