import { v0ExtensionManifest } from "@lithe/v0/manifest";
import { codebuddyExtensionManifest } from "@lithe/codebuddy/manifest";
import type { ExtensionManifest } from "@/extensions/types/extension-manifest";

export function getBundledContributionExtensions(): ExtensionManifest[] {
  return [v0ExtensionManifest, codebuddyExtensionManifest];
}

export function isBundledContributionExtension(manifest: ExtensionManifest): boolean {
  return manifest.installation?.type === "bundled";
}
