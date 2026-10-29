/**
 * Real implementations for the `vscode.workspace` / terminal surface that the
 * vendored CodeBuddy extension's agent tools depend on.
 *
 * The sidecar runs on the user's machine, so file operations do not need to
 * round-trip through the IDE: `workspace.fs`, `applyEdit` and `findFiles`
 * operate on disk directly, scoped to the workspace root the frontend pushes
 * through the `workspace.setRoot` bridge call. Terminal commands run through a
 * per-execution shell child so `shellIntegration.executeCommand().read()` and
 * the shell-execution lifecycle events behave like VS Code's.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createPersistentState } from "./persistent-state";

/** Minimal event emitter shared by the layers below. */
export class LayerEventEmitter<T> {
  private handlers: ((value: T) => void)[] = [];
  readonly event = (listener: (value: T) => void): { dispose(): void } => {
    this.handlers.push(listener);
    return {
      dispose: () => {
        this.handlers = this.handlers.filter((handler) => handler !== listener);
      },
    };
  };
  fire(value: T): void {
    for (const handler of [...this.handlers]) handler(value);
  }
}

export interface UriLike {
  fsPath: string;
  path: string;
  scheme: string;
  toString(): string;
}

/** Extracts a filesystem path from a Uri, `{fsPath|path}`, or raw string. */
export function toFilePath(value: unknown): string {
  if (typeof value === "string") {
    // `file:///D:/x` and `file:///c/x` both collapse to a plain path here; the
    // sidecar only ever touches local files.
    if (value.startsWith("file://")) {
      let decoded = decodeURIComponent(value.slice("file://".length));
      if (/^\/[A-Za-z]:/.test(decoded)) decoded = decoded.slice(1);
      return decoded;
    }
    return value;
  }
  const candidate = value as { fsPath?: string; path?: string } | null;
  return candidate?.fsPath ?? candidate?.path ?? "";
}

interface PositionLike {
  line: number;
  character: number;
}
interface RangeLike {
  start: PositionLike;
  end: PositionLike;
}
interface TextEditLike {
  range?: RangeLike;
  newText?: string;
}

const FILE_TYPE = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 } as const;

/** Directories never walked by `findFiles`, mirroring VS Code's defaults. */
const WALK_EXCLUDED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "target",
  "dist",
  "build",
  "out",
  "coverage",
  "__pycache__",
  ".gradle",
  ".idea",
  ".next",
  ".venv",
  "venv",
]);

/** Offset of a line/character position inside `content` (`\n`-separated). */
function offsetAt(content: string, position: PositionLike): number {
  const lines = content.split("\n");
  const line = Math.max(0, Math.min(position.line, lines.length - 1));
  let offset = 0;
  for (let index = 0; index < line; index++) {
    offset += lines[index].length + 1;
  }
  return offset + Math.max(0, Math.min(position.character, lines[line]?.length ?? 0));
}

interface RecordedTextEdit {
  newText: string;
  range?: RangeLike;
  position?: PositionLike;
}

interface FileOperation {
  kind: "text" | "create" | "deleteFile" | "rename";
  path: string;
  /** For `rename`. */
  toPath?: string;
  createOptions?: { overwrite?: boolean; ignoreIfExists?: boolean };
  deleteOptions?: { recursive?: boolean; ignoreIfNotExists?: boolean };
  textEdits: RecordedTextEdit[];
}

