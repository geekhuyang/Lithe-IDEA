import { useSyncExternalStore, type ReactNode } from "react";
import { applyRightToolWindowIntent } from "@/features/layout/actions/right-tool-window-actions";
import type { SidebarView } from "@/features/layout/utils/sidebar-pane-utils";

/**
 * A tool window contributed by a bundled official extension. The registry keeps
 * core layout free of plugin-specific code: extensions register a view, the
 * right activity rail renders one stripe button per view, and the right tool
 * window pane renders the active view's content.
 */
export interface RegisteredExtensionToolWindow {
  /** Namespaced contribution id, `<extensionId>.<localId>`. */
  id: string;
  extensionId: string;
  title: string;
  icon?: ReactNode;
  render: () => ReactNode;
  order?: number;
}

const EXTENSION_VIEW_PREFIX = "extension:";

const windows = new Map<string, RegisteredExtensionToolWindow>();
const viewIdsByExtension = new Map<string, Set<string>>();
const listeners = new Set<() => void>();
let snapshot: RegisteredExtensionToolWindow[] | null = null;

function emitChange(): void {
  snapshot = null;
  listeners.forEach((listener) => listener());
}

function subscribeToExtensionToolWindows(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function sortedWindows(): RegisteredExtensionToolWindow[] {
  if (!snapshot) {
    snapshot = [...windows.values()].sort(
      (left, right) =>
        (left.order ?? 100) - (right.order ?? 100) ||
        left.title.localeCompare(right.title),
    );
  }
  return snapshot;
}

/** Snapshot for non-React consumers and tests; the hook below subscribes. */
export function getExtensionToolWindows(): RegisteredExtensionToolWindow[] {
  return sortedWindows();
}

export function registerExtensionToolWindow(window: RegisteredExtensionToolWindow): void {
  windows.set(window.id, window);
  const viewIds = viewIdsByExtension.get(window.extensionId) ?? new Set<string>();
  viewIds.add(window.id);
  viewIdsByExtension.set(window.extensionId, viewIds);
  emitChange();
}

export function unregisterExtensionToolWindowsByExtension(extensionId: string): void {
  const viewIds = viewIdsByExtension.get(extensionId);
  if (!viewIds) return;
  viewIds.forEach((viewId) => windows.delete(viewId));
  viewIdsByExtension.delete(extensionId);
  emitChange();
}

export function useExtensionToolWindows(): RegisteredExtensionToolWindow[] {
  return useSyncExternalStore(
    subscribeToExtensionToolWindows,
    sortedWindows,
    sortedWindows,
  );
}

/** The right-sidebar view id that hosts an extension tool window. */
export function extensionToolWindowViewId(extensionId: string, localId: string): SidebarView {
  return `${EXTENSION_VIEW_PREFIX}${extensionId}.${localId}`;
}

/** Returns the registered window when the active right-sidebar view is one. */
export function findExtensionToolWindow(
  view: SidebarView,
): RegisteredExtensionToolWindow | undefined {
  if (!view.startsWith(EXTENSION_VIEW_PREFIX)) return undefined;
  return windows.get(view.slice(EXTENSION_VIEW_PREFIX.length));
}

export function openExtensionToolWindow(extensionId: string, localId: string): void {
  applyRightToolWindowIntent(extensionToolWindowViewId(extensionId, localId), "open");
}
