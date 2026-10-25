import type { ExtensionManifest } from "@/extensions/types/extension-manifest";

export const CODEBUDDY_EXTENSION_ID = "lithe.codebuddy";
export const CODEBUDDY_CHAT_VIEW_ID = "chat";
export const CODEBUDDY_COMMIT_ACTION_ID = "generate-commit-message";
/** The vendored extension's own package id (VS Code marketplace style). */
export const CODEBUDDY_VSIX_ID = "tencentcloud.codingcopilot";

export const codebuddyExtensionManifest: ExtensionManifest = {
  id: CODEBUDDY_EXTENSION_ID,
  name: "codebuddy",
  displayName: "CodeBuddy",
  description:
    "Chat with CodeBuddy and draft commit messages through the vendored CodeBuddy VS Code extension running in a local sidecar.",
  version: "1.0.0",
  publisher: "Lithe",
  categories: ["AI"],
  installation: {
    type: "bundled",
  },
};
