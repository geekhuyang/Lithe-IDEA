import { ChatCircleTextIcon, CommitMagicIcon } from "@/ui/icons";
import {
  openExtensionToolWindow,
  registerExtensionToolWindow,
  unregisterExtensionToolWindowsByExtension,
} from "@/features/layout/services/extension-tool-window-registry";
import {
  registerCommitDraftAction,
  unregisterCommitDraftActionsByExtension,
} from "@/features/git/services/commit-draft-action-registry";
import { useUIExtensionStore } from "@/extensions/ui/stores/ui-extension-store";
import type { ExtensionManifest } from "@/extensions/types/extension-manifest";
import { CodeBuddyChatPane } from "./components/codebuddy-chat-pane";
import { runCodeBuddyCommit } from "./services/codebuddy-cli";
import {
  CODEBUDDY_CHAT_VIEW_ID,
  CODEBUDDY_COMMIT_ACTION_ID,
  CODEBUDDY_EXTENSION_ID,
} from "./manifest";

interface ExtensionActivationContext {
  extensionId: string;
  manifest: ExtensionManifest;
}

/**
 * CodeBuddy official plugin activation: a sidebar chat tool window plus a
 * commit-panel draft action, both driven by the local CodeBuddy CLI. Core
 * stays plugin-agnostic; everything CodeBuddy-specific lives in this package.
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

    registerCommitDraftAction({
      id: `${extensionId}.${CODEBUDDY_COMMIT_ACTION_ID}`,
      extensionId,
      title: "CodeBuddy",
      icon: <CommitMagicIcon className="size-4" />,
      generate: ({ repoPath, files }) => runCodeBuddyCommit({ repoPath, files }),
    });

    useUIExtensionStore.getState().actions.registerCommand({
      id: `${extensionId}.openChat`,
      extensionId,
      title: "CodeBuddy: Open Chat",
      category: "View",
      execute: () => openExtensionToolWindow(extensionId, CODEBUDDY_CHAT_VIEW_ID),
    });
  },

  deactivate({ extensionId }: ExtensionActivationContext): void {
    if (extensionId !== CODEBUDDY_EXTENSION_ID) return;
    unregisterExtensionToolWindowsByExtension(extensionId);
    unregisterCommitDraftActionsByExtension(extensionId);
    useUIExtensionStore.getState().actions.cleanupExtension(extensionId);
  },
};
