import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "@/i18n/locale-provider";
import { convertFileSrc, openUrl } from "@/platform/tauri-core";
import { Button } from "@/ui/button";
import { Spinner } from "@/ui/spinner";
import { cn } from "@/utils/cn";
import {
  codebuddyHostClient,
  readHostRequest,
  type HostEvent,
} from "../services/codebuddy-host-client";
import { assetUrlOrigin, buildWebviewDocument, rewriteWebviewAssets } from "./codebuddy-webview-bridge";

/**
 * CodeBuddy chat tool window. Hosts the vendored extension's chat webview in an
 * iframe: the extension generates the HTML (with its CSP nonce), this pane
 * injects the `acquireVsCodeApi` bridge and relays messages to the sidecar.
 */

const MAX_LOG_LINES = 200;

/** Error codes the Rust host raises; each one has a localized explanation. */
const HOST_ERROR_CODES = [
  "CODEBUDDY_NODE_NOT_FOUND",
  "CODEBUDDY_EXTENSION_MISSING",
  "CODEBUDDY_HOST_ENTRY_MISSING",
  "CODEBUDDY_HOST_START_TIMEOUT",
  "CODEBUDDY_HOST_SPAWN_FAILED",
  "CODEBUDDY_HOST_EXITED",
] as const;

type HostPhase = "idle" | "starting" | "ready" | "failed";

/** Maps a host failure onto its localized message, keeping unknown text verbatim. */
function describeHostError(error: unknown, t: (key: string) => string): string {
  const raw = error instanceof Error ? error.message : String(error);
  const code = HOST_ERROR_CODES.find((candidate) => raw.includes(candidate));
  return code ? t(`codebuddy.${code}`) : raw;
}

