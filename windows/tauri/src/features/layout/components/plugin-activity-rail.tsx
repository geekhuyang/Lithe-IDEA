import { useBufferStore } from "@/features/editor/stores/buffer.store";
import { AgentTrigger } from "@/features/agent/components/agent-trigger";
import { applyRightToolWindowIntent } from "@/features/layout/actions/right-tool-window-actions";
import {
  extensionToolWindowViewIdFor,
  useExtensionToolWindows,
} from "@/features/layout/services/extension-tool-window-registry";
import { toggleMavenPane } from "@/features/keymaps/commands/view-command-actions";
import { MavenIcon } from "@/features/maven/components/maven-icon";
import { useMavenStore } from "@/features/maven/stores/maven.store";
import { NotificationsTrigger } from "@/features/notifications/components/notifications-trigger";
import { useUIState } from "@/features/window/stores/ui-state.store";
import { useTranslation } from "@/i18n/locale-provider";
import { Button } from "@/ui/button";
import { PuzzlePieceIcon } from "@/ui/icons";

// IntelliJ Islands stripe button: 30px highlight, 12px arc (6px radius), 20px icon.
const STRIPE_BUTTON_CLASS_NAME = "size-[30px] rounded-[6px]";

export function PluginActivityRail() {
  const { t } = useTranslation();
  const openExtensionsBuffer = useBufferStore.use.actions().openExtensionsBuffer;
  const closeBuffer = useBufferStore.use.actions().closeBuffer;
  const activeExtensionsBufferId = useBufferStore((state) => {
    if (!state.activeBufferId) return null;

    const activeBuffer = state.buffers.find((buffer) => buffer.id === state.activeBufferId);
    return activeBuffer?.type === "extensions" ? activeBuffer.id : null;
  });
  const isExtensionsActive = activeExtensionsBufferId !== null;

  // The Extensions page is a singleton buffer: a second click while it is the
  // active tab closes it, otherwise the click opens or focuses it.
  const toggleExtensionsBuffer = () => {
    if (activeExtensionsBufferId) {
      closeBuffer(activeExtensionsBufferId);
      return;
    }
    openExtensionsBuffer();
  };
  const isMavenAvailable = useMavenStore(
    (state) => Boolean(state.project) || state.projectStatus === "failed",
  );
  const isMavenActive = useUIState(
    (state) => state.isRightSidebarVisible && state.activeRightSidebarView === "maven",
  );
  const isRightSidebarVisible = useUIState((state) => state.isRightSidebarVisible);
  const activeRightSidebarView = useUIState((state) => state.activeRightSidebarView);
  const extensionToolWindows = useExtensionToolWindows();
  const activityViewsLabel = t("workbench.activityViews");
  const extensionsLabel = t("extensions.title");
  const mavenLabel = t("workbench.maven");

  return (
    <aside
      aria-label={activityViewsLabel}
      className="lithe-plugin-activity-rail flex w-9.5 shrink-0 flex-col items-center gap-2.5 bg-surface pt-1"
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        active={isExtensionsActive}
        tooltip={extensionsLabel}
        tooltipSide="left"
        aria-label={extensionsLabel}
        aria-pressed={isExtensionsActive}
        className={STRIPE_BUTTON_CLASS_NAME}
        onClick={toggleExtensionsBuffer}
      >
        <PuzzlePieceIcon className="size-5" />
      </Button>
      <NotificationsTrigger className={STRIPE_BUTTON_CLASS_NAME} />
      <AgentTrigger className={STRIPE_BUTTON_CLASS_NAME} />
      {isMavenAvailable ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          active={isMavenActive}
          tooltip={mavenLabel}
          tooltipSide="left"
          aria-label={mavenLabel}
          aria-pressed={isMavenActive}
          className={STRIPE_BUTTON_CLASS_NAME}
          onClick={toggleMavenPane}
        >
          <MavenIcon className="size-5" />
        </Button>
      ) : null}
      {extensionToolWindows.map((toolWindow) => {
        // The right-sidebar state stores namespaced view ids
        // (`extension:<extensionId>.<localId>`); matching on the bare
        // contribution id would never highlight or open the pane.
        const viewId = extensionToolWindowViewIdFor(toolWindow);
        const isActive = isRightSidebarVisible && activeRightSidebarView === viewId;
        return (
          <Button
            key={toolWindow.id}
            type="button"
            variant="ghost"
            size="icon-sm"
            active={isActive}
            tooltip={toolWindow.title}
            tooltipSide="left"
            aria-label={toolWindow.title}
            aria-pressed={isActive}
            className={STRIPE_BUTTON_CLASS_NAME}
            onClick={() => applyRightToolWindowIntent(viewId, "toggle")}
          >
            {toolWindow.icon ?? <PuzzlePieceIcon className="size-5" />}
          </Button>
        );
      })}
    </aside>
  );
}