export interface WorkspaceLayer {
  readonly WorkspaceEdit: new () => WorkspaceEditRecorder;
  readonly fs: Record<string, unknown>;
  readonly configuration: {
    getConfiguration: (section?: string, scope?: unknown) => ConfigurationView;
    onDidChangeConfiguration: LayerEventEmitter<{ affectsConfiguration: (section: string) => boolean }>;
  };
  readonly terminals: {
    createTerminal: (options?: TerminalOptions) => TerminalLike;
    getTerminals: () => TerminalLike[];
    getActiveTerminal: () => TerminalLike | undefined;
    onDidOpenTerminal: LayerEventEmitter<{ terminal: TerminalLike }>;
    onDidCloseTerminal: LayerEventEmitter<{ terminal: TerminalLike }>;
    onDidStartTerminalShellExecution: LayerEventEmitter<{
      terminal: TerminalLike;
      execution: TerminalExecutionLike;
    }>;
    onDidEndTerminalShellExecution: LayerEventEmitter<{
      terminal: TerminalLike;
      execution: TerminalExecutionLike;
      exitCode: number | undefined;
    }>;
  };
  setWorkspaceRoot(value: string | undefined): void;
  onWorkspaceRootChanged(listener: () => void): { dispose(): void };
  getWorkspaceFolders(): { uri: UriLike; name: string; index: number }[];
  getWorkspaceName(): string | undefined;
  getWorkspaceFolder(target: unknown): { uri: UriLike; name: string; index: number } | undefined;
  asRelativePath(target: unknown, includeWorkspaceFolder?: boolean): string;
  openTextDocument(input: unknown): Promise<TextDocumentLike>;
  getTextDocuments(): TextDocumentLike[];
  findFiles(
    include?: unknown,
    exclude?: unknown,
    maxResults?: number,
  ): Promise<UriLike[]>;
  applyEdit(edit: unknown): Promise<boolean>;
}

export interface WorkspaceEditRecorder {
  insert(uri: unknown, position: PositionLike, newText: string): WorkspaceEditRecorder;
  replace(uri: unknown, range: RangeLike, newText: string): WorkspaceEditRecorder;
  delete(uri: unknown, range: RangeLike): WorkspaceEditRecorder;
  set(uri: unknown, edits: unknown): WorkspaceEditRecorder;
  createFile(uri: unknown, options?: { overwrite?: boolean; ignoreIfExists?: boolean }): WorkspaceEditRecorder;
  deleteFile(uri: unknown, options?: { recursive?: boolean; ignoreIfNotExists?: boolean }): WorkspaceEditRecorder;
  renameFile(oldUri: unknown, newUri: unknown, options?: { overwrite?: boolean }): WorkspaceEditRecorder;
  readonly size: number;
  entries(): { uri: unknown; edits: unknown }[];
}

export interface TextDocumentLike {
  uri: UriLike;
  fileName: string;
  languageId: string;
  version: number;
  isDirty: boolean;
  isUntitled: boolean;
  eol: number;
  lineCount: number;
  getText(range?: RangeLike): string;
  offsetAt(position: PositionLike): number;
  positionAt(offset: number): PositionLike;
  save(): Promise<boolean>;
}

export interface TerminalOptions {
  name?: string;
  cwd?: string | UriLike;
  env?: Record<string, string | undefined>;
}

export interface TerminalExecutionLike {
  commandLine: string;
  cwd?: string;
  read(): AsyncIterable<string>;
}

export interface TerminalLike {
  name: string;
  processId: Promise<number | undefined>;
  creationOptions: TerminalOptions;
  exitStatus: { code?: number } | undefined;
  state: { isInteractedWith: boolean };
  shellIntegration:
    | {
        cwd: UriLike;
        executeCommand(commandLine: unknown): TerminalExecutionLike;
      }
    | undefined;
  show(preserveFocus?: boolean): void;
  hide(): void;
  sendText(text: string, addNewline?: boolean): Promise<void>;
  dispose(): void;
}

export interface ConfigurationView {
  get(key: string, defaultValue?: unknown): unknown;
  has(key: string): boolean;
  inspect(key: string): { key: string; globalValue?: unknown } | undefined;
  update(key: string, value: unknown): Promise<void>;
}

/** Picks the first non-empty glob matcher, compiled through the vendored picomatch. */
function createGlobMatcher(extensionRoot: string, pattern: string): ((candidate: string) => boolean) | undefined {
  try {
    const requireFromExtension = createRequire(path.join(extensionRoot, "package.json"));
    const picomatch = requireFromExtension("picomatch") as (
      glob: string,
      options?: Record<string, unknown>,
    ) => (candidate: string) => boolean;
    return picomatch(pattern, { dot: true, nonegate: true });
  } catch {
    return undefined;
  }
}

/** Normalizes a glob for POSIX-style matching and strips ignore semantics. */
function normalizeGlob(pattern: string): string {
  return pattern.replace(/\\/g, "/").replace(/^\/+/, "");
}

interface IgnoreRule {
  negated: boolean;
  directoryOnly: boolean;
  match: (candidate: string) => boolean;
}