export function CodeBuddyChatPane() {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<HostPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [documents, setDocuments] = useState<Map<string, string>>(new Map());
  const [commands, setCommands] = useState<string[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const [signInOpen, setSignInOpen] = useState(true);
  const startedRef = useRef(false);
  // Live iframes keyed by webview handle, so extension messages can be
  // delivered into the document that owns them.
  const framesRef = useRef<Map<string, HTMLIFrameElement>>(new Map());

  const registerFrame = useCallback((handle: string, frame: HTMLIFrameElement | null) => {
    const frames = framesRef.current;
    if (frame) frames.set(handle, frame);
    else frames.delete(handle);
  }, []);

  const appendLog = useCallback((line: string) => {
    setLog((current) => [...current.slice(-(MAX_LOG_LINES - 1)), line]);
  }, []);

  const handleEvent = useCallback(
    (event: HostEvent) => {
      const request = readHostRequest(event);
      if (request) {
        // The extension probes IDE context keys and bundled assets; both are
        // answered locally without involving the sidecar's command table.
        // The host can already be gone (the panel unmounted), and a failed
        // reply must not surface as an unhandled rejection.
        if (request.method === "webview.resolveAsset") {
          const path = String(request.params.path ?? "");
          void codebuddyHostClient
            .reply(request.requestId, {
              uri: path ? convertFileSrc(path) : "",
            })
            .catch(() => undefined);
          return;
        }
        if (request.method === "commands.execute") {
          // The extension mirrors its sign-in state into the IDE context key
          // \`codingcopilot.authenticated\` over the host bridge. React to it so
          // the sign-in overlay clears as soon as the browser round-trip
          // completes, and always answer the request so the caller never
          // times out.
          const commandId = String((request.params as { id?: string })?.id ?? "");
          const args = ((request.params as { args?: unknown[] })?.args ?? []) as unknown[];
          if (commandId === "setContext" && args[0] === "codingcopilot.authenticated") {
            setSignInOpen(args[1] !== true);
          }
        }
        void codebuddyHostClient.reply(request.requestId, null).catch(() => undefined);
        return;
      }
      switch (event.method) {
        case "host.starting":
          setPhase("starting");
          break;
        case "host.activated":
        case "host.ready":
          setPhase("ready");
          break;
        case "host.activationFailed":
          setPhase("failed");
          setError(String(event.params.error ?? ""));
          break;
        case "commands.registered": {
          const id = String(event.params.id ?? "");
          if (id) setCommands((current) => (current.includes(id) ? current : [...current, id]));
          break;
        }
        case "webview.html": {
          const handle = String(event.params.handle ?? "");
          const html = String(event.params.html ?? "");
          if (handle && html) {
            setDocuments((current) => new Map(current).set(handle, html));
          }
          break;
        }
        case "webview.postMessage": {
          // The extension talks to its own webview; deliver into the iframe so
          // the injected bridge can reach `onDidReceiveMessage` listeners.
          const handle = String(event.params.handle ?? "");
          const frame = framesRef.current.get(handle);
          frame?.contentWindow?.postMessage(
            { source: "lithe-codebuddy-host", handle, message: event.params.message },
            "*",
          );
          break;
        }
        case "webView.dispose":
        case "webview.dispose": {
          const handle = String(event.params.handle ?? "");
          setDocuments((current) => {
            const next = new Map(current);
            next.delete(handle);
            return next;
          });
          break;
        }
        case "output.append":
          appendLog(String(event.params.value ?? ""));
          break;
        case "env.openExternal": {
          // The extension asks the IDE to open a URL (notably the OAuth
          // authorize page during sign-in) in the system default browser.
          const uri = String(event.params.uri ?? "");
          if (/^https?:\/\//i.test(uri)) void openUrl(uri).catch(() => undefined);
          break;
        }
        case "host.stderr":
          appendLog(String(event.params.line ?? ""));
          break;
        case "host.exited":
          setPhase("failed");
          setError(t("codebuddy.hostExited"));
          break;
        default:
          break;
      }
    },
    [appendLog, t],
  );

  const startHost = useCallback(async () => {
    setPhase("starting");
    setError(null);
    try {
      const resolved = await invokePaths();
      await codebuddyHostClient.start(resolved.extensionRoot, resolved.hostRoot);
    } catch (startError) {
      setPhase("failed");
      setError(describeHostError(startError, t));
    }
  }, [t]);

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    void (async () => {
      unsubscribe = await codebuddyHostClient.subscribe((event) => {
        if (!disposed) handleEvent(event);
      });
      if (disposed) {
        unsubscribe();
        return;
      }
      if (startedRef.current) return;
      startedRef.current = true;
      await startHost();
    })().catch(() => undefined);
    return () => {
      disposed = true;
      unsubscribe?.();
      void codebuddyHostClient.stop().catch(() => undefined);
    };
    // The tool window owns one host lifetime per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Relay iframe messages into the sidecar.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as {
        source?: string;
        handle?: string;
        message?: unknown;
      };
      if (data?.source !== "lithe-codebuddy-webview" || !data.handle) return;
      void codebuddyHostClient
        .call(`webview.message:${data.handle}`, { message: data.message })
        .catch(() => undefined);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const entries = useMemo(() => [...documents.entries()], [documents]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-border/70 border-b px-3 py-1.5">
        <span
          className={cn(
            "size-2 shrink-0 rounded-full",
            phase === "ready"
              ? "bg-success"
              : phase === "failed"
                ? "bg-destructive"
                : "bg-muted-foreground",
          )}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate ui-text-sm text-subtle-foreground">
          {phase === "ready"
            ? t("codebuddy.hostReady", { count: commands.length })
            : phase === "failed"
              ? error || t("codebuddy.hostFailed")
              : t("codebuddy.hostStarting")}
        </span>
        {phase === "starting" && <Spinner label={t("codebuddy.hostStarting")} compact />}
        {phase === "failed" && (
          <Button size="xs" variant="ghost" onClick={() => void startHost()}>
            {t("codebuddy.retry")}
          </Button>
        )}
      </div>

      <div className="relative min-h-0 flex-1 overflow-auto">
        {entries.length === 0 ? (
          <p className="p-3 ui-text-sm text-subtle-foreground">{t("codebuddy.chatEmpty")}</p>
        ) : (
          entries.map(([handle, html]) => (
            <WebviewFrame key={handle} handle={handle} html={html} registerFrame={registerFrame} />
          ))
        )}
        {phase === "ready" && signInOpen && (
          <SignInCard
            onSignIn={() => {
              // Runs the extension's login command: it starts its local OAuth
              // callback server and opens the authorize page in the browser
              // through the `env.openExternal` bridge event.
              void codebuddyHostClient
                .call("commands.execute", { id: "tencentcloud.codingcopilot.login", args: [] })
                .catch(() => undefined);
            }}
            onDismiss={() => setSignInOpen(false)}
          />
        )}
      </div>

      {log.length > 0 && (
        <pre className="max-h-32 overflow-auto border-border/70 border-t p-2 font-mono ui-text-xs text-subtle-foreground">
          {log.join("")}
        </pre>
      )}
    </div>
  );
}

/**
 * First-open sign-in card, mirroring the JetBrains plugin's logged-out panel:
 * it explains the browser-based sign-in and hands the flow to the extension's
 * `login` command. `onSignIn` starts the OAuth round-trip; dismissing the card
 * keeps the chat webview usable for logged-in users.
 */
function SignInCard({ onSignIn, onDismiss }: { onSignIn: () => void; onDismiss: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="absolute inset-0 z-10 flex items-start justify-center bg-background/80 p-6 backdrop-blur-[2px]">
      <div className="mt-10 w-full max-w-xs rounded-lg border border-border/70 bg-background p-5 shadow-md">
        <h3 className="font-sans ui-text-base font-semibold text-foreground">
          {t("codebuddy.signInTitle")}
        </h3>
        <p className="mt-2 ui-text-sm text-subtle-foreground">{t("codebuddy.signInDescription")}</p>
        <div className="mt-4 flex items-center gap-2">
          <Button size="xs" onClick={onSignIn}>
            {t("codebuddy.signInAction")}
          </Button>
          <Button size="xs" variant="ghost" onClick={onDismiss}>
            {t("codebuddy.signInLater")}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Renders one bridged webview document. */
function WebviewFrame({
  handle,
  html,
  registerFrame,
}: {
  handle: string;
  html: string;
  registerFrame: (handle: string, frame: HTMLIFrameElement | null) => void;
}) {
  const { t } = useTranslation();
  const [root, setRoot] = useState<string>("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    void invokePaths()
      .then((paths) => {
        if (active) setRoot(paths.extensionRoot);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, []);

  const document = useMemo(() => {
    if (!root) return "";
    const assetOrigin = assetUrlOrigin(convertFileSrc(root));
    return buildWebviewDocument(
      rewriteWebviewAssets(html, root, convertFileSrc),
      handle,
      assetOrigin,
    );
  }, [html, handle, root]);

  if (failed) return <p className="p-3 ui-text-sm text-destructive">{t("codebuddy.hostFailed")}</p>;
  if (!document) return null;

  return (
    <iframe
      title="CodeBuddy"
      srcDoc={document}
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
      referrerPolicy="no-referrer"
      ref={(frame) => registerFrame(handle, frame)}
      className="h-full min-h-[480px] w-full border-0"
    />
  );
}

/** Resolves the sidecar resource paths through the host. */
async function invokePaths(): Promise<{ extensionRoot: string; hostRoot: string }> {
  const paths = await codebuddyHostClient.paths();
  return { extensionRoot: paths.extensionRoot, hostRoot: paths.hostRoot };
}
