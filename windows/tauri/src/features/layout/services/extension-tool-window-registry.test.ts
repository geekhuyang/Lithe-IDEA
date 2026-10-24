import { afterEach, expect, test } from "bun:test";
import { createElement } from "react";
import {
  extensionToolWindowViewId,
  findExtensionToolWindow,
  getExtensionToolWindows,
  openExtensionToolWindow,
  registerExtensionToolWindow,
  unregisterExtensionToolWindowsByExtension,
} from "./extension-tool-window-registry";
import { resolveRightToolWindowUpdate } from "@/features/layout/actions/right-tool-window-actions";
import { useUIState } from "@/features/window/stores/ui-state.store";

const EXTENSION_ID = "lithe.codebuddy";

afterEach(() => {
  unregisterExtensionToolWindowsByExtension(EXTENSION_ID);
  useUIState.setState({
    activeRightSidebarView: "outline",
    isRightSidebarVisible: false,
  });
});

test("registered extension tool windows expose a namespaced right-sidebar view id", () => {
  registerExtensionToolWindow({
    id: `${EXTENSION_ID}.chat`,
    extensionId: EXTENSION_ID,
    title: "CodeBuddy",
    render: () => createElement("div"),
  });

  expect(getExtensionToolWindows().map((window) => window.id)).toEqual([`${EXTENSION_ID}.chat`]);
  expect(findExtensionToolWindow(extensionToolWindowViewId(EXTENSION_ID, "chat"))?.title).toBe(
    "CodeBuddy",
  );
  // Non-extension views never resolve to a plugin window.
  expect(findExtensionToolWindow("maven")).toBeUndefined();
});

test("opening an extension tool window activates its right-sidebar view", () => {
  registerExtensionToolWindow({
    id: `${EXTENSION_ID}.chat`,
    extensionId: EXTENSION_ID,
    title: "CodeBuddy",
    render: () => createElement("div"),
  });

  openExtensionToolWindow(EXTENSION_ID, "chat");
  const state = useUIState.getState();
  expect(state.activeRightSidebarView).toBe(extensionToolWindowViewId(EXTENSION_ID, "chat"));
  expect(state.isRightSidebarVisible).toBe(true);
});

test("deactivating an extension removes its tool windows", () => {
  registerExtensionToolWindow({
    id: `${EXTENSION_ID}.chat`,
    extensionId: EXTENSION_ID,
    title: "CodeBuddy",
    render: () => createElement("div"),
  });

  unregisterExtensionToolWindowsByExtension(EXTENSION_ID);
  expect(getExtensionToolWindows()).toEqual([]);
  expect(findExtensionToolWindow(extensionToolWindowViewId(EXTENSION_ID, "chat"))).toBeUndefined();
});

test("tool windows keep deterministic order", () => {
  registerExtensionToolWindow({
    id: `${EXTENSION_ID}.second`,
    extensionId: EXTENSION_ID,
    title: "Second",
    order: 20,
    render: () => createElement("div"),
  });
  registerExtensionToolWindow({
    id: `${EXTENSION_ID}.first`,
    extensionId: EXTENSION_ID,
    title: "First",
    order: 10,
    render: () => createElement("div"),
  });

  expect(getExtensionToolWindows().map((window) => window.id)).toEqual([
    `${EXTENSION_ID}.first`,
    `${EXTENSION_ID}.second`,
  ]);
});

test("the right tool window intent toggles and closes extension views", () => {
  const view = extensionToolWindowViewId(EXTENSION_ID, "chat");
  const hidden = { activeRightSidebarView: view, isRightSidebarVisible: false };
  const visible = { activeRightSidebarView: view, isRightSidebarVisible: true };

  // A close intent only hides the pane while the extension view is active.
  expect(resolveRightToolWindowUpdate(visible, view, "close")).toEqual({
    activeRightSidebarView: view,
    isRightSidebarVisible: false,
  });
  // A toggle closes the visible view and reopens it from the hidden state.
  expect(resolveRightToolWindowUpdate(visible, view, "toggle").isRightSidebarVisible).toBe(false);
  expect(resolveRightToolWindowUpdate(hidden, view, "toggle")).toEqual({
    activeRightSidebarView: view,
    isRightSidebarVisible: true,
  });
});
