import { useSyncExternalStore, type ReactNode } from "react";
import type { CommitFileInput } from "../types/ai-commit";

/**
 * A commit-message draft action contributed by a bundled official extension.
 * The commit panel renders registered actions next to its built-in AI button
 * and runs them through the same draft workflow, so extension results keep the
 * replacement confirmation, stale-result and fingerprint protection.
 */
export interface CommitDraftActionContext {
  repoPath: string;
  files: CommitFileInput[];
  signal: AbortSignal;
}

export interface RegisteredCommitDraftAction {
  /** Namespaced contribution id, `<extensionId>.<localId>`. */
  id: string;
  extensionId: string;
  title: string;
  icon?: ReactNode;
  generate: (context: CommitDraftActionContext) => Promise<string>;
}

const actions = new Map<string, RegisteredCommitDraftAction>();
const actionIdsByExtension = new Map<string, Set<string>>();
const listeners = new Set<() => void>();
let snapshot: RegisteredCommitDraftAction[] | null = null;

function emitChange(): void {
  snapshot = null;
  listeners.forEach((listener) => listener());
}

function subscribeToCommitDraftActions(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function sortedActions(): RegisteredCommitDraftAction[] {
  if (!snapshot) {
    snapshot = [...actions.values()];
  }
  return snapshot;
}

/** Snapshot for non-React consumers and tests; the hook below subscribes. */
export function getCommitDraftActions(): RegisteredCommitDraftAction[] {
  return sortedActions();
}

export function registerCommitDraftAction(action: RegisteredCommitDraftAction): void {
  actions.set(action.id, action);
  const actionIds = actionIdsByExtension.get(action.extensionId) ?? new Set<string>();
  actionIds.add(action.id);
  actionIdsByExtension.set(action.extensionId, actionIds);
  emitChange();
}

export function unregisterCommitDraftActionsByExtension(extensionId: string): void {
  const actionIds = actionIdsByExtension.get(extensionId);
  if (!actionIds) return;
  actionIds.forEach((actionId) => actions.delete(actionId));
  actionIdsByExtension.delete(extensionId);
  emitChange();
}

export function useCommitDraftActions(): RegisteredCommitDraftAction[] {
  return useSyncExternalStore(
    subscribeToCommitDraftActions,
    sortedActions,
    sortedActions,
  );
}
