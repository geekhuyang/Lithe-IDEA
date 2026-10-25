/**
 * Newline-delimited JSON bridge between the Node sidecar and the Lithe host.
 *
 * Wire protocol (one JSON object per line on stdio):
 * - sidecar -> host: `{ type: "ready" }`
 * - sidecar -> host: `{ type: "event", method, params }`        (notification)
 * - sidecar -> host: `{ type: "request", id, method, params }`  (needs a reply)
 * - sidecar -> host: `{ type: "reply", id, result | error }`
 * - host -> sidecar: `{ type: "call", id, method, params }`
 * - host -> sidecar: `{ type: "reply", id, result | error }`
 * - host -> sidecar: `{ type: "shutdown" }`
 */

export interface BridgeMessage {
  type: string;
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: string;
}

type PendingReply = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
};

const CALL_TIMEOUT_MS = 120_000;

export class Bridge {
  private nextId = 1;
  private readonly pending = new Map<number, PendingReply>();
  private readonly eventHandlers = new Map<string, Set<(params: unknown) => void>>();
  private readonly callHandlers = new Map<
    string,
    (params: unknown) => unknown | Promise<unknown>
  >();

  constructor(private readonly output: NodeJS.WritableStream) {}

  /** Sends `ready` once the extension is activated. */
  sendReady(): void {
    this.write({ type: "ready" });
  }

  /** Emits a notification to the host. */
  emit(method: string, params: unknown): void {
    this.write({ type: "event", method, params });
  }

  /** Asks the host for IDE data and awaits the correlated reply. */
  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CODEBUDDY_BRIDGE_TIMEOUT: ${method}`));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (reason) => {
          clearTimeout(timer);
          reject(reason);
        },
      });
      this.write({ type: "request", id, method, params });
    });
  }

  onEvent(method: string, handler: (params: unknown) => void): () => void {
    const handlers = this.eventHandlers.get(method) ?? new Set();
    handlers.add(handler);
    this.eventHandlers.set(method, handlers);
    return () => handlers.delete(handler);
  }

  onCall(method: string, handler: (params: unknown) => unknown | Promise<unknown>): void {
    this.callHandlers.set(method, handler);
  }

  /** Handles one decoded host message. */
  async handleMessage(message: BridgeMessage): Promise<void> {
    switch (message.type) {
      case "call": {
        if (message.id === undefined || !message.method) return;
        const handler = this.callHandlers.get(message.method);
        try {
          const result = handler ? await handler(message.params ?? {}) : null;
          this.write({ type: "reply", id: message.id, result: result ?? null });
        } catch (error) {
          this.write({
            type: "reply",
            id: message.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }
      case "reply": {
        if (message.id === undefined) return;
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(new Error(message.error));
        } else {
          pending.resolve(message.result ?? null);
        }
        return;
      }
      case "shutdown": {
        this.pending.forEach((pending) => pending.reject(new Error("CODEBUDDY_BRIDGE_SHUTDOWN")));
        this.pending.clear();
        process.exit(0);
        return;
      }
      default:
        return;
    }
  }

  /** Delivers a host event to local subscribers (used by the shim). */
  dispatchEvent(method: string, params: unknown): void {
    const handlers = this.eventHandlers.get(method);
    if (!handlers) return;
    handlers.forEach((handler) => handler(params));
  }

  private write(message: BridgeMessage): void {
    this.output.write(`${JSON.stringify(message)}\n`);
  }
}