/** Parses a `.gitignore` body into matchers rooted at its directory. */
function parseGitIgnore(
  body: string,
  matcher: (pattern: string) => ((candidate: string) => boolean) | undefined,
): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const negated = line.startsWith("!");
    const pattern = negated ? line.slice(1) : line;
    if (pattern === "") continue;
    const directoryOnly = pattern.endsWith("/");
    const normalized = normalizeGlob(directoryOnly ? pattern.slice(0, -1) : pattern);
    const compiled = matcher(normalized);
    if (!compiled) continue;
    rules.push({
      negated,
      directoryOnly,
      match: (candidate: string): boolean => {
        if (directoryOnly && !candidate.includes("/")) return false;
        // `foo` should also ignore `foo/bar`, mirroring git semantics.
        return Boolean(compiled(candidate)) || Boolean(compiled(`${candidate}/**`));
      },
    });
  }
  return rules;
}

function isIgnoredByGitIgnore(
  relativePath: string,
  isDirectory: boolean,
  rules: IgnoreRule[],
): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (isDirectory && !rule.directoryOnly) {
      // Directories match plain patterns too (they prefix descendant paths).
      if (rule.negated) {
        if (rule.match(relativePath)) ignored = false;
      } else if (rule.match(relativePath) || rule.match(`${relativePath}/`)) {
        ignored = true;
      }
      continue;
    }
    if (rule.negated) {
      if (rule.match(relativePath)) ignored = false;
    } else if (rule.match(relativePath)) {
      ignored = true;
    }
  }
  return ignored;
}

