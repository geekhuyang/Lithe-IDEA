/**
 * Injects the Lithe integration settings into the vendored extension's remote
 * product configuration (`/v3/config`).
 *
 * The extension picks its sign-in provider from `authentication.type` in that
 * configuration. The public endpoint does not serve an `authentication`
 * section to anonymous requests, so a stock run has no provider and every
 * login attempt fails with "No available Authentication Provider found". The
 * JetBrains host solves the same problem by injecting a configuration file
 * through `EnvProductProvider`; as the Node sidecar we do the equivalent at
 * the HTTP layer: when the extension fetches its product configuration we
 * merge the Lithe integration defaults into the response body. This keeps the
 * vendored tree byte-for-byte untouched.
 */
import * as http from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import * as https from "node:https";

/** Lithe-side defaults merged into the extension's product configuration. */
export interface ProductConfigDefaults {
  /** SaaS API base; matches the bundle's own `TencentAPIImpl` default. */
  endpoint: string;
  /** Advertised host identity; the header builder derives `X-IDE-Type`. */
  platform: string;
  /** Browser (external-link) sign-in, the flow JetBrains hosts do not use. */
  authenticationType: string;
  productVersion: string;
}

const CONFIG_PATH_PATTERN = /^\/v3\/config(\?|$)/;
const DEFAULT_HOST_SUFFIX = "copilot.tencent.com";

interface PatchedIncomingMessage extends PassThrough {
  headers: http.IncomingHttpHeaders;
  statusCode?: number;
  statusMessage?: string;
  rawHeaders?: string[];
}

function injectConfig(
  rawBody: string,
  defaults: ProductConfigDefaults,
  bundled: Record<string, unknown>,
): string {
  let parsed: { code?: number; data?: Record<string, unknown> };
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return rawBody;
  }
  if (typeof parsed?.code !== "number" || typeof parsed.data !== "object" || parsed.data === null) {
    return rawBody;
  }
  const data = parsed.data;
  // The bundled product.json carries the structural fields the extension
  // needs before it can even read the env channel (productConfigEnv,
  // productConfigPathEnv) plus the authentication section that decides which
  // sign-in provider exists. Server values win, but null placeholders (e.g.
  // "models": null) must not erase the bundled defaults.
  const serverValues = Object.fromEntries(
    Object.entries(data).filter(([, value]) => value !== null && value !== undefined),
  );
  // The auth manager resolves the API base as
  // authentication.endpoint || endpoint and the platform query as
  // authentication.attributes.platform || platform. Pin both explicitly:
  // without them the sign-in probe went out as http://...:80 with
  // platform=jetbrains and died on a 404.
  const authentication = {
    ...((bundled.authentication as Record<string, unknown> | undefined) ?? {}),
    ...((data.authentication as Record<string, unknown> | undefined) ?? {}),
    endpoint: defaults.endpoint,
    attributes: {
      ...(((bundled.authentication as Record<string, unknown> | undefined)?.attributes as
        | Record<string, unknown>
        | undefined) ?? {}),
      ...(((data.authentication as Record<string, unknown> | undefined)?.attributes as
        | Record<string, unknown>
        | undefined) ?? {}),
      platform: defaults.platform,
    },
  };
  const merged = {
    ...bundled,
    ...serverValues,
    platform: data.platform ?? bundled.platform ?? defaults.platform,
    endpoint: data.endpoint ?? bundled.endpoint ?? defaults.endpoint,
    authentication,
  };
  return JSON.stringify({ ...parsed, data: merged });
}

