/**
 * File-backed `Memento` implementation for the sidecar.
 *
 * The vendored extension persists its state through `context.globalState`
 * (the ProductManager reads its endpoint cache synchronously from it during
 * activation), so the shim needs real persistence, not an in-memory stub.
 * State lives under the sidecar storage directory, deliberately outside the
 * vendored tree, which must stay read-only.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface PersistentState {
  get(key: string, fallback?: unknown): unknown;
  update(key: string, value: unknown): Promise<void>;
  keys(): readonly string[];
}

const WRITE_DEBOUNCE_MS = 150;

export function createPersistentState(
  storageDir: string,
  fileName: string,
  seed: Record<string, unknown> = {},
): PersistentState {
  const filePath = join(storageDir, fileName);
  mkdirSync(storageDir, { recursive: true });

  let state: Record<string, unknown> = {};
  try {
    if (existsSync(filePath)) {
      state = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    }
  } catch {
    // A corrupt state file falls back to the seed rather than crashing.
    state = {};
  }

  let changed = false;
  for (const [key, value] of Object.entries(seed)) {
    if (state[key] === undefined) {
      state[key] = value;
      changed = true;
    }
  }

  let writeTimer: NodeJS.Timeout | undefined;
  const flush = (): void => {
    try {
      writeFileSync(filePath, JSON.stringify(state, null, 2), "utf8");
    } catch {
      // Persistence is best-effort; the session keeps working from memory.
    }
  };
  const scheduleFlush = (): void => {
    clearTimeout(writeTimer);
    writeTimer = setTimeout(flush, WRITE_DEBOUNCE_MS);
    writeTimer.unref?.();
  };

  if (changed) flush();

  return {
    get(key, fallback) {
      const value = state[key];
      return value === undefined ? fallback : value;
    },
    async update(key, value) {
      if (value === undefined) delete state[key];
      else state[key] = value;
      scheduleFlush();
    },
    keys() {
      return Object.keys(state);
    },
  };
}
