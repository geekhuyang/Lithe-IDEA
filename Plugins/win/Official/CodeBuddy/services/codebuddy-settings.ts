/**
 * Plugin-local settings. The CodeBuddy CLI is discovered on PATH like a
 * language server; an explicit path override covers installs outside PATH.
 */

const CLI_PATH_KEY = "cli-path";

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function getConfiguredCliPath(): string {
  return storage()?.getItem(`lithe-codebuddy:${CLI_PATH_KEY}`)?.trim() ?? "";
}

export function setConfiguredCliPath(path: string): void {
  const store = storage();
  if (!store) return;
  const trimmed = path.trim();
  if (trimmed) {
    store.setItem(`lithe-codebuddy:${CLI_PATH_KEY}`, trimmed);
  } else {
    store.removeItem(`lithe-codebuddy:${CLI_PATH_KEY}`);
  }
}
