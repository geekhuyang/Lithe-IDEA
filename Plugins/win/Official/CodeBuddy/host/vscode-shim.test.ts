import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import type { Bridge } from "./bridge";
import { createVscodeShim } from "./vscode-shim";

/**
 * Minimal `Bridge` stand-in. The shim only registers handler callbacks at
 * construction time (e.g. `commands.execute`); it performs no I/O while building
 * the `vscode` API surface, so a no-op bridge is enough to exercise the surface.
 */
function fakeBridge(): Bridge {
  const noop = () => {};
  return {
    onCall: noop,
    onEvent: () => () => undefined,
    emit: noop,
    request: () => Promise.resolve(null),
    sendReady: noop,
    dispatchEvent: noop,
    handleMessage: async () => undefined,
    write: noop,
  } as unknown as Bridge;
}

function buildApi(): Record<string, unknown> {
  const { api } = createVscodeShim({
    bridge: fakeBridge(),
    extensionRoot: "/tmp/codebuddy-extension",
    storageDir: tmpdir(),
  });
  return api;
}

// Regression test for the CodeBuddy sidebar "fails to open" bug. The vendored
// extension (`tencentcloud.codingcopilot`) calls
// `new vscode.default.RelativePattern(...)` inside `activate()` while watching
// the MCP settings file. Our `vscode` module is the `api` object, so the
// constructor must live directly on it. When it was missing the sidecar threw
// `RelativePattern is not a constructor`, reported `host.activationFailed` and
// exited, leaving the chat sidebar stuck on the "failed" phase.
test("the vscode shim exposes RelativePattern so activation does not crash", () => {
  const api = buildApi();
  expect(typeof api.RelativePattern).toBe("function");
  expect(api.RelativePattern).not.toBeUndefined();
  // Confirm it is actually a constructor, not a plain object.
  expect(() => new (api.RelativePattern as new (base: unknown, pattern: string) => unknown)(
    { uri: { fsPath: "/ws", path: "/ws", scheme: "file" } },
    "**/mcp.json",
  )).not.toThrow();
});

test("RelativePattern captures base, pattern and a resolved baseUri", () => {
  const api = buildApi();
  const Ctor = api.RelativePattern as new (base: unknown, pattern: string) => {
    base: unknown;
    pattern: string;
    baseUri: unknown;
  };

  const folderBase = { uri: { fsPath: "/ws", path: "/ws", scheme: "file" }, name: "ws", index: 0 };
  const fromFolder = new Ctor(folderBase, "**/mcp.json");
  expect(fromFolder.base).toBe(folderBase);
  expect(fromFolder.pattern).toBe("**/mcp.json");
  expect(fromFolder.baseUri).toBe(folderBase.uri);

  // A bare Uri base resolves its baseUri to itself (no `uri` wrapper).
  const uriBase = { fsPath: "/x", path: "/x", scheme: "file" };
  const fromUri = new Ctor(uriBase, "*.ts");
  expect(fromUri.baseUri).toBe(uriBase);
});

// `watchFile` immediately forwards the RelativePattern into
// `workspace.createFileSystemWatcher`. Without a no-op watcher, activation would
// crash on the very next line after the RelativePattern fix. We return a watcher
// with the standard event/dispose surface so `McpAgentDispatcherImpl` can wire up
// its MCP settings watcher without throwing.
test("workspace.createFileSystemWatcher returns a no-op watcher with the vscode surface", () => {
  const api = buildApi();
  const workspace = api.workspace as {
    createFileSystemWatcher: (
      pattern: unknown,
      ignoreCreate?: boolean,
      ignoreChange?: boolean,
      ignoreDelete?: boolean,
    ) => {
      ignoreCreateEvents: boolean;
      ignoreChangeEvents: boolean;
      ignoreDeleteEvents: boolean;
      onDidCreate: unknown;
      onDidChange: unknown;
      onDidDelete: unknown;
      dispose: () => void;
    };
  };
  expect(typeof workspace.createFileSystemWatcher).toBe("function");

  const watcher = workspace.createFileSystemWatcher("/ws/**/mcp.json", true, false, false);
  expect(watcher.ignoreCreateEvents).toBe(true);
  expect(watcher.ignoreChangeEvents).toBe(false);
  expect(typeof watcher.onDidCreate).toBe("function");
  expect(typeof watcher.onDidChange).toBe("function");
  expect(typeof watcher.onDidDelete).toBe("function");
  expect(() => watcher.dispose()).not.toThrow();
});