function rewriteConfigResponse(
  response: http.IncomingMessage,
  listeners: Array<(message: http.IncomingMessage) => void>,
  defaults: ProductConfigDefaults,
  bundled: Record<string, unknown>,
): void {
  const chunks: Buffer[] = [];
  response.on("data", (chunk: Buffer | string) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  response.on("error", () => undefined);
  response.on("end", () => {
    const original = Buffer.concat(chunks).toString("utf8");
    const modified = injectConfig(original, defaults, bundled);
    const headers: http.IncomingHttpHeaders = { ...response.headers };
    delete headers["content-length"];
    headers["content-length"] = String(Buffer.byteLength(modified, "utf8"));
    const patched = new PassThrough() as PatchedIncomingMessage;
    patched.headers = headers;
    patched.statusCode = response.statusCode;
    patched.statusMessage = response.statusMessage;
    patched.rawHeaders = Object.entries(headers).flatMap(([key, value]) =>
      Array.isArray(value)
        ? value.map((entry) => [key, String(entry)] as [string, string])
        : [[key, String(value)] as [string, string]],
    ).flat();
    for (const listener of listeners) {
      try {
        listener(patched as unknown as http.IncomingMessage);
      } catch {
        // A broken consumer must not affect the others.
      }
    }
    patched.end(modified, "utf8");
  });
}

function patchModule(
  target: typeof http | typeof https,
  name: string,
  defaults: ProductConfigDefaults,
  bundledConfig: Record<string, unknown>,
): void {
  const original = target.request;
  target.request = function patchedRequest(this: unknown, ...args: unknown[]) {
    process.stderr.write(
      "[injection] patchedRequest invoked on " + name + " args0=" + (typeof args[0] === "string" ? "url" : "options") + "\n",
    );
    const request = (original as (...requestArgs: unknown[]) => http.ClientRequest).apply(this, args);
    try {
      const first = args[0];
      const options = (
        typeof first === "string" ? new URL(first) : first
      ) as http.RequestOptions & { hostname?: string; host?: string; path?: string };
      const host = options.hostname ?? options.host ?? "";
      const path = options.path ?? "";
      if (!host.endsWith(DEFAULT_HOST_SUFFIX) || !CONFIG_PATH_PATTERN.test(path)) {
        return request;
      }
      process.stderr.write("[injection] intercepting " + host + path + "\n");
      // Force a plain-text response so the body can be rewritten without
      // decompressing (axios negotiates gzip by default).
      if (options.headers && !Array.isArray(options.headers)) {
        const mutableHeaders = options.headers as Record<string, unknown>;
        mutableHeaders["accept-encoding"] = "identity";
      }
      // Hold back response listeners until the buffered body has been
      // rewritten, then hand them a message that duck-types IncomingMessage.
      const responseListeners: Array<(message: http.IncomingMessage) => void> = [];
      const originalOn = request.on.bind(request);
      const originalOnce = request.once.bind(request);
      request.on = function patchedOn(event: string, listener: (...listenerArgs: unknown[]) => void) {
        if (event === "response") {
          responseListeners.push(listener as (message: http.IncomingMessage) => void);
          return request;
        }
        return originalOn(event, listener as never);
      } as typeof request.on;
      request.once = function patchedOnce(event: string, listener: (...listenerArgs: unknown[]) => void) {
        if (event === "response") {
          responseListeners.push(listener as (message: http.IncomingMessage) => void);
          return request;
        }
        return originalOnce(event, listener as never);
      } as typeof request.once;
      originalOn("response", (response: http.IncomingMessage) => {
        process.stderr.write(
          "[injection] response status=" + response.statusCode + " encoding=" + String(response.headers["content-encoding"]) + "\n",
        );
        if (response.headers["content-encoding"]) {
          // Compressed bodies are forwarded untouched rather than decoded.
          for (const listener of responseListeners) listener(response);
          return;
        }
        rewriteConfigResponse(response, responseListeners, defaults, bundledConfig);
      });
    } catch {
      // Injection must never break the request.
    }
    return request;
  } as typeof target.request;
  void name;
}

/**
 * Returns a module proxy whose `request` is the config-injecting wrapper. The
 * extension bundle captures the http/https module references at its own
 * evaluation time, so patching the module property afterwards is not enough;
 * a proxy handed out through Module._load always wins.
 */
export function createHttpModuleProxy(
  target: typeof http | typeof https,
  name: string,
  defaults: ProductConfigDefaults,
  bundledConfig: Record<string, unknown>,
): typeof http | typeof https {
  return new Proxy(target, {
    get(module: typeof http | typeof https, property: string | symbol) {
      if (property === "request") {
        return buildInjectingRequest(target, name, defaults, bundledConfig);
      }
      const value = Reflect.get(module, property, module);
      return typeof value === "function" ? value.bind(module) : value;
    },
  });
}

function buildInjectingRequest(
  target: typeof http | typeof https,
  name: string,
  defaults: ProductConfigDefaults,
  bundledConfig: Record<string, unknown>,
): typeof target.request {
  const original = target.request;
  return function injectingRequest(this: unknown, ...args: unknown[]) {
    const request = (original as (...requestArgs: unknown[]) => http.ClientRequest).apply(this, args);
    try {
      const first = args[0];
      const options = (
        typeof first === "string" ? new URL(first) : first
      ) as http.RequestOptions & { hostname?: string; host?: string; path?: string };
      const host = options.hostname ?? options.host ?? "";
      const path = options.path ?? "";
      if (!host.endsWith(DEFAULT_HOST_SUFFIX) || !CONFIG_PATH_PATTERN.test(path)) {
        return request;
      }
      if (options.headers && !Array.isArray(options.headers)) {
        const mutableHeaders = options.headers as Record<string, unknown>;
        mutableHeaders["accept-encoding"] = "identity";
      }
      const responseListeners: Array<(message: http.IncomingMessage) => void> = [];
      const originalOn = request.on.bind(request);
      const originalOnce = request.once.bind(request);
      request.on = function patchedOn(event: string, listener: (...listenerArgs: unknown[]) => void) {
        if (event === "response") {
          responseListeners.push(listener as (message: http.IncomingMessage) => void);
          return request;
        }
        return originalOn(event, listener as never);
      } as typeof request.on;
      request.once = function patchedOnce(event: string, listener: (...listenerArgs: unknown[]) => void) {
        if (event === "response") {
          responseListeners.push(listener as (message: http.IncomingMessage) => void);
          return request;
        }
        return originalOnce(event, listener as never);
      } as typeof request.once;
      originalOn("response", (response: http.IncomingMessage) => {
        process.stderr.write(
          "[injection] response status=" + String(response.statusCode) + " encoding=" + String(response.headers["content-encoding"]) + "\n",
        );
        if (response.headers["content-encoding"]) {
          for (const listener of responseListeners) listener(response);
          return;
        }
        rewriteConfigResponse(response, responseListeners, defaults, bundledConfig);
      });
    } catch {
      // Injection must never break the request.
    }
    return request;
  } as typeof target.request;
}

/** Loads the vendored product.json; empty when it is missing or malformed. */
export function loadBundledProductConfig(extensionRoot: string): Record<string, unknown> {
  try {
    const bundledConfig = JSON.parse(
      readFileSync(join(extensionRoot, "product.json"), "utf8"),
    ) as Record<string, unknown>;
    process.stderr.write(
      "[injection] bundled product.json loaded, keys: " + Object.keys(bundledConfig).join(",") + "\n",
    );
    return bundledConfig;
  } catch {
    // Without it the extension still runs, but sign-in has no provider.
    process.stderr.write("[injection] bundled product.json missing or malformed\n");
    return {};
  }
}

/** Installs the response injection; returns the bundled product config. */
export function installProductConfigInjection(
  defaults: ProductConfigDefaults,
  extensionRoot: string,
): Record<string, unknown> {
  // The vendored product.json ships with the vsix (the JetBrains host relies
  // on it the same way); it carries productConfigEnv plus the authentication
  // section the extension needs before any remote sync can complete.
  let bundledConfig: Record<string, unknown> = {};
  try {
    bundledConfig = JSON.parse(readFileSync(join(extensionRoot, "product.json"), "utf8")) as Record<
      string,
      unknown
    >;
    process.stderr.write(
      "[injection] bundled product.json loaded, keys: " + Object.keys(bundledConfig).join(",") + "\n",
    );
  } catch {
    // Without it the extension still runs, but sign-in has no provider.
  }
  patchModule(http, "http", defaults, bundledConfig);
  patchModule(https, "https", defaults, bundledConfig);
  // The extension resolves its client identity through the environment too.
  process.env.ACC_IDE_TYPE ??= "VSCode";
  process.env.CLIENT_INFO_PLATFORM ??= defaults.platform;
  // A development shell may inherit host IDE variables (JetBrains sets
  // ACC_PRODUCT_CONFIG, the internet-environment switch routes to internal
  // endpoints) that would override the injected configuration; the Lithe
  // host always serves its own.
  delete process.env.ACC_PRODUCT_CONFIG;
  delete process.env.CODEBUDDY_COPILOT_INTERNET_ENVIRONMENT;
  process.env.CLIENT_INFO_IDE_TYPE ??= "VSCode";
  process.env.CLIENT_INFO_PRODUCT_NAME ??= "Lithe";
  process.env.CLIENT_INFO_PRODUCT_VERSION ??= defaults.productVersion;
  return bundledConfig;
}
