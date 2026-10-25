/**
 * Node sidecar entry for the CodeBuddy official plugin.
 *
 * Responsibilities:
 * 1. Install the `vscode` module so the vendored extension's `require("vscode")`
 *    resolves to the Lithe shim (the original extension host provided it).
 * 2. Open the stdio JSON bridge to the Lithe host.
 * 3. Activate the vendored extension and report readiness.
 *
 * Usage: node main.js --extension-root <vsix/extension> --extension-entry <index.js>
 */

import * as http from "node:http";
import * as https from "node:https";
import { inspect } from "node:util";
import * as os from "node:os";
import * as path from "node:path";

import { Bridge, type BridgeMessage } from "./bridge";
import { createVscodeShim } from "./vscode-shim";
import {
  createHttpModuleProxy,
  installProductConfigInjection,
  type ProductConfigDefaults,
} from "./product-config-injection";

/** Lithe defaults for the integration settings merged into `/v3/config`. */
const INJECTION_DEFAULTS: Omit<ProductConfigDefaults, "productVersion"> = {
  endpoint: "https://copilot.tencent.com",
  platform: "VSCode",
  authenticationType: "external-link-v2",
};

/**
 * Reads the vendored extension's version from its manifest so the injected
 * product configuration advertises the version the extension ships with.
 */
async function loadInjectionDefaults(extensionRoot: string): Promise<ProductConfigDefaults> {
  let productVersion = "0.0.0";
  try {
    const manifest = JSON.parse(
      await import("node:fs/promises").then((fs) =>
        fs.readFile(`${extensionRoot}/package.json`, "utf8"),
      ),
    ) as { version?: string };
    if (typeof manifest.version === "string") productVersion = manifest.version;
  } catch {
    // A missing manifest only degrades the reported version.
  }
  return { ...INJECTION_DEFAULTS, productVersion };
}

/**
 * Feeds host-to-sidecar messages (calls, replies, shutdown) into the bridge.
 * Without this loop the sidecar could only ever push outward: the sign-in
 * command, webview message deliveries, and request replies were silently
 * dropped, and every `codebuddy_host_call` blocked until timeout.
 */
function installStdinBridge(bridge: Bridge): void {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.resume();
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line) continue;
      try {
        const message = JSON.parse(line) as BridgeMessage;
        void bridge.handleMessage(message);
      } catch {
        // Non-JSON host noise is dropped, mirroring the reverse direction.
      }
    }
  });
}

function parseArguments(argv: string[]): { extensionRoot: string; extensionEntry: string } {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]?.replace(/^--/, "");
    const value = argv[index + 1];
    if (key && value !== undefined) values.set(key, value);
  }
  const extensionRoot =
    values.get("extension-root") ?? process.env.CODEBUDDY_EXTENSION_ROOT ?? process.cwd();
  const extensionEntry = values.get("extension-entry") ?? `${extensionRoot}/out/extension/index.js`;
  return { extensionRoot, extensionEntry };
}

/**
 * The Node loader hooks we patch. Both take the module request as their first
 * argument, so the shim can intercept `vscode` before Node resolves it.
 */
interface ModuleLoaderHooks {
  _resolveFilename: (request: string, ...rest: unknown[]) => string;
  _load: (request: string, ...rest: unknown[]) => unknown;
}

function installVscodeModule(
  shim: unknown,
  moduleProxies: Record<string, unknown>,
): void {
  const Module = require("node:module") as unknown as ModuleLoaderHooks;
  const originalResolve = Module._resolveFilename;
  Module._resolveFilename = function resolveFilename(request: string, ...rest: unknown[]): string {
    if (request === "vscode") return "vscode";
    return originalResolve.call(this, request, ...rest);
  };
  const originalLoad = Module._load;
  Module._load = function load(request: string, ...rest: unknown[]): unknown {
    if (request === "vscode") return shim;
    const proxy = moduleProxies[request];
    if (proxy) return proxy;
    return originalLoad.call(this, request, ...rest);
  };
}

/**
 * Keeps stdout a pure JSON bridge channel.
 *
 * The vendored extension logs through `console`, which writes to stdout by
 * default. Mixing that with the bridge protocol would let log lines be parsed
 * as bridge messages, and the host would drop them as non-JSON noise. Console
 * output therefore goes to stderr, which the host already surfaces as
 * `host.stderr` events.
 */
function redirectConsoleToStderr(): void {
  const format = (value: unknown): string =>
    typeof value === "string" ? value : inspect(value, { depth: 2 });
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    console[level] = (...args: unknown[]) => {
      process.stderr.write(`${args.map(format).join(" ")}\n`);
    };
  }
}

async function main(): Promise<void> {
  const { extensionRoot, extensionEntry } = parseArguments(process.argv.slice(2));
  // Must be installed before the extension is required: the extension picks
  // its sign-in provider from the product configuration fetched over HTTP.
  const injectionDefaults = await loadInjectionDefaults(extensionRoot);
  const bundledConfig = installProductConfigInjection(injectionDefaults, extensionRoot);
  // The ProductManager reads its endpoint cache synchronously from global
  // state during activation; seeding it lets the first config fetch target
  // the real API host instead of an empty localhost URL.
  const storageDir =
    process.env.CODEBUDDY_STORAGE_DIR ?? path.join(os.homedir(), ".lithe-codebuddy");
  const bridge = new Bridge(process.stdout);
  installStdinBridge(bridge);
  const { api, context } = createVscodeShim({
    bridge,
    extensionRoot,
    storageDir,
    stateSeed: { "CodeBuddy-Endpoint-Cache": injectionDefaults.endpoint },
  });
  installVscodeModule(api, {
    http: createHttpModuleProxy(http, "http", injectionDefaults, bundledConfig),
    https: createHttpModuleProxy(https, "https", injectionDefaults, bundledConfig),
  });

  redirectConsoleToStderr();

  bridge.emit("host.starting", { extensionRoot });

  try {
    // The extension bundle is CommonJS; requiring it runs its module body.
    const extension = require(extensionEntry) as {
      activate?: (context: unknown) => Promise<void> | void;
      deactivate?: () => Promise<void> | void;
    };
    if (typeof extension.activate !== "function") {
      throw new Error("CODEBUDDY_EXTENSION_NO_ACTIVATE");
    }
    await extension.activate(context);
    bridge.emit("host.activated", {});
    bridge.sendReady();
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    bridge.emit("host.activationFailed", { error: message });
    // Keep the bridge alive briefly so the host can surface the failure.
    setTimeout(() => process.exit(1), 100);
    return;
  }

  const shutdown = async () => {
    try {
      const extension = require(extensionEntry) as {
        deactivate?: () => Promise<void> | void;
      };
      await extension.deactivate?.();
    } catch {
      // Deactivation is best-effort.
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

void main();
