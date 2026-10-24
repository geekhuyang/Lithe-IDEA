import { useEffect, useRef, useState } from "react";
import { useTranslation } from "@/i18n/locale-provider";
import { useProjectStore } from "@/features/window/stores/project.store";
import { Button } from "@/ui/button";
import { Spinner } from "@/ui/spinner";
import Textarea from "@/ui/textarea";
import { cn } from "@/utils/cn";
import {
  CODEBUDDY_CLI_MISSING,
  resolveCodeBuddyExecutable,
  runCodeBuddyChat,
} from "../services/codebuddy-cli";
import type { CodeBuddyChatTurn } from "../services/codebuddy-prompt";
import { getConfiguredCliPath, setConfiguredCliPath } from "../services/codebuddy-settings";

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "error";
  content: string;
}

/**
 * CodeBuddy chat tool window content. Each turn runs the local CodeBuddy CLI
 * once; the pane only renders the conversation and the CLI's own state.
 */
export function CodeBuddyChatPane() {
  const { t } = useTranslation();
  const rootFolderPath = useProjectStore((state) => state.rootFolderPath);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [cliState, setCliState] = useState<"checking" | "ready" | "missing">("checking");
  const [showSettings, setShowSettings] = useState(false);
  const [cliPathDraft, setCliPathDraft] = useState(() => getConfiguredCliPath());
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    void resolveCodeBuddyExecutable().then((executable) => {
      if (active) setCliState(executable ? "ready" : "missing");
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

  const send = async () => {
    const content = draft.trim();
    if (!content || isRunning) return;
    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content,
    };
    const history: CodeBuddyChatTurn[] = messages
      .filter((message) => message.role !== "error")
      .map((message) => ({
        role: message.role === "user" ? "user" : "assistant",
        content: message.content,
      }));
    setMessages((current) => [...current, userMessage]);
    setDraft("");
    setIsRunning(true);
    try {
      const reply = await runCodeBuddyChat(history, content, rootFolderPath ?? undefined);
      setMessages((current) => [
        ...current,
        { id: `assistant-${Date.now()}`, role: "assistant", content: reply },
      ]);
    } catch (error) {
      setMessages((current) => [
        ...current,
        {
          id: `error-${Date.now()}`,
          role: "error",
          content: error instanceof Error ? error.message : String(error),
        },
      ]);
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-border/70 border-b px-3 py-1.5">
        <span
          className={cn(
            "size-2 shrink-0 rounded-full",
            cliState === "ready"
              ? "bg-success"
              : cliState === "missing"
                ? "bg-destructive"
                : "bg-muted-foreground",
          )}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate ui-text-sm text-subtle-foreground">
          {cliState === "ready"
            ? t("codebuddy.cliReady")
            : cliState === "missing"
              ? t("codebuddy.cliMissing")
              : t("codebuddy.cliChecking")}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => setShowSettings((open) => !open)}
          aria-expanded={showSettings}
        >
          {t("codebuddy.settings")}
        </Button>
      </div>

      {cliState === "missing" && (
        <p className="border-border/70 border-b px-3 py-2 ui-text-sm text-destructive">
          {t("codebuddy.cliMissingHint")}
        </p>
      )}

      {showSettings && (
        <div className="flex items-center gap-2 border-border/70 border-b px-3 py-2">
          <input
            className="min-w-0 flex-1 rounded border border-control-border bg-checkbox-background px-2 py-1 ui-text-sm"
            value={cliPathDraft}
            onChange={(event) => setCliPathDraft(event.target.value)}
            placeholder={t("codebuddy.cliPathPlaceholder")}
            aria-label={t("codebuddy.cliPath")}
          />
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => {
              setConfiguredCliPath(cliPathDraft);
              setCliState("checking");
              void resolveCodeBuddyExecutable().then((executable) => {
                setCliState(executable ? "ready" : "missing");
              });
            }}
          >
            {t("codebuddy.save")}
          </Button>
        </div>
      )}

      <div ref={listRef} className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3">
        {messages.length === 0 && (
          <p className="ui-text-sm text-subtle-foreground">{t("codebuddy.chatEmpty")}</p>
        )}
        {messages.map((message) => (
          <div
            key={message.id}
            className={cn(
              "flex flex-col gap-1 rounded-md px-3 py-2 ui-text-sm",
              message.role === "user"
                ? "bg-accent/40"
                : message.role === "error"
                  ? "border border-destructive/30 bg-destructive/10 text-destructive"
                  : "bg-surface",
            )}
          >
            <span className="font-medium text-subtle-foreground">
              {message.role === "user"
                ? t("codebuddy.you")
                : message.role === "error"
                  ? t("codebuddy.failed")
                  : t("codebuddy.assistant")}
            </span>
            <p className="whitespace-pre-wrap wrap-break-word">{message.content}</p>
          </div>
        ))}
        {isRunning && (
          <div className="flex items-center gap-2 ui-text-sm text-subtle-foreground">
            <Spinner label={t("codebuddy.running")} compact />
            <span>{t("codebuddy.running")}</span>
          </div>
        )}
      </div>

      <div className="flex items-end gap-2 border-border/70 border-t p-2">
        <Textarea
          className="max-h-32 min-h-9 flex-1 resize-none"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
          placeholder={t("codebuddy.chatPlaceholder")}
          aria-label={t("codebuddy.chatPlaceholder")}
        />
        <Button
          type="button"
          size="xs"
          variant="default"
          disabled={isRunning || !draft.trim()}
          onClick={() => void send()}
        >
          {t("codebuddy.send")}
        </Button>
      </div>
    </div>
  );
}
