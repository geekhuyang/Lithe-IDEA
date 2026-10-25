import { invoke, listen, type UnlistenFn } from "@/platform/tauri-core";

/** Frontend client for the CodeBuddy Node sidecar managed by the Rust host. */

export interface CodeBuddyHostStatus {
  running: boolean;
  nodePath: string | null;
  lastError: string | null;
}

export interface HostEvent {
  method: string;
  params: Record<string, unknown>;
}

export const codebuddyHostClient = {
  start: (extensionRoot: string, hostRoot: string, nodePath = "") =>
    invoke<{ nodePath: string }>("codebuddy_host_start", {
      // The Rust command takes a single `HostStartRequest` struct argument.
      request: { extensionRoot, hostRoot, nodePath },
    }),

  stop: () => invoke<void>("codebuddy_host_stop"),

  status: () => invoke<CodeBuddyHostStatus>("codebuddy_host_status"),

  /** Resolves the vendored extension root and compiled bridge entry on disk. */
  paths: () =>
    invoke<{ extensionRoot: string; hostRoot: string; hostEntry: string }>("codebuddy_host_paths"),

  /** Calls a method implemented by the sidecar (for example a command). */
  call: (method: string, params: Record<string, unknown> = {}) =>
    invoke<unknown>("codebuddy_host_call", { method, params }),

  /** Answers a sidecar-initiated request forwarded as a `host.request` event. */
  reply: (requestId: number, result: unknown, error?: string) =>
    invoke<void>("codebuddy_host_reply", { requestId, result: result ?? null, error }),

  /** Subscribes to sidecar events (webview, commands, output, stderr). */
  subscribe: async (handler: (event: HostEvent) => void): Promise<UnlistenFn> => {
    return listen<HostEvent>("codebuddy-host-event", (event) => handler(event.payload));
  },
};

/** Extracts a host.request payload from an event, when present. */
export function readHostRequest(event: HostEvent): {
  requestId: number;
  method: string;
  params: Record<string, unknown>;
} | null {
  if (event.method !== "host.request") return null;
  const requestId = event.params.requestId;
  if (typeof requestId !== "number") return null;
  return {
    requestId,
    method: String(event.params.method ?? ""),
    params: (event.params.params as Record<string, unknown>) ?? {},
  };
}
