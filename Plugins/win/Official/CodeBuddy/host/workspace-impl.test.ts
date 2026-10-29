import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceLayer } from "./workspace-impl";

/** Real extension root so the layer can compile globs through vendored picomatch. */
const extensionRoot = join(import.meta.dir, "..", "vsix", "extension");

const bridge = { emit: () => undefined };

function makeLayer(root: string) {
  const layer = createWorkspaceLayer({
    extensionRoot,
    storageDir: join(root, "storage"),
    bridge,
  });
  layer.setWorkspaceRoot(root);
  return layer;
}

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "lithe-workspace-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "app.ts"), "const a = 1;\nconst b = 2;\n");
  writeFileSync(join(root, "README.md"), "hello\n");
  writeFileSync(join(root, "secrets.txt"), "skip me\n");
  writeFileSync(join(root, ".gitignore"), "secrets.txt\nbuild/\n");
  return root;
}

test("applyEdit creates a file through createFile + insert and applies range edits", async () => {
  const root = makeTempRoot();
  try {
    const layer = makeLayer(root);
    const { Uri } = { Uri: { file: (p: string) => p } };

    const create = new layer.WorkspaceEdit();
    create.createFile(Uri.file(join(root, "src", "new.ts")));
    create.insert(Uri.file(join(root, "src", "new.ts")), { line: 0, character: 0 }, "export const c = 3;\n");
    expect(await layer.applyEdit(create)).toBe(true);
    expect(readFileSync(join(root, "src", "new.ts"), "utf8")).toBe("export const c = 3;\n");

    // Replace line 0 on the pre-existing file (VS Code semantics: ranges are
    // computed against the original content).
    const edit = new layer.WorkspaceEdit();
    edit.replace(
      Uri.file(join(root, "src", "app.ts")),
      { start: { line: 0, character: 0 }, end: { line: 0, character: 13 } },
      "const a = 42;",
    );

    expect(await layer.applyEdit(edit)).toBe(true);
    expect(readFileSync(join(root, "src", "app.ts"), "utf8")).toBe("const a = 42;\nconst b = 2;\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("applyEdit handles multi-edit batches against one file", async () => {
  const root = makeTempRoot();
  try {
    const layer = makeLayer(root);
    const edit = new layer.WorkspaceEdit();
    const target = { fsPath: join(root, "src", "app.ts") };
    // "const b = 2;" — the `2` sits at character 10 on line 1.
    edit.replace(target, { start: { line: 1, character: 10 }, end: { line: 1, character: 11 } }, "99");
    edit.insert(target, { line: 2, character: 0 }, "const c = 3;\n");
    expect(await layer.applyEdit(edit)).toBe(true);
    expect(readFileSync(join(root, "src", "app.ts"), "utf8")).toBe(
      "const a = 1;\nconst b = 99;\nconst c = 3;\n",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workspace.fs round-trips files and directories", async () => {
  const root = makeTempRoot();
  try {
    const layer = makeLayer(root);
    const file = { fsPath: join(root, "src", "app.ts") };
    const stats = (await (
      layer.fs.stat as (target: unknown) => Promise<{ type: number; size: number }>
    )(file));
    expect(stats.type).toBe(1);
    const text = await (layer.fs.readFile as (t: unknown) => Promise<Uint8Array>)(file);
    expect(new TextDecoder().decode(text)).toContain("const a = 1;");
    const entries = (await (
      layer.fs.readDirectory as (t: unknown) => Promise<[string, number][]>
    )({ fsPath: join(root, "src") })).map(([name]) => name);
    expect(entries).toContain("app.ts");
    await (layer.fs.createDirectory as (t: unknown) => Promise<void>)({
      fsPath: join(root, "lib", "deep"),
    });
    expect(existsSync(join(root, "lib", "deep"))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("openTextDocument exposes text, offsets and line counts", async () => {
  const root = makeTempRoot();
  try {
    const layer = makeLayer(root);
    const document = await layer.openTextDocument({ fsPath: join(root, "src", "app.ts") });
    expect(document.lineCount).toBe(2);
    expect(document.getText()).toContain("const b = 2;");
    expect(document.getText({ start: { line: 0, character: 0 }, end: { line: 0, character: 5 } })).toBe(
      "const",
    );
    expect(document.offsetAt({ line: 1, character: 0 })).toBe(13);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findFiles applies include globs, gitignore rules and excluded directories", async () => {
  const root = makeTempRoot();
  try {
    mkdirSync(join(root, "build"), { recursive: true });
    writeFileSync(join(root, "build", "out.js"), "");
    const layer = makeLayer(root);
    const files = await layer.findFiles("**/*.ts");
    const paths = files.map((uri) => uri.fsPath.replace(/\\/g, "/"));
    expect(paths.some((p) => p.endsWith("/src/app.ts"))).toBe(true);
    expect(paths.some((p) => p.includes("secrets.txt"))).toBe(false);
    expect(paths.some((p) => p.includes("/build/"))).toBe(false);

    const all = await layer.findFiles("**/*");
    const allPaths = all.map((uri) => uri.fsPath.replace(/\\/g, "/"));
    expect(allPaths.some((p) => p.endsWith("README.md"))).toBe(true);
    expect(allPaths.some((p) => p.endsWith("secrets.txt"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("configuration persists across layer instances", async () => {
  const root = makeTempRoot();
  try {
    const storageDir = join(root, "storage");
    const first = createWorkspaceLayer({ extensionRoot, storageDir, bridge });
    const section = first.configuration.getConfiguration("codebuddy.completion");
    await section.update("enabled", false);
    await section.update("model", "codewise");
    // Writes are debounced; wait out the flush before re-reading from disk.
    await new Promise((resolve) => setTimeout(resolve, 250));

    const second = createWorkspaceLayer({ extensionRoot, storageDir, bridge });
    const reloaded = second.configuration.getConfiguration("codebuddy.completion");
    expect(reloaded.get("enabled")).toBe(false);
    expect(reloaded.get("model")).toBe("codewise");
    expect(reloaded.get("missing", "fallback")).toBe("fallback");
    expect(reloaded.has("enabled")).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("terminal shellIntegration executes commands and reports the exit code", async () => {
  const root = makeTempRoot();
  try {
    const layer = makeLayer(root);
    const ended: { exitCode: number | undefined }[] = [];
    layer.terminals.onDidEndTerminalShellExecution.event((event) =>
      ended.push({ exitCode: event.exitCode }),
    );
    const terminal = layer.terminals.createTerminal({
      name: "test",
      env: { CODEBUDDY_SESSION_ID: "test-session" },
    });
    expect(terminal.shellIntegration).toBeDefined();
    expect(terminal.creationOptions.env?.CODEBUDDY_SESSION_ID).toBe("test-session");

    const command = "echo hello";
    const execution = terminal.shellIntegration!.executeCommand(command);
    let output = "";
    for await (const chunk of execution.read()) output += chunk;
    expect(output).toContain("hello");
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(ended[ended.length - 1]?.exitCode).toBe(0);

    // A failing command surfaces its exit code.
    const failing = terminal.shellIntegration!.executeCommand(
      process.platform === "win32" ? "exit /b 3" : "exit 3",
    );
    for await (const _ of failing.read()) void _;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(ended[ended.length - 1]?.exitCode).toBe(3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workspace folders and relative paths follow the pushed root", () => {
  const root = makeTempRoot();
  try {
    const layer = makeLayer(root);
    const segments = root.split(/[/\\]/);
    expect(layer.getWorkspaceFolders()[0]?.name).toBe(segments[segments.length - 1]);
    expect(layer.asRelativePath({ fsPath: join(root, "src", "app.ts") })).toBe("src/app.ts");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
