import { ChatCircleTextIcon } from "@/ui/icons";
import {
  registerExtensionToolWindow,
  unregisterExtensionToolWindowsByExtension,
} from "@/features/layout/services/extension-tool-window-registry";
import type { ExtensionManifest } from "@/extensions/types/extension-manifest";
import { CodeBuddyChatPane } from "./components/codebuddy-chat-pane";
import { CODEBUDDY_CHAT_VIEW_ID, CODEBUDDY_EXTENSION_ID } from "./manifest";

interface ExtensionActivationContext {
  extensionId: string;
  manifest: ExtensionManifest;
}

/**
 * CodeBuddy official plugin activation.
 *
 * The vendored VS Code extension (`vsix/extension`) is the implementation; this
 * module only contributes the Lithe-side surfaces: a sidebar chat tool window
 * hosting the extension's webview. The sidecar lifecycle is owned by the tool
 * window, so deactivation removes the registration and lets the window close
 * the host.
 */
export const codebuddyExtensionModule = {
  activate({ extensionId }: ExtensionActivationContext): void {
    if (extensionId !== CODEBUDDY_EXTENSION_ID) return;

    registerExtensionToolWindow({
      id: `${extensionId}.${CODEBUDDY_CHAT_VIEW_ID}`,
      extensionId,
      title: "CodeBuddy",
      icon: <ChatCircleTextIcon className="size-5" />,
      order: 10,
      render: () => <CodeBuddyChatPane />,
    });
  },

  deactivate({ extensionId }: ExtensionActivationContext): void {
    if (extensionId !== CODEBUDDY_EXTENSION_ID) return;
    unregisterExtensionToolWindowsByExtension(extensionId);
  },
};