export function createWorkspaceLayer(options: {
  extensionRoot: string;
  storageDir: string;
  bridge: { emit(name: string, params: Record<string, unknown>): void };
}): WorkspaceLayer {
  const { extensionRoot, bridge } = options;
  const compileGlob = (pattern: string) => createGlobMatcher(extensionRoot, pattern);

  let workspaceRoot: string | undefined;
  const rootChanged = new LayerEventEmitter<void>();

  const setWorkspaceRoot = (value: string | undefined): void => {
    const normalized = value ? path.resolve(value) : undefined;
    if (normalized === workspaceRoot) return;
    workspaceRoot = normalized;
    rootChanged.fire();
  };

  const folderFor = (root: string, index: number) => ({
    uri: makeUri(root),
    name: path.basename(root),
    index,
  });

  const getWorkspaceFolders = () =>
    workspaceRoot ? [folderFor(workspaceRoot, 0)] : [];

  const getWorkspaceFolder = (target: unknown) => {
    if (!workspaceRoot) return undefined;
    const candidate = toFilePath(target);
    const resolved = path.resolve(candidate);
    const relative = path.relative(workspaceRoot, resolved);
    return relative.startsWith("..") || path.isAbsolute(relative)
      ? undefined
      : folderFor(workspaceRoot, 0);
  };

  const asRelativePath = (target: unknown, includeWorkspaceFolder?: boolean): string => {
    const value = toFilePath(target).replace(/\\/g, "/");
    if (!workspaceRoot) return value;
    const root = workspaceRoot.replace(/\\/g, "/").replace(/\/$/, "");
    const relative = value.startsWith(`${root}/`)
      ? value.slice(root.length + 1)
      : value.replace(/\\/g, "/");
    if (!includeWorkspaceFolder) return relative;
    const name = path.basename(workspaceRoot);
    return relative.startsWith("../") ? `${name}/${relative}` : relative;
  };

  // --- WorkspaceEdit --------------------------------------------------------
  const makeUri = (filePath: string): UriLike => ({
    fsPath: filePath,
    path: filePath,
    scheme: "file",
    toString: () => `file://${filePath.replace(/\\/g, "/")}`,
  });

  class WorkspaceEditRecorderImpl implements WorkspaceEditRecorder {
    /** Per-file operations, keyed by path, in call order. */
    private readonly files = new Map<
      string,
      FileOperation & { uri: unknown }
    >();
    private order: string[] = [];

    private entry(uri: unknown): FileOperation {
      const filePath = path.resolve(toFilePath(uri));
      let entry = this.files.get(filePath);
      if (!entry) {
        entry = { kind: "text", path: filePath, uri, textEdits: [] };
        this.files.set(filePath, entry);
        this.order.push(filePath);
      }
      return entry;
    }

    insert(uri: unknown, position: PositionLike, newText: string): WorkspaceEditRecorder {
      this.entry(uri).textEdits.push({ position, newText });
      return this;
    }

    replace(uri: unknown, range: RangeLike, newText: string): WorkspaceEditRecorder {
      this.entry(uri).textEdits.push({ range, newText });
      return this;
    }

    delete(uri: unknown, range: RangeLike): WorkspaceEditRecorder {
      return this.replace(uri, range, "");
    }

    set(uri: unknown, edits: unknown): WorkspaceEditRecorder {
      for (const edit of (Array.isArray(edits) ? edits : [edits]) as TextEditLike[]) {
        if (edit?.range) this.replace(uri, edit.range, edit.newText ?? "");
      }
      return this;
    }

    createFile(
      uri: unknown,
      createOptions?: { overwrite?: boolean; ignoreIfExists?: boolean },
    ): WorkspaceEditRecorder {
      const entry = this.entry(uri);
      entry.kind = "create";
      entry.createOptions = createOptions;
      return this;
    }

    deleteFile(
      uri: unknown,
      deleteOptions?: { recursive?: boolean; ignoreIfNotExists?: boolean },
    ): WorkspaceEditRecorder {
      const entry = this.entry(uri);
      entry.kind = "deleteFile";
      entry.deleteOptions = deleteOptions;
      return this;
    }

    renameFile(oldUri: unknown, newUri: unknown, renameOptions?: { overwrite?: boolean }): WorkspaceEditRecorder {
      const entry = this.entry(oldUri);
      entry.kind = "rename";
      entry.toPath = path.resolve(toFilePath(newUri));
      entry.createOptions = renameOptions;
      return this;
    }

    get size(): number {
      return this.order.length;
    }

    entries(): { uri: unknown; edits: unknown }[] {
      return this.order.map((filePath) => {
        const entry = this.files.get(filePath);
        return { uri: entry?.uri, edits: entry };
      });
    }

    /** Resolves recorded operations for application. */
    operations(): FileOperation[] {
      return this.order
        .map((filePath) => this.files.get(filePath))
        .filter((entry) => Boolean(entry)) as FileOperation[];
    }
  }

  /**
   * Applies one file's text edits against its current content. Edits are
   * computed against the original document (VS Code semantics), then applied
   * from the end backwards.
   */
  async function applyTextEdits(
    filePath: string,
    edits: RecordedTextEdit[],
    created: boolean,
  ): Promise<void> {
    let content = "";
    if (!created && fsSync.existsSync(filePath)) {
      content = await fs.readFile(filePath, "utf8");
    }
    const computed = edits
      .map((edit) => {
        if (edit.range) {
          return {
            start: offsetAt(content, edit.range.start),
            end: offsetAt(content, edit.range.end),
            newText: edit.newText,
          };
        }
        const offset = offsetAt(content, edit.position ?? { line: 0, character: 0 });
        return { start: offset, end: offset, newText: edit.newText };
      })
      .sort((left, right) => right.start - left.start);
    let result = content;
    for (const edit of computed) {
      result = result.slice(0, edit.start) + edit.newText + result.slice(edit.end);
    }
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, result, "utf8");
  }

  async function applyEdit(edit: unknown): Promise<boolean> {
    const recorder = edit as WorkspaceEditRecorderImpl | null;
    if (!recorder || typeof recorder.operations !== "function") return false;
    try {
      for (const operation of recorder.operations()) {
        if (operation.kind === "rename" && operation.toPath) {
          await fs.mkdir(path.dirname(operation.toPath), { recursive: true });
          if (operation.createOptions?.overwrite) {
            await fs.rm(operation.toPath, { force: true, recursive: true });
          }
          await fs.rename(operation.path, operation.toPath);
          bridge.emit("workspace.fileEdited", { path: operation.toPath });
          continue;
        }
        if (operation.kind === "deleteFile") {
          await fs.rm(operation.path, {
            force: !operation.deleteOptions?.ignoreIfNotExists,
            recursive: operation.deleteOptions?.recursive ?? true,
          });
          bridge.emit("workspace.fileEdited", { path: operation.path });
          continue;
        }
        if (operation.kind === "create") {
          const exists = fsSync.existsSync(operation.path);
          if (exists && operation.createOptions?.ignoreIfExists && operation.textEdits.length === 0) {
            continue;
          }
          await applyTextEdits(operation.path, operation.textEdits, !exists || operation.createOptions?.overwrite === true);
          bridge.emit("workspace.fileEdited", { path: operation.path });
          continue;
        }
        await applyTextEdits(operation.path, operation.textEdits, false);
        bridge.emit("workspace.fileEdited", { path: operation.path });
      }
      return true;
    } catch (error) {
      bridge.emit("output.append", {
        channel: "lithe.workspace",
        value: `applyEdit failed: ${error instanceof Error ? error.message : String(error)}\n`,
      });
      return false;
    }
  }

  // --- workspace.fs ----------------------------------------------------------
  const statEntry = async (target: string) => {
    const stats = await fs.stat(target);
    return {
      type:
        stats.isDirectory()
          ? FILE_TYPE.Directory
          : stats.isSymbolicLink()
            ? FILE_TYPE.SymbolicLink | FILE_TYPE.File
            : FILE_TYPE.File,
      ctime: stats.ctimeMs,
      mtime: stats.mtimeMs,
      size: stats.size,
    };
  };

  const filesystem = {
    readFile: async (target: unknown) => new Uint8Array(await fs.readFile(toFilePath(target))),
    writeFile: async (target: unknown, content: unknown) => {
      const filePath = toFilePath(target);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const data =
        content instanceof Uint8Array
          ? content
          : new TextEncoder().encode(String(content ?? ""));
      await fs.writeFile(filePath, data);
      bridge.emit("workspace.fileEdited", { path: filePath });
    },
    stat: async (target: unknown) => statEntry(toFilePath(target)),
    readDirectory: async (target: unknown) => {
      const entries = await fs.readdir(toFilePath(target), { withFileTypes: true });
      // VS Code returns `[name, FileType]` tuples.
      return entries.map(
        (entry) =>
          [
            entry.name,
            entry.isDirectory()
              ? FILE_TYPE.Directory
              : entry.isSymbolicLink()
                ? FILE_TYPE.SymbolicLink | FILE_TYPE.File
                : FILE_TYPE.File,
          ] as [string, number],
      );
    },
    createDirectory: async (target: unknown) => {
      await fs.mkdir(toFilePath(target), { recursive: true });
    },
    delete: async (target: unknown, deleteOptions?: { recursive?: boolean }) => {
      await fs.rm(toFilePath(target), {
        recursive: deleteOptions?.recursive ?? false,
        force: true,
      });
      bridge.emit("workspace.fileEdited", { path: toFilePath(target) });
    },
    rename: async (source: unknown, target: unknown, renameOptions?: { overwrite?: boolean }) => {
      const to = toFilePath(target);
      if (renameOptions?.overwrite) {
        await fs.rm(to, { force: true, recursive: true });
      }
      await fs.rename(toFilePath(source), to);
      bridge.emit("workspace.fileEdited", { path: to });
    },
    copy: async (source: unknown, target: unknown, copyOptions?: { overwrite?: boolean }) => {
      const from = toFilePath(source);
      const to = toFilePath(target);
      if (copyOptions?.overwrite) {
        await fs.rm(to, { force: true, recursive: true });
      }
      await fs.cp(from, to, { recursive: true, force: copyOptions?.overwrite ?? false });
    },
    isWritableFileSystem: (scheme?: string) => scheme === undefined || scheme === "file",
  };

  // --- text documents ----------------------------------------------------------
  const documents = new Map<string, TextDocumentLike>();
  const documentOpened = new LayerEventEmitter<TextDocumentLike>();

  const languageIdFor = (filePath: string): string => {
    const extension = path.extname(filePath).toLowerCase();
    const table: Record<string, string> = {
      ".ts": "typescript",
      ".tsx": "typescriptreact",
      ".js": "javascript",
      ".jsx": "javascriptreact",
      ".json": "json",
      ".md": "markdown",
      ".py": "python",
      ".java": "java",
      ".rs": "rust",
      ".go": "go",
      ".css": "css",
      ".html": "html",
      ".yml": "yaml",
      ".yaml": "yaml",
    };
    return table[extension] ?? "plaintext";
  };

  const openTextDocument = async (input: unknown): Promise<TextDocumentLike> => {
    const filePath = path.resolve(
      typeof input === "string" ? toFilePath(input) : toFilePath((input as { uri?: unknown })?.uri ?? input),
    );
    const cached = documents.get(filePath);
    if (cached) return cached;
    const content = fsSync.existsSync(filePath) ? await fs.readFile(filePath, "utf8") : "";
    const lines = content.split("\n");
    const uri = makeUri(filePath);
    const document: TextDocumentLike = {
      uri,
      fileName: filePath,
      languageId: languageIdFor(filePath),
      version: 1,
      isDirty: false,
      isUntitled: false,
      eol: content.includes("\r\n") ? 2 : 1,
      // A trailing newline does not open a new line in VS Code semantics.
      lineCount:
        lines.length > 1 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length,
      getText: (range?: RangeLike) =>
        range
          ? content.slice(offsetAt(content, range.start), offsetAt(content, range.end))
          : content,
      offsetAt: (position: PositionLike) => offsetAt(content, position),
      positionAt: (offset: number) => {
        const clamped = Math.max(0, Math.min(offset, content.length));
        const before = content.slice(0, clamped);
        const line = before.split("\n").length - 1;
        const lastLineStart = before.lastIndexOf("\n") + 1;
        return { line, character: clamped - lastLineStart };
      },
      save: async () => {
        await fs.writeFile(filePath, content, "utf8");
        return true;
      },
    };
    documents.set(filePath, document);
    documentOpened.fire(document);
    return document;
  };

  // --- findFiles -----------------------------------------------------------------
  const findFiles = async (
    include?: unknown,
    exclude?: unknown,
    maxResults?: number,
  ): Promise<UriLike[]> => {
    const root = workspaceRoot;
    if (!root || !fsSync.existsSync(root)) return [];

    const includeGlob =
      typeof include === "string"
        ? include
        : ((include as { pattern?: string } | null)?.pattern ?? "");
    const excludeGlob =
      typeof exclude === "string"
        ? exclude
        : ((exclude as { pattern?: string } | null)?.pattern ?? "");
    const includeMatch = includeGlob ? compileGlob(normalizeGlob(includeGlob)) : undefined;
    const excludeMatch = excludeGlob ? compileGlob(normalizeGlob(excludeGlob)) : undefined;

    // Root `.gitignore`, if present.
    const ignoreRules: IgnoreRule[] = [];
    const gitignorePath = path.join(root, ".gitignore");
    if (fsSync.existsSync(gitignorePath)) {
      try {
        const body = await fs.readFile(gitignorePath, "utf8");
        ignoreRules.push(
          ...parseGitIgnore(body, (pattern) => compileGlob(pattern)),
        );
      } catch {
        // An unreadable ignore file is skipped, never fatal.
      }
    }

    const results: UriLike[] = [];
    const limit = maxResults ?? Number.POSITIVE_INFINITY;

    const walk = async (directory: string): Promise<void> => {
      if (results.length >= limit) return;
      let entries;
      try {
        entries = await fs.readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (results.length >= limit) return;
        const fullPath = path.join(directory, entry.name);
        const relative = path.relative(root, fullPath).replace(/\\/g, "/");
        if (entry.isDirectory()) {
          if (WALK_EXCLUDED_DIRECTORIES.has(entry.name)) continue;
          if (isIgnoredByGitIgnore(`${relative}/`, true, ignoreRules)) continue;
          await walk(fullPath);
          continue;
        }
        if (isIgnoredByGitIgnore(relative, false, ignoreRules)) continue;
        if (includeMatch && !includeMatch(relative)) continue;
        if (excludeMatch && excludeMatch(relative)) continue;
        results.push(makeUri(fullPath));
      }
    };

    await walk(root);
    return results;
  };

  // --- configuration ------------------------------------------------------------
  const settingsStore = createPersistentState(options.storageDir, "settings.json");
  const configurationChanged =
    new LayerEventEmitter<{ affectsConfiguration: (section: string) => boolean }>();

  const readSettings = (): Record<string, unknown> =>
    (settingsStore.get("settings") as Record<string, unknown> | undefined) ?? {};

  const createConfigurationView = (section?: string): ConfigurationView => ({
    get: (key: string, defaultValue?: unknown) => {
      const settings = readSettings();
      const qualified = section ? `${section}.${key}` : key;
      if (Object.prototype.hasOwnProperty.call(settings, qualified)) {
        return settings[qualified];
      }
      // Fall back through shorter prefixes so `get("a.b.c")` finds `a.b`.
      const parts = qualified.split(".");
      let cursor: unknown = settings;
      for (const part of parts) {
        if (cursor && typeof cursor === "object" && part in (cursor as Record<string, unknown>)) {
          cursor = (cursor as Record<string, unknown>)[part];
        } else {
          return defaultValue;
        }
      }
      return cursor ?? defaultValue;
    },
    has: (key: string) => {
      const qualified = section ? `${section}.${key}` : key;
      return Object.prototype.hasOwnProperty.call(readSettings(), qualified);
    },
    inspect: (key: string) => {
      const qualified = section ? `${section}.${key}` : key;
      const settings = readSettings();
      if (!Object.prototype.hasOwnProperty.call(settings, qualified)) return undefined;
      return { key: qualified, globalValue: settings[qualified] };
    },
    update: async (key: string, value: unknown) => {
      const qualified = section ? `${section}.${key}` : key;
      const settings = readSettings();
      if (value === undefined) delete settings[qualified];
      else settings[qualified] = value;
      await settingsStore.update("settings", settings);
      configurationChanged.fire({
        affectsConfiguration: (candidate: string) =>
          candidate === section || (section?.startsWith(`${candidate}.`) ?? false) || qualified.startsWith(candidate),
      });
    },
  });

  // --- terminals -----------------------------------------------------------------
  const terminalLayer = createTerminalLayer();

  return {
    WorkspaceEdit: WorkspaceEditRecorderImpl as unknown as new () => WorkspaceEditRecorder,
    fs: filesystem,
    configuration: {
      getConfiguration: createConfigurationView,
      onDidChangeConfiguration: configurationChanged,
    },
    terminals: terminalLayer,
    setWorkspaceRoot,
    onWorkspaceRootChanged: (listener: () => void) => rootChanged.event(listener),
    getWorkspaceFolders,
    getWorkspaceName: () => (workspaceRoot ? path.basename(workspaceRoot) : undefined),
    getWorkspaceFolder,
    asRelativePath,
    openTextDocument,
    getTextDocuments: () => [...documents.values()],
    findFiles,
    applyEdit,
  };
}

