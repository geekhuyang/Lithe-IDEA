import { XIcon as X } from "@/ui/icons";
import { useUIState } from "@/features/window/stores/ui-state.store";
import { useTranslation } from "@/i18n/locale-provider";
import { Button } from "@/ui/button";
import { cn } from "@/utils/cn";
import {
  findExtensionToolWindow,
} from "@/features/layout/services/extension-tool-window-registry";
import { applyRightToolWindowIntent } from "@/features/layout/actions/right-tool-window-actions";

interface ExtensionToolWindowProps {
  isVisible: boolean;
}

/**
 * Renders the tool window contributed by a bundled extension when its view is
 * the active right-sidebar view. Follows the built-in tool window layout: a
 * compact title bar with a close button above the extension's own content.
 */
export function ExtensionToolWindow({ isVisible }: ExtensionToolWindowProps) {
  const { t } = useTranslation();
  const activeView = useUIState((state) => state.activeRightSidebarView);
  const toolWindow = findExtensionToolWindow(activeView);
  if (!toolWindow) return null;

  return (
    <section
      aria-label={toolWindow.title}
      className={cn("flex h-full min-h-0 flex-col bg-background", !isVisible && "hidden")}
    >
      <div className="flex h-8 shrink-0 items-center border-border/70 border-b px-3">
        <h2 className="min-w-0 flex-1 truncate font-sans ui-text-sm font-semibold text-foreground">
          {toolWindow.title}
        </h2>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={() => applyRightToolWindowIntent(toolWindow.id, "close")}
          tooltip={t("commandPalette.close")}
          aria-label={t("commandPalette.close")}
          tooltipSide="bottom"
        >
          <X />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{toolWindow.render()}</div>
    </section>
  );
}
