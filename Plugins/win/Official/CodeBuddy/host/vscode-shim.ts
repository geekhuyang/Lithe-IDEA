/**
 * The `vscode` API implementation for the vendored CodeBuddy extension.
 *
 * Lithe replaces the original plugin's VS Code extension host with this shim:
 * the extension code under `vsix/extension/` runs unmodified in a Node sidecar
 * and talks to the IDE through the bridge. Phase one implements the surface the
 * extension needs to activate, register commands, open its chat webview and
 * report output; IDE-data APIs return neutral defaults and are upgraded as the
 * bridge grows.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Bridge } from "./bridge";
import { createPersistentState } from "./persistent-state";
import {
  createWorkspaceLayer,
  type TerminalOptions,
  type WorkspaceEditRecorder,
} from "./workspace-impl";

export interface ExtensionContextLike {
  subscriptions: { dispose(): void }[];
  extensionPath: string;
  extensionUri: { fsPath: string; path: string; scheme: string };
  extensionMode: number;
  globalState: {
    get: (key: string) => unknown;
    update: (key: string, value: unknown) => Promise<void>;
    keys: () => readonly string[];
  };
  workspaceState: {
    get: (key: string) => unknown;
    update: (key: string, value: unknown) => Promise<void>;
    keys: () => readonly string[];
  };
  secrets: {
    get: (key: string) => Promise<string | undefined>;
    store: (key: string, value: string) => Promise<void>;
    delete: (key: string) => Promise<void>;
    onDidChange: (listener: (event: { key: string }) => void) => { dispose(): void };
  };
  storageUri?: { fsPath: string };
  globalStorageUri?: { fsPath: string };
  logUri?: { fsPath: string };
  extension?: { id: string; packageJSON: unknown };
  environmentVariableCollection?: unknown;
  asAbsolutePath: (relativePath: string) => string;
}

class Disposable {
  constructor(private readonly fn?: () => void) {}
  dispose(): void {
    this.fn?.();
  }
  static from(...items: { dispose(): void }[]): Disposable {
    return new Disposable(() => items.forEach((item) => item.dispose()));
  }
}

class EventEmitter<T> {
  private handlers: ((value: T) => void)[] = [];
  readonly event = (listener: (value: T) => void): { dispose(): void } => {
    this.handlers.push(listener);
    return new Disposable(() => {
      this.handlers = this.handlers.filter((handler) => handler !== listener);
    });
  };
  fire(value: T): void {
    this.handlers.forEach((handler) => handler(value));
  }
  dispose(): void {
    this.handlers = [];
  }
}

function uri(input: string | { fsPath?: string; path?: string }): {
  fsPath: string;
  path: string;
  scheme: string;
  toString(): string;
} {
  const value = typeof input === "string" ? input : (input.fsPath ?? input.path ?? String(input));
  return { fsPath: value, path: value, scheme: "file", toString: () => value };
}

export function createVscodeShim(options: {
  bridge: Bridge;
  extensionRoot: string;
  /** Directory for persisted state; kept outside the vendored tree. */
  storageDir: string;
  /** Seed values written into global state on first run. */
  stateSeed?: Record<string, unknown>;
}): {
  api: Record<string, unknown>;
  context: ExtensionContextLike;
} {
  const { bridge, extensionRoot, storageDir } = options;
  const globalStateStore = createPersistentState(storageDir, "global-state.json", options.stateSeed);
  const workspaceStateStore = createPersistentState(storageDir, "workspace-state.json");
  // Sessions live in secrets; persist them or every restart asks for sign-in.
  const secretsStore = createPersistentState(storageDir, "secrets.json");
  // Real filesystem, edit, configuration and terminal implementations backing
  // the extension's agent tools (workspace.fs, applyEdit, findFiles, ...).
  const workspaceLayer = createWorkspaceLayer({ extensionRoot, storageDir, bridge });

  const Uri = {
    file: (p: string) => uri(p),
    parse: (p: string) => uri(p),
    joinPath: (base: { fsPath: string }, ...parts: (string | { fsPath: string })[]) =>
      uri(
        path.join(
          base.fsPath,
          ...parts.map((part) => (typeof part === "string" ? part : part.fsPath)),
        ),
      ),
    from: (components: { path?: string; fsPath?: string }) =>
      uri(components.path ?? components.fsPath ?? ""),
  };

  // --- localization --------------------------------------------------------
  const l10nState = { language: "zh-CN", bundle: {} as Record<string, string> };
  try {
    const bundlePath = path.join(extensionRoot, "l10n", `bundle.l10n.${l10nState.language}.json`);
    if (fs.existsSync(bundlePath)) {
      const parsed = JSON.parse(fs.readFileSync(bundlePath, "utf8")) as Record<string, unknown>;
      l10nState.bundle = (parsed.contents ?? parsed) as Record<string, string>;
    }
  } catch {
    // A missing bundle falls back to the source strings.
  }
  const l10n = {
    t: (message: string, ...args: unknown[]) => {
      let template = l10nState.bundle[message] ?? message;
      const values = args[0];
      if (values && typeof values === "object") {
        template = template.replace(/\{(\w+)\}/g, (match, key: string) => {
          const record = values as Record<string, unknown>;
          return Object.prototype.hasOwnProperty.call(record, key) ? String(record[key]) : match;
        });
      }
      return template;
    },
    bundle: l10nState.bundle,
    uri: undefined as unknown,
  };

  // --- commands -------------------------------------------------------------
  const commandHandlers = new Map<string, (...args: unknown[]) => unknown>();
  const commands = {
    registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
      commandHandlers.set(id, handler);
      bridge.emit("commands.registered", { id });
      return new Disposable(() => commandHandlers.delete(id));
    },
    registerTextEditorCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
      commandHandlers.set(id, handler);
      bridge.emit("commands.registered", { id });
      return new Disposable(() => commandHandlers.delete(id));
    },
    executeCommand: async (id: string, ...args: unknown[]) => {
      const handler = commandHandlers.get(id);
      if (handler) return handler(...args);
      return bridge.request("commands.execute", { id, args });
    },
    getCommands: async () => [...commandHandlers.keys()],
  };

  // --- window ----------------------------------------------------------------
  interface WebviewPanelLike {
    handle: string;
    viewType: string;
    title: string;
    options: Record<string, unknown>;
    webview: BridgedWebview;
    onDidDispose: (listener: () => void) => { dispose(): void };
    onDidChangeViewState: (listener: (state: unknown) => void) => { dispose(): void };
    reveal: () => void;
    dispose: () => void;
  }

  interface BridgedWebview {
    handle: string;
    html: string;
    options: Record<string, unknown>;
    asWebviewUri: (target: { fsPath: string }) => { fsPath: string; toString(): string };
    postMessage: (message: unknown) => Promise<boolean>;
    onDidReceiveMessage: (listener: (message: unknown) => void) => { dispose(): void };
    cspSource: string;
  }

  const webviews = new Map<string, BridgedWebview & { deliver: (message: unknown) => void }>();
  let webviewSeq = 0;

  /** Creates a webview whose HTML and messages are bridged to the frontend. */
  const createBridgedWebview = (handle: string): BridgedWebview => {
    let html = "";
    return {
      handle,
      get html() {
        return html;
      },
      set html(value: string) {
        html = value;
        bridge.emit("webview.html", { handle, html: value });
      },
      options: { enableScripts: true, localResourceRoots: [{ fsPath: extensionRoot }] },
      asWebviewUri: (target) => {
        // The frontend resolves bundled assets through its asset protocol.
        void bridge.request("webview.resolveAsset", { path: target.fsPath }).catch(() => undefined);
        return { fsPath: target.fsPath, toString: () => target.fsPath };
      },
      postMessage: async (message: unknown) => {
        bridge.emit("webview.postMessage", { handle, message });
        return true;
      },
      onDidReceiveMessage: (listener) => messageEmitterFor(handle).event(listener),
      cspSource: "lithe-codebuddy:",
    };
  };

  // One message emitter per webview handle, so panels and views share delivery.
  const messageEmitters = new Map<string, EventEmitter<unknown>>();
  function messageEmitterFor(handle: string): EventEmitter<unknown> {
    let emitter = messageEmitters.get(handle);
    if (!emitter) {
      emitter = new EventEmitter<unknown>();
      messageEmitters.set(handle, emitter);
      bridge.onCall(`webview.message:${handle}`, (params) => {
        emitter?.fire((params as { message: unknown }).message);
        return null;
      });
    }
    return emitter;
  }

  /** Registers a bridged webview under a fresh handle. */
  const registerWebview = (): BridgedWebview & { deliver: (message: unknown) => void } => {
    const handle = `webview-${++webviewSeq}`;
    const webview = createBridgedWebview(handle);
    const entry = Object.assign(webview, {
      deliver: (message: unknown) => messageEmitterFor(handle).fire(message),
    });
    webviews.set(handle, entry);
    return entry;
  };

  const createWebviewPanel = (
    viewType: string,
    title: string,
    showOptions?: unknown,
    options?: Record<string, unknown>,
  ): WebviewPanelLike => {
    const entry = registerWebview();
    const disposeEmitter = new EventEmitter<void>();
    const panel: WebviewPanelLike = {
      handle: entry.handle,
      viewType,
      title,
      options: options ?? {},
      webview: entry,
      onDidDispose: (listener) => disposeEmitter.event(listener),
      onDidChangeViewState: () => new Disposable(),
      reveal: () => bridge.emit("webview.reveal", { handle: entry.handle }),
      dispose: () => {
        disposeEmitter.fire();
        webviews.delete(entry.handle);
        bridge.emit("webview.dispose", { handle: entry.handle });
      },
    };
    bridge.emit("webview.create", { handle: entry.handle, viewType, title });
    return panel;
  };

  const createOutputChannel = (name: string) => {
    const append = (value: string) => bridge.emit("output.append", { channel: name, value });
    return {
      name,
      append,
      appendLine: (value: string) => append(`${value}\n`),
      replace: (value: string) => append(value),
      clear: () => bridge.emit("output.clear", { channel: name }),
      show: () => bridge.emit("output.show", { channel: name }),
      hide: () => undefined,
      dispose: () => undefined,
    };
  };

  const window = {
    createWebviewPanel,
    createOutputChannel,
    createTextEditorDecorationType: (options: Record<string, unknown>) => ({
      key: "lithe-codebuddy",
      options,
      dispose: () => undefined,
    }),
    // The CodeBuddy chat is a sidebar webview view; resolving the provider is
    // what opens the chat surface in the original plugin.
    registerWebviewViewProvider: (
      viewId: string,
      provider: {
        resolveWebviewView?: (webviewView: unknown, context: unknown, token: unknown) => unknown;
        description?: string;
      },
      _options?: { webviewOptions?: { retainContextWhenHidden?: boolean } },
    ) => {
      const entry = registerWebview();
      const visibilityEmitter = new EventEmitter<unknown>();
      const webviewView = {
        viewType: viewId,
        handle: entry.handle,
        webview: entry,
        title: provider.description,
        description: provider.description,
        badge: undefined as unknown,
        visible: true,
        onDidDispose: new EventEmitter().event,
        onDidChangeVisibility: visibilityEmitter.event,
        show: () => bridge.emit("webview.reveal", { handle: entry.handle }),
      };
      bridge.emit("webviewView.register", { handle: entry.handle, viewId });
      void (async () => {
        try {
          await provider.resolveWebviewView?.(
            webviewView,
            {},
            {
              isCancellationRequested: false,
              onCancellationRequested: new EventEmitter().event,
            },
          );
          bridge.emit("webviewView.resolved", { handle: entry.handle, viewId });
        } catch (error) {
          bridge.emit("webviewView.resolveFailed", {
            handle: entry.handle,
            viewId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })();
      return new Disposable(() => {
        webviews.delete(entry.handle);
        bridge.emit("webviewView.dispose", { handle: entry.handle, viewId });
      });
    },
    registerTreeDataProvider: () => new Disposable(),
    registerUriHandler: () => new Disposable(),
    registerWebviewPanelSerializer: () => new Disposable(),
    createTreeView: () => ({
      onDidChangeSelection: new EventEmitter().event,
      onDidChangeVisibility: new EventEmitter().event,
      onDidExpandElement: new EventEmitter().event,
      onDidCollapseElement: new EventEmitter().event,
      onDidChangeCheckboxState: new EventEmitter().event,
      visible: false,
      selection: [] as unknown[],
      reveal: async () => undefined,
      dispose: () => undefined,
    }),
    createStatusBarItem: () => ({
      text: "",
      name: "",
      tooltip: "",
      command: "",
      color: "",
      backgroundColor: "",
      accessibilityInformation: undefined as unknown,
      show: () => undefined,
      hide: () => undefined,
      dispose: () => undefined,
    }),
    createQuickPick: () => ({
      items: [] as unknown[],
      activeItems: [] as unknown[],
      selectedItems: [] as unknown[],
      placeholder: "",
      title: "",
      step: undefined as number | undefined,
      totalSteps: undefined as number | undefined,
      canSelectMany: false,
      matchOnDescription: false,
      matchOnDetail: false,
      ignoreFocusOut: false,
      busy: false,
      enabled: true,
      value: "",
      buttons: [] as unknown[],
      onDidChangeSelection: new EventEmitter().event,
      onDidAccept: new EventEmitter().event,
      onDidHide: new EventEmitter().event,
      onDidChangeActive: new EventEmitter().event,
      onDidChangeValue: new EventEmitter().event,
      onDidTriggerButton: new EventEmitter().event,
      onDidTriggerItemButton: new EventEmitter().event,
      show: () => undefined,
      hide: () => undefined,
      dispose: () => undefined,
    }),
    createInputBox: () => ({
      value: "",
      placeholder: "",
      prompt: "",
      title: "",
      step: undefined as number | undefined,
      totalSteps: undefined as number | undefined,
      password: false,
      ignoreFocusOut: false,
      busy: false,
      enabled: true,
      validationMessage: "",
      buttons: [] as unknown[],
      onDidAccept: new EventEmitter().event,
      onDidChangeValue: new EventEmitter().event,
      onDidHide: new EventEmitter().event,
      onDidTriggerButton: new EventEmitter().event,
      show: () => undefined,
      hide: () => undefined,
      dispose: () => undefined,
    }),
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    showQuickPick: async () => undefined,
    showInputBox: async () => undefined,
    showTextDocument: async () => undefined,
    showOpenDialog: async () => undefined,
    showSaveDialog: async () => undefined,
    withProgress: async (
      _options: unknown,
      task: (progress: { report: () => void }, token: unknown) => unknown,
    ) =>
      task(
        { report: () => undefined },
        { isCancellationRequested: false, onCancellationRequested: new EventEmitter().event },
      ),
    setStatusBarMessage: () => new Disposable(),
    onDidChangeWindowState: new EventEmitter().event,
    onDidChangeActiveTextEditor: new EventEmitter().event,
    onDidChangeTextEditorSelection: new EventEmitter().event,
    onDidChangeTextEditorOptions: new EventEmitter().event,
    onDidChangeTextEditorViewColumn: new EventEmitter().event,
    onDidChangeVisibleTextEditors: new EventEmitter().event,
    onDidChangeActiveTerminal: new EventEmitter().event,
    onDidOpenTerminal: workspaceLayer.terminals.onDidOpenTerminal.event,
    onDidCloseTerminal: workspaceLayer.terminals.onDidCloseTerminal.event,
    onDidChangeTerminalState: new EventEmitter().event,
    onDidWriteTerminalData: new EventEmitter().event,
    onDidStartTerminalShellExecution: workspaceLayer.terminals.onDidStartTerminalShellExecution.event,
    onDidEndTerminalShellExecution: workspaceLayer.terminals.onDidEndTerminalShellExecution.event,
    onDidChangeTerminalShellIntegration: new EventEmitter().event,
    activeTextEditor: undefined as unknown,
    visibleTextEditors: [] as unknown[],
    get terminals() {
      return workspaceLayer.terminals.getTerminals();
    },
    get activeTerminal() {
      return workspaceLayer.terminals.getActiveTerminal();
    },
    tabGroups: {
      all: [] as unknown[],
      activeTabGroup: undefined as unknown,
      onDidChangeTabs: new EventEmitter().event,
      onDidChangeTabGroups: new EventEmitter().event,
      close: async () => false,
    },
    state: { focused: true, active: true },
  };

  // --- workspace --------------------------------------------------------------
  const configurationChanged = new EventEmitter<{
    affectsConfiguration: (section: string) => boolean;
  }>();
  workspaceLayer.configuration.onDidChangeConfiguration.event((event) =>
    configurationChanged.fire(event),
  );
  const workspaceFoldersChanged = new EventEmitter<unknown>();
  workspaceLayer.onWorkspaceRootChanged(() =>
    workspaceFoldersChanged.fire(undefined),
  );

  const workspace = {
    isTrusted: true,
    get workspaceFolders() {
      return workspaceLayer.getWorkspaceFolders();
    },
    get name() {
      return workspaceLayer.getWorkspaceName();
    },
    workspaceFile: undefined as unknown,
    getConfiguration: (section?: string, _scope?: unknown) =>
      workspaceLayer.configuration.getConfiguration(section),
    onDidChangeConfiguration: configurationChanged.event,
    onDidOpenTextDocument: new EventEmitter().event,
    onDidCloseTextDocument: new EventEmitter().event,
    onDidChangeTextDocument: new EventEmitter().event,
    onDidSaveTextDocument: new EventEmitter().event,
    onWillSaveTextDocument: new EventEmitter().event,
    onDidCreateFiles: new EventEmitter().event,
    onDidDeleteFiles: new EventEmitter().event,
    onDidRenameFiles: new EventEmitter().event,
    onWillCreateFiles: new EventEmitter().event,
    onWillDeleteFiles: new EventEmitter().event,
    onWillRenameFiles: new EventEmitter().event,
    onDidChangeWorkspaceFolders: workspaceFoldersChanged.event,
    get textDocuments() {
      return workspaceLayer.getTextDocuments();
    },
    openTextDocument: (input: unknown) => workspaceLayer.openTextDocument(input),
    findFiles: (include?: unknown, exclude?: unknown, maxResults?: number) =>
      workspaceLayer.findFiles(include, exclude, maxResults),
    asRelativePath: (target: unknown, includeWorkspaceFolder?: boolean) =>
      workspaceLayer.asRelativePath(target, includeWorkspaceFolder),
    registerTextDocumentContentProvider: () => new Disposable(),
    registerFileSystemProvider: () => new Disposable(),
    registerTaskProvider: () => new Disposable(),
    registerTimelineProvider: () => new Disposable(),
    registerEditSessionIdentityProvider: () => new Disposable(),
    registerCanonicalUriProvider: () => new Disposable(),
    registerDocumentDropEditProvider: () => new Disposable(),
    registerPortAttributesProvider: () => new Disposable(),
    registerTerminalLinkProvider: () => new Disposable(),
    registerTerminalQuickFixProvider: () => new Disposable(),
    fs: workspaceLayer.fs,
    getWorkspaceFolder: (target: unknown) => workspaceLayer.getWorkspaceFolder(target),
    updateWorkspaceFolders: async () => false,
    saveAll: async () => false,
    applyEdit: (edit: unknown) => workspaceLayer.applyEdit(edit),
    // Phase-one file watching: the vendored extension watches the MCP settings
    // file via `new RelativePattern(...)` + `createFileSystemWatcher`. We return
    // a no-op watcher so activation succeeds; live file-change events are a
    // later phase once the bridge exposes real filesystem watching.
    createFileSystemWatcher: (
      _globPattern?: unknown,
      _ignoreCreateEvents?: boolean,
      _ignoreChangeEvents?: boolean,
      _ignoreDeleteEvents?: boolean,
    ) => ({
      ignoreCreateEvents: Boolean(_ignoreCreateEvents),
      ignoreChangeEvents: Boolean(_ignoreChangeEvents),
      ignoreDeleteEvents: Boolean(_ignoreDeleteEvents),
      onDidCreate: new EventEmitter().event,
      onDidChange: new EventEmitter().event,
      onDidDelete: new EventEmitter().event,
      dispose: () => undefined,
    }),
  };

  // --- languages / diagnostics -------------------------------------------------
  const languages = {
    createDiagnosticCollection: (name?: string) => {
      bridge.emit("diagnostics.collectionCreated", { name });
      return {
        name,
        set: () => undefined,
        delete: () => undefined,
        clear: () => undefined,
        dispose: () => undefined,
        forEach: () => undefined,
        get: () => undefined,
        has: () => false,
      };
    },
    match: () => undefined,
    getLanguages: async () => [],
    setTextDocumentLanguage: async () => undefined,
    registerCompletionItemProvider: () => new Disposable(),
    registerHoverProvider: () => new Disposable(),
    registerDefinitionProvider: () => new Disposable(),
    registerTypeDefinitionProvider: () => new Disposable(),
    registerImplementationProvider: () => new Disposable(),
    registerDeclarationProvider: () => new Disposable(),
    registerCodeActionsProvider: () => new Disposable(),
    registerDocumentSymbolProvider: () => new Disposable(),
    registerWorkspaceSymbolProvider: () => new Disposable(),
    registerInlineCompletionItemProvider: () => new Disposable(),
    registerCodeLensProvider: () => new Disposable(),
    registerDocumentLinkProvider: () => new Disposable(),
    registerSignatureHelpProvider: () => new Disposable(),
    registerRenameProvider: () => new Disposable(),
    registerReferenceProvider: () => new Disposable(),
    registerDocumentHighlightProvider: () => new Disposable(),
    registerDocumentFormattingEditProvider: () => new Disposable(),
    registerDocumentRangeFormattingEditProvider: () => new Disposable(),
    registerOnTypeFormattingEditProvider: () => new Disposable(),
    registerFoldingRangeProvider: () => new Disposable(),
    registerSelectionRangeProvider: () => new Disposable(),
    registerDocumentSemanticTokensProvider: () => new Disposable(),
    registerDocumentRangeSemanticTokensProvider: () => new Disposable(),
    registerLinkedEditingRangeProvider: () => new Disposable(),
    registerInlayHintsProvider: () => new Disposable(),
    registerCallHierarchyProvider: () => new Disposable(),
    registerTypeHierarchyProvider: () => new Disposable(),
    registerDocumentColorProvider: () => new Disposable(),
    registerEvaluatableExpressionProvider: () => new Disposable(),
    registerInlineValuesProvider: () => new Disposable(),
  };

  // --- SCM (commit box) -----------------------------------------------------------
  const scm = {
    createSourceControl: (id: string, label: string, rootUri?: unknown) => {
      const inputBox = { value: "", placeholder: "" };
      bridge.emit("scm.create", { id, label });
      return {
        id,
        label,
        rootUri,
        count: 0,
        commitTemplate: "",
        inputBox,
        acceptInputCommand: undefined as unknown,
        statusBarCommands: [] as unknown[],
        quickDiffProvider: undefined as unknown,
        selected: false,
        createResourceGroup: (groupId: string, groupLabel: string) => ({
          id: groupId,
          label: groupLabel,
          hideWhenEmpty: false,
          resourceStates: [] as unknown[],
          dispose: () => undefined,
        }),
        onDidChangeCommitTemplate: new EventEmitter().event,
        onDidChangeSelection: new EventEmitter().event,
        dispose: () => bridge.emit("scm.dispose", { id }),
      };
    },
    registerQuickDiffProvider: () => new Disposable(),
    inputBox: undefined as unknown,
  };

  // --- remaining namespaces -----------------------------------------------------------
  const env = {
    language: "zh-CN",
    appName: "Lithe",
    appHost: "desktop",
    appRoot: extensionRoot,
    uriScheme: "lithe",
    clipboard: {
      writeText: async () => undefined,
      readText: async () => "",
    },
    // The auth flow calls this before openExternal; pass the URI through
    // unchanged (no remote authority rewriting applies here).
    asExternalUri: async (uri: unknown) => uri,
    openExternal: async (uri: unknown) => {
      // The sign-in flow relies on this: the extension starts its local OAuth
      // callback server and asks the host to open the authorize URL in the
      // user's default browser.
      const target =
        typeof uri === "string" ? uri : String((uri as { toString?: () => string })?.toString?.() ?? "");
      if (target) bridge.emit("env.openExternal", { uri: target });
      return true;
    },
    machineId: "lithe-codebuddy",
    sessionId: "lithe-codebuddy",
    isNewAppInstall: false,
    onDidChangeTelemetryEnabled: new EventEmitter().event,
    isTelemetryEnabled: false,
    onDidChangeShell: new EventEmitter().event,
    shell: "powershell",
    remoteName: undefined as string | undefined,
    uiKind: 2,
  };

  const extensions = {
    getExtension: (id: string) => {
      if (id === "tencentcloud.codingcopilot") {
        return {
          id,
          isActive: true,
          exports: undefined as unknown,
          activate: async () => undefined,
          packageJSON: {} as unknown,
          extensionPath: extensionRoot,
          extensionUri: uri(extensionRoot),
          extensionKind: 1,
        };
      }
      return undefined;
    },
    all: [] as unknown[],
    onDidChange: new EventEmitter().event,
  };

  const authentication = {
    getSession: async () => undefined,
    onDidChangeSessions: new EventEmitter().event,
  };

  const comments = {
    createCommentController: () => ({
      createCommentThread: () => ({ dispose: () => undefined }),
      commentingRangeProvider: undefined as unknown,
      reactionProvider: undefined as unknown,
      dispose: () => undefined,
    }),
  };

  const tasks = {
    registerTaskProvider: () => new Disposable(),
    executeTask: async () => undefined,
    fetchTasks: async () => [],
    onDidStartTask: new EventEmitter().event,
    onDidEndTask: new EventEmitter().event,
    onDidStartTaskProcess: new EventEmitter().event,
    onDidEndTaskProcess: new EventEmitter().event,
    taskExecutions: [] as unknown[],
  };

  const debug = {
    registerDebugConfigurationProvider: () => new Disposable(),
    registerDebugAdapterDescriptorFactory: () => new Disposable(),
    registerDebugAdapterTrackerFactory: () => new Disposable(),
    onDidStartDebugSession: new EventEmitter().event,
    onDidTerminateDebugSession: new EventEmitter().event,
    onDidChangeActiveDebugSession: new EventEmitter().event,
    onDidReceiveDebugSessionCustomEvent: new EventEmitter().event,
    onDidChangeBreakpoints: new EventEmitter().event,
    activeDebugSession: undefined as unknown,
    breakpoints: [] as unknown[],
    addBreakpoints: () => undefined,
    removeBreakpoints: () => undefined,
  };

  const notebooks = {
    registerNotebookCellStatusBarItemProvider: () => new Disposable(),
    createNotebookController: () => ({ dispose: () => undefined }),
  };

  const tests = {
    createTestController: () => ({ dispose: () => undefined }),
  };

  const chat = {
    createChatParticipant: () => ({
      iconPath: undefined as unknown,
      requestHandler: undefined as unknown,
      followupProvider: undefined as unknown,
      helpTextPrefix: "",
      helpTextPostfix: "",
      isParticipantEnabled: false,
      isSticky: false,
      dispose: () => undefined,
    }),
  };

  const lm = {
    selectChatModels: async () => [],
    registerChatModelProvider: () => new Disposable(),
    onDidChangeChatModels: new EventEmitter().event,
  };

  const terminal = {
    createTerminal: (creationOptions?: TerminalOptions) =>
      workspaceLayer.terminals.createTerminal(creationOptions),
    onDidCloseTerminal: workspaceLayer.terminals.onDidCloseTerminal.event,
    onDidOpenTerminal: workspaceLayer.terminals.onDidOpenTerminal.event,
    onDidChangeActiveTerminal: new EventEmitter().event,
    onDidChangeTerminalState: new EventEmitter().event,
    onDidWriteTerminalData: new EventEmitter().event,
    onDidChangeShellIntegration: new EventEmitter().event,
    get terminals() {
      return workspaceLayer.terminals.getTerminals();
    },
    get activeTerminal() {
      return workspaceLayer.terminals.getActiveTerminal();
    },
    defaultProfile: undefined as unknown,
  };

  // --- classes and enums -------------------------------------------------------------
  const CodeActionKind = {
    Empty: { value: "" },
    QuickFix: { value: "quickfix" },
    Refactor: { value: "refactor" },
    RefactorExtract: { value: "refactor.extract" },
    RefactorInline: { value: "refactor.inline" },
    RefactorMove: { value: "refactor.move" },
    RefactorRewrite: { value: "refactor.rewrite" },
    Source: { value: "source" },
    SourceOrganizeImports: { value: "source.organizeImports" },
    SourceFixAll: { value: "source.fixAll" },
    Notebook: { value: "notebook" },
  };
  const CompletionItemKind = {
    Text: 0,
    Method: 1,
    Function: 2,
    Constructor: 3,
    Field: 4,
    Variable: 5,
    Class: 6,
    Interface: 7,
    Module: 8,
    Property: 9,
    Unit: 10,
    Value: 11,
    Enum: 12,
    Keyword: 13,
    Snippet: 14,
    Color: 15,
    File: 16,
    Reference: 17,
    Folder: 18,
    EnumMember: 19,
    Constant: 20,
    Struct: 21,
    Event: 22,
    Operator: 23,
    TypeParameter: 24,
    User: 25,
    Issue: 26,
  };
  const SymbolKind = {
    File: 0,
    Module: 1,
    Namespace: 2,
    Package: 3,
    Class: 5,
    Method: 6,
    Property: 7,
    Field: 8,
    Constructor: 9,
    Enum: 10,
    Interface: 11,
    Function: 12,
    Variable: 13,
    Constant: 14,
    String: 15,
    Number: 16,
    Boolean: 17,
    Array: 18,
    Object: 19,
    Key: 20,
    Null: 21,
    EnumMember: 22,
    Struct: 23,
    Event: 24,
    Operator: 25,
    TypeParameter: 26,
  };
  class Position {
    constructor(
      readonly line: number,
      readonly character: number,
    ) {}
  }
  class Range {
    constructor(
      readonly start: Position,
      readonly end: Position,
    ) {}
  }
  class Location {
    constructor(
      readonly uri: unknown,
      readonly range: Range,
    ) {}
  }
  class Diagnostic {
    constructor(
      readonly range: Range,
      readonly message: string,
      readonly severity?: number,
    ) {}
  }
  class MarkdownString {
    value: string;
    constructor(value = "") {
      this.value = value;
    }
    appendMarkdown(value: string): this {
      this.value += value;
      return this;
    }
    appendText(value: string): this {
      this.value += value;
      return this;
    }
    appendCodeblock(code: string, language?: string): this {
      this.value += `\n\`\`\`${language ?? ""}\n${code}\n\`\`\`\n`;
      return this;
    }
  }
  class TextEdit {
    constructor(
      readonly range: Range,
      readonly newText: string,
    ) {}
    static replace(range: Range, newText: string): TextEdit {
      return new TextEdit(range, newText);
    }
    static insert(position: Position, newText: string): TextEdit {
      return new TextEdit(new Range(position, position), newText);
    }
    static delete(range: Range): TextEdit {
      return new TextEdit(range, "");
    }
  }
  // `WorkspaceEdit` records real file operations; `workspace.applyEdit` writes
  // them to disk (see ./workspace-impl). The shim-side class delegates to the
  // layer implementation so the extension and the applier share one shape.
  class WorkspaceEdit {
    private readonly recorder: WorkspaceEditRecorder = new workspaceLayer.WorkspaceEdit();
    replace(editUri: unknown, range: Range, newText: string): this {
      this.recorder.replace(editUri, range, newText);
      return this;
    }
    insert(editUri: unknown, position: Position, newText: string): this {
      this.recorder.insert(editUri, position, newText);
      return this;
    }
    delete(editUri: unknown, range: Range): this {
      this.recorder.delete(editUri, range);
      return this;
    }
    set(editUri: unknown, edits: unknown): this {
      this.recorder.set(editUri, edits);
      return this;
    }
    createFile(editUri: unknown, options?: { overwrite?: boolean; ignoreIfExists?: boolean }): this {
      this.recorder.createFile(editUri, options);
      return this;
    }
    deleteFile(editUri: unknown, options?: { recursive?: boolean; ignoreIfNotExists?: boolean }): this {
      this.recorder.deleteFile(editUri, options);
      return this;
    }
    renameFile(oldUri: unknown, newUri: unknown, options?: { overwrite?: boolean }): this {
      this.recorder.renameFile(oldUri, newUri, options);
      return this;
    }
    get size(): number {
      return this.recorder.size;
    }
    entries(): { uri: unknown; edits: unknown }[] {
      return this.recorder.entries();
    }
    operations(): unknown {
      return (
        this.recorder as unknown as { operations?: () => unknown[] }).operations?.() ?? [];
    }
  }
  class ThemeColor {
    constructor(readonly id: string) {}
  }
  class ThemeIcon {
    constructor(
      readonly id: string,
      readonly color?: ThemeColor,
    ) {}
  }
  class CancellationTokenSource {
    readonly token = {
      isCancellationRequested: false,
      onCancellationRequested: new EventEmitter().event,
    };
    cancel(): void {}
    dispose(): void {}
  }

  // Mirrors `vscode.RelativePattern`. `base` may be a `Uri`, a `WorkspaceFolder`
  // (`{ uri, name, index }`), or any `{ uri }` shape; we always expose a resolved
  // `baseUri` so downstream callers (e.g. `workspace.createFileSystemWatcher`)
  // can read a stable Uri regardless of which base form the extension passed.
  class RelativePattern {
    readonly base: unknown;
    readonly pattern: string;
    readonly baseUri: unknown;
    constructor(base: unknown, pattern: string) {
      this.base = base;
      this.pattern = pattern;
      const maybeUri = base as { uri?: unknown } | null;
      this.baseUri = maybeUri && "uri" in maybeUri ? maybeUri.uri : base;
    }
  }

  const api: Record<string, unknown> = {
    version: "1.85.0-lithe",
    Disposable,
    EventEmitter,
    Uri,
    Position,
    Range,
    Location,
    Diagnostic,
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    DiagnosticTag: { Unnecessary: 1, Deprecated: 2 },
    MarkdownString,
    TextEdit,
    WorkspaceEdit,
    ThemeColor,
    ThemeIcon,
    CodeActionKind,
    CompletionItemKind,
    SymbolKind,
    DocumentSymbol: class DocumentSymbol {
      children: unknown[] = [];
      constructor(
        readonly name: string,
        readonly detail: string,
        readonly kind: number,
        readonly range: Range,
        readonly selectionRange: Range,
      ) {}
    },
    SymbolInformation: class SymbolInformation {
      constructor(
        readonly name: string,
        readonly kind: number,
        readonly containerName: string,
        readonly location: Location,
      ) {}
    },
    SignatureInformation: class SignatureInformation {
      parameters: unknown[] = [];
      constructor(
        readonly label: string,
        readonly documentation?: unknown,
      ) {}
    },
    ParameterInformation: class ParameterInformation {
      constructor(
        readonly label: string | [number, number],
        readonly documentation?: unknown,
      ) {}
    },
    SignatureHelp: class SignatureHelp {
      activeParameter = 0;
      activeSignature = 0;
      signatures: unknown[] = [];
    },
    Hover: class Hover {
      constructor(
        readonly contents: unknown,
        readonly range?: Range,
      ) {}
    },
    CompletionItem: class CompletionItem {
      insertText: string | undefined;
      keepWhitespace: boolean | undefined;
      constructor(
        readonly label: string | { label: string; description?: string },
        readonly kind?: number,
      ) {}
    },
    CodeAction: class CodeAction {
      isPreferred = false;
      disabled: { reason: string } | undefined;
      constructor(
        readonly title: string,
        readonly kind?: { value: string },
      ) {}
    },
    CodeLens: class CodeLens {
      constructor(
        readonly range: Range,
        readonly command?: unknown,
      ) {}
    },
    DocumentLink: class DocumentLink {
      constructor(
        readonly range: Range,
        readonly target?: unknown,
      ) {}
    },
    FoldingRange: class FoldingRange {
      constructor(
        readonly start: number,
        readonly end: number,
        readonly kind?: number,
      ) {}
    },
    SelectionRange: class SelectionRange {
      constructor(
        readonly range: Range,
        readonly parent?: SelectionRange,
      ) {}
    },
    InlineCompletionItem: class InlineCompletionItem {
      constructor(
        readonly insertText: string | { snippet: string },
        readonly range?: Range,
        readonly command?: unknown,
      ) {}
    },
    InlineCompletionList: class InlineCompletionList {
      commands: unknown[] = [];
      enableForwardStability = false;
      constructor(readonly items: { insertText: string | { snippet: string } }[]) {}
    },
    CallHierarchyItem: class CallHierarchyItem {
      constructor(
        readonly kind: number,
        readonly name: string,
        readonly detail: string,
        readonly uri: unknown,
        readonly range: Range,
        readonly selectionRange: Range,
      ) {}
    },
    TypeHierarchyItem: class TypeHierarchyItem {
      constructor(
        readonly kind: number,
        readonly name: string,
        readonly detail: string,
        readonly uri: unknown,
        readonly range: Range,
        readonly selectionRange: Range,
      ) {}
    },
    SemanticTokens: class SemanticTokens {
      constructor(
        readonly data: Uint32Array,
        readonly resultId?: string,
      ) {}
    },
    SemanticTokensEdits: class SemanticTokensEdits {
      constructor(
        readonly edits: unknown[],
        readonly resultId?: string,
      ) {}
    },
    SemanticTokensLegend: class SemanticTokensLegend {
      constructor(
        readonly tokenTypes: string[],
        readonly tokenModifiers: string[] = [],
      ) {}
    },
    SemanticTokensBuilder: class SemanticTokensBuilder {
      private data: number[] = [];
      push(..._tokens: unknown[]): void {
        this.data.push(0);
      }
      build(): { data: Uint32Array; resultId?: string } {
        return { data: new Uint32Array(this.data) };
      }
    },
    SnippetString: class SnippetString {
      value: string;
      constructor(value = "") {
        this.value = value;
      }
      appendText(value: string): this {
        this.value += value;
        return this;
      }
      appendTabstop(_number?: number): this {
        return this;
      }
      appendPlaceholder(value: string | ((index: number) => unknown), _number?: number): this {
        this.value += typeof value === "string" ? value : "";
        return this;
      }
      appendChoice(_values: string[], _number?: number): this {
        return this;
      }
      appendVariable(_name: string, _defaultValue?: unknown): this {
        return this;
      }
      appendCodeblock(code: string, _language?: string): this {
        this.value += code;
        return this;
      }
    },
    DecorationRangeBehavior: { OpenOpen: 0, ClosedClosed: 1, OpenClosed: 2, ClosedOpen: 3 },
    OverviewRulerLane: { Left: 1, Center: 2, Right: 4, Full: 7 },
    EndOfLine: { LF: 1, CRLF: 2 },
    TextEditorRevealType: { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2 },
    ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
    UIKind: { Desktop: 2, Web: 1 },
    ExtensionMode: { Production: 1, Development: 2, Test: 3 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    CommentMode: { Editing: 0, Preview: 1 },
    CommentThreadCollapsibleState: { Collapsed: 0, Expanded: 1 },
    QuickPickItemKind: { Separator: -1, Default: 0 },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    TaskRevealKind: { Always: 1, Silent: 2, Never: 3 },
    TaskPanelKind: { Shared: 1, New: 2, Dedicated: 3 },
    DebugConsoleMode: { Separate: 0, MergeWithParent: 1 },
    CancellationTokenSource,
    RelativePattern,
    l10n,
    commands,
    window,
    workspace,
    languages,
    scm,
    env,
    extensions,
    authentication,
    comments,
    tasks,
    debug,
    notebooks,
    tests,
    chat,
    lm,
    terminal,
  };

  // The frontend executes extension commands through this bridge call.
  bridge.onCall("commands.execute", (params) => {
    const { id, args } = (params ?? {}) as { id?: string; args?: unknown[] };
    if (!id) return null;
    const handler = commandHandlers.get(id);
    if (!handler) {
      process.stderr.write("[shim] no handler for " + id + "\n");
      return null;
    }
    process.stderr.write("[shim] running " + id + "\n");
    return Promise.resolve(handler(...(args ?? [])))
      .then((result: unknown) => {
        process.stderr.write("[shim] returned " + id + " => " + JSON.stringify(result)?.slice(0, 120) + "\n");
        return result;
      })
      .catch((error: unknown) => {
        process.stderr.write("[shim] threw " + id + ": " + String(error).slice(0, 200) + "\n");
        throw error;
      });
  });

  // The frontend pushes the active workspace root once the host is ready; every
  // relative-path resolution (workspaceFolders, findFiles, terminal cwd) hangs
  // off it.
  bridge.onCall("workspace.setRoot", (params) => {
    const root = String((params as { path?: string } | null)?.path ?? "");
    if (root && !fs.existsSync(root)) {
      process.stderr.write("[shim] workspace.setRoot: missing directory " + root + "\n");
      return false;
    }
    workspaceLayer.setWorkspaceRoot(root || undefined);
    return true;
  });

  const context: ExtensionContextLike = {
    subscriptions: [],
    extensionPath: extensionRoot,
    extensionUri: uri(extensionRoot),
    extensionMode: 1,
    globalState: globalStateStore,
    workspaceState: workspaceStateStore,
    secrets: {
      get: async (key: string) => {
        const value = secretsStore.get(key);
        return typeof value === "string" ? value : undefined;
      },
      store: async (key: string, value: string) => {
        await secretsStore.update(key, value);
      },
      delete: async (key: string) => {
        await secretsStore.update(key, undefined);
      },
      onDidChange: () => new Disposable(),
    },
    storageUri: uri(storageDir),
    globalStorageUri: uri(storageDir),
    logUri: uri(storageDir),
    extension: { id: "tencentcloud.codingcopilot", packageJSON: {} },
    asAbsolutePath: (relativePath: string) => path.join(extensionRoot, relativePath),
  };

  return { api, context };
}