// --- terminal layer -----------------------------------------------------------------

interface QueuedChunk {
  chunk?: string;
  error?: unknown;
  done?: boolean;
  exitCode?: number;
}

function createTerminalLayer(): WorkspaceLayer["terminals"] {
  const terminals: TerminalLike[] = [];
  let activeTerminal: TerminalLike | undefined;
  const opened = new LayerEventEmitter<{ terminal: TerminalLike }>();
  const closed = new LayerEventEmitter<{ terminal: TerminalLike }>();
  const shellStarted = new LayerEventEmitter<{
    terminal: TerminalLike;
    execution: TerminalExecutionLike;
  }>();
  const shellEnded = new LayerEventEmitter<{
    terminal: TerminalLike;
    execution: TerminalExecutionLike;
    exitCode: number | undefined;
  }>();

  const isWindows = process.platform === "win32";

  class TerminalImpl implements TerminalLike {
    readonly name: string;
    readonly creationOptions: TerminalOptions;
    processId: Promise<number | undefined> = Promise.resolve(undefined);
    exitStatus: { code?: number } | undefined;
    state = { isInteractedWith: false };
    private child: ChildProcess | undefined;
    private readonly cwd: string;
    private queue: Promise<void> = Promise.resolve();

    shellIntegration:
      | {
          cwd: UriLike;
          executeCommand(commandLine: unknown): TerminalExecutionLike;
        }
      | undefined;

    constructor(creationOptions: TerminalOptions, cwd: string) {
      this.name = creationOptions.name ?? "CodeBuddy";
      this.creationOptions = creationOptions;
      this.cwd = cwd;
      this.shellIntegration = {
        cwd: makeUri(cwd),
        executeCommand: (commandLine: unknown) => {
          const command =
            typeof commandLine === "string"
              ? commandLine
              : String((commandLine as { commandLine?: string; command?: unknown })?.commandLine ?? "");
          // The extension compares `event.execution === executeCommand(...)`,
          // so the execution object itself is the return value.
          return this.runCommand(command);
        },
      };
    }

    /** Runs one command through a dedicated shell child, streaming output. */
    private runCommand(command: string): TerminalExecutionLike {
      // `sendText("", false)` is used as a no-op / interrupt marker; spawning a
      // shell for it would only add noise.
      if (command.trim() === "") {
        const emptyExecution: TerminalExecutionLike = {
          commandLine: command,
          cwd: this.cwd,
          read: async function* () {
            // Yields nothing: the command produced no output.
          },
        };
        shellStarted.fire({ terminal: this, execution: emptyExecution });
        shellEnded.fire({ terminal: this, execution: emptyExecution, exitCode: 0 });
        return emptyExecution;
      }
      const queue: QueuedChunk[] = [];
      const resolvers: ((value: QueuedChunk) => void)[] = [];
      const push = (value: QueuedChunk) => {
        const resolver = resolvers.shift();
        if (resolver) resolver(value);
        else queue.push(value);
      };

      const child = spawn(command, {
        shell: isWindows ? "cmd.exe" : "/bin/bash",
        cwd: this.cwd,
        env: { ...process.env, ...(this.creationOptions.env ?? {}) },
        windowsHide: true,
      });
      this.child = child;
      const execution: TerminalExecutionLike = {
        commandLine: command,
        cwd: this.cwd,
        read: async function* (): AsyncIterable<string> {
          while (true) {
            const pending = queue.length > 0 ? queue.shift()! : await new Promise<QueuedChunk>((resolve) => resolvers.push(resolve));
            if (pending.done) return;
            if (pending.error !== undefined) throw pending.error;
            yield pending.chunk ?? "";
          }
        },
      };

      const emitChunk = (chunk: Buffer | string) => push({ chunk: String(chunk) });
      child.stdout?.on("data", emitChunk);
      child.stderr?.on("data", emitChunk);
      child.on("error", (error) => push({ error }));
      child.on("close", (code) => {
        push({ done: true, exitCode: code ?? undefined });
        shellEnded.fire({ terminal: this, execution, exitCode: code ?? undefined });
      });

      shellStarted.fire({ terminal: this, execution });
      return execution;
    }

    show(_preserveFocus?: boolean): void {
      activeTerminal = this;
    }

    hide(): void {
      void undefined;
    }

    async sendText(text: string, addNewline = true): Promise<void> {
      this.state.isInteractedWith = true;
      const command = addNewline ? `${text}\n` : text;
      // Serialize commands so a burst of sendText calls keeps output order.
      const previous = this.queue;
      this.queue = previous.then(async () => {
        const execution = this.runCommand(command);
        for await (const chunk of execution.read()) {
          // Output is consumed by the run pipeline; nothing else to do here.
          void chunk;
        }
      });
      await this.queue;
    }

    dispose(): void {
      this.child?.kill();
      this.exitStatus = { code: undefined };
      const index = terminals.indexOf(this);
      if (index >= 0) terminals.splice(index, 1);
      if (activeTerminal === this) {
        activeTerminal = terminals[terminals.length - 1];
      }
      closed.fire({ terminal: this });
    }
  }

  return {
    createTerminal: (creationOptions: TerminalOptions = {}) => {
      const cwd =
        typeof creationOptions.cwd === "string"
          ? creationOptions.cwd
          : ((creationOptions.cwd as UriLike | undefined)?.fsPath ?? process.env.USERPROFILE ?? process.cwd());
      const terminal = new TerminalImpl(creationOptions, cwd);
      terminals.push(terminal);
      activeTerminal = terminal;
      opened.fire({ terminal });
      return terminal;
    },
    getTerminals: () => [...terminals],
    getActiveTerminal: () => activeTerminal,
    onDidOpenTerminal: opened,
    onDidCloseTerminal: closed,
    onDidStartTerminalShellExecution: shellStarted,
    onDidEndTerminalShellExecution: shellEnded,
  };
}

function makeUri(filePath: string): UriLike {
  return {
    fsPath: filePath,
    path: filePath,
    scheme: "file",
    toString: () => `file://${filePath.replace(/\\/g, "/")}`,
  };
}
