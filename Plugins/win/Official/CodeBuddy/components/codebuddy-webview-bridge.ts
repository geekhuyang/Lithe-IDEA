/**
 * Pure helpers that adapt the vendored extension's webview HTML for hosting in
 * a Lithe tool window iframe. Kept free of React and Tauri state so the CSP and
 * asset-rewrite rules stay unit-testable: the asset protocol conversion arrives
 * as a mapper instead of being imported here.
 */

/** Maps a local extension path onto a URL the webview can load. */
export type AssetUrlMapper = (localPath: string) => string;

/** Extracts the CSP nonce so the injected bridge script passes the page policy. */
export function extractWebviewNonce(html: string): string | null {
  const match = /nonce-([A-Za-z0-9+/=]+)/.exec(html);
  return match ? match[1] : null;
}

/**
 * Extracts the origin of a mapped asset URL.
 *
 * Tauri's `convertFileSrc` percent-encodes the whole Windows path into a single
 * URL segment (`http://asset.localhost/D%3A%5C...`), so the origin has to be
 * read off the string: `URL.origin` reports `"null"` for the non-special
 * `asset:` scheme used on macOS and Linux.
 */
export function assetUrlOrigin(url: string): string {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]*)/.exec(url);
  return match ? match[1] : "";
}

/** Rewrites local extension paths to asset-protocol URLs loadable in the iframe. */
export function rewriteWebviewAssets(
  html: string,
  extensionRoot: string,
  toAssetUrl: AssetUrlMapper,
): string {
  const normalizedRoot = extensionRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalizedRoot) return html;
  // `asWebviewUri` results reach the HTML twice escaped in places: once as a raw
  // Windows path (`\`) and once JSON-encoded inside a script blob (`\\`). Accept
  // either, then hand the mapper a real path so the asset protocol resolves it.
  const separator = "[/\\\\]{1,2}";
  const pattern = new RegExp(
    `${normalizedRoot.split("/").map(escapeRegExp).join(separator)}[^"'\\s<)]*`,
    "g",
  );
  return html.replace(pattern, (matched) => {
    const normalized = matched.replace(/\\\\/g, "\\");
    // A directory reference (the page's `<base href>`) must keep a literal
    // trailing slash. `convertFileSrc` percent-encodes the separator into the
    // path segment, so the URL addresses a file instead of a directory and every
    // relative asset reference in the document resolves against the origin root.
    if (/[/\\]$/.test(normalized)) {
      const directory = normalized.replace(/[/\\]+$/, "");
      return `${toAssetUrl(directory)}/`;
    }
    return toAssetUrl(normalized);
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** CSP directives that have to allow the asset origin for the page to render. */
const WIDENED_CSP_DIRECTIVES = new Set([
  "style-src",
  "img-src",
  "font-src",
  "script-src",
  "script-src-elem",
  "connect-src",
]);

/**
 * Allows the asset origin in the page's Content-Security-Policy.
 *
 * The vendored webview ships a policy that only allows the `lithe-codebuddy:`
 * scheme, while the bundled assets are served by the asset protocol. Without
 * this the stylesheet, fonts and images are refused and the chat page never
 * paints.
 */
export function widenWebviewCsp(html: string, origin: string): string {
  if (!origin) return html;
  return html.replace(
    /(<meta\s+http-equiv=["']Content-Security-Policy["']\s+content=")([^"]*)(")/gi,
    (_match, open: string, content: string, close: string) =>
      `${open}${widenCspContent(content, origin)}${close}`,
  );
}

function widenCspContent(content: string, origin: string): string {
  return content
    .split(";")
    .map((directive) => directive.trim())
    .filter(Boolean)
    .map((directive) => {
      const [name, ...values] = directive.split(/\s+/);
      if (!WIDENED_CSP_DIRECTIVES.has(name)) return directive;
      if (name === "connect-src") {
        // The chat page fetches the mode/model/skills data from the CodeBuddy
        // API hosts itself; the shipped policy only lists the telemetry
        // domains, so every API call died on CSP and the input toolbar
        // rendered empty. Allow all secure endpoints, matching what the
        // original IDE hosts' injector does.
        const extra = ["https:", origin];
        const missing = extra.filter((value) => !values.includes(value));
        return missing.length === 0 ? directive : `${name} ${values.join(" ")} ${missing.join(" ")}`;
      }
      if (values.includes(origin)) return directive;
      return `${name} ${values.join(" ")} ${origin}`;
    })
    .join("; ");
}

/**
 * Builds the iframe document: the extension's HTML plus the `acquireVsCodeApi`
 * bridge that relays webview messages to the parent window (and from there to
 * the sidecar).
 */
export function buildWebviewDocument(
  html: string,
  handle: string,
  assetOrigin = "",
): string {
  const nonce = extractWebviewNonce(html);
  const nonceAttribute = nonce ? ` nonce="${nonce}"` : "";
  const bridge = `<script${nonceAttribute}>(function(){
    var handle = ${JSON.stringify(handle)};
    var state = { handle: handle, fetchSeq: 0, resolvers: {} };
    var api = {
      postMessage: function (message) {
        parent.postMessage({ source: 'lithe-codebuddy-webview', handle: handle, message: message }, '*');
        return Promise.resolve(true);
      },
      onDidReceiveMessage: function (listener) {
        (state.listeners = state.listeners || []).push(listener);
        return { dispose: function () {} };
      },
      asWebviewUri: function (uri) { return uri; },
      cspSource: 'lithe-codebuddy:',
      getState: function () { return state.snapshot; },
      setState: function (snapshot) { state.snapshot = snapshot; }
    };
    window.acquireVsCodeApi = function () { return api; };
    // The chat page fetches its mode/model/skills data from the CodeBuddy API
    // hosts itself. The asset-protocol origin makes those calls cross-origin
    // and the API sends no CORS headers, so remote fetches are relayed to the
    // pane, which runs them through the Tauri HTTP plugin (no CORS applies).
    var nativeFetch = window.fetch ? window.fetch.bind(window) : null;
    function headerObject(input) {
      var result = {};
      try {
        if (input && typeof input.forEach === 'function') {
          input.forEach(function (value, key) { result[key] = value; });
        } else if (input && typeof input.length === 'number') {
          for (var i = 0; i < input.length; i++) { result[input[i][0]] = input[i][1]; }
        } else if (input) {
          for (var key in input) { result[key] = String(input[key]); }
        }
      } catch (e) {}
      return result;
    }
    if (nativeFetch) {
      window.fetch = function (input, init) {
        var url = '';
        try { url = typeof input === 'string' ? input : (input && input.url) || String(input); } catch (e) {}
        if (!/^https:\\/\\//i.test(url)) return nativeFetch(input, init);
        var id = 'f' + (++state.fetchSeq);
        var headers = {};
        try { headers = headerObject(init && init.headers); } catch (e) {}
        if (!headers['Content-Type'] && !headers['content-type'] && init && init.body) {
          headers['Content-Type'] = 'application/json';
        }
        var body = null;
        try {
          if (init && init.body != null) {
            body = typeof init.body === 'string' ? init.body : String(init.body);
          }
        } catch (e) {}
        return new Promise(function (resolve, reject) {
          state.resolvers[id] = { resolve: resolve, reject: reject };
          parent.postMessage({
            source: 'lithe-codebuddy-webview',
            handle: handle,
            type: 'proxy-fetch',
            id: id,
            url: url,
            method: (init && init.method) || 'GET',
            headers: headers,
            body: body,
          }, '*');
          setTimeout(function () {
            if (state.resolvers[id]) {
              delete state.resolvers[id];
              reject(new TypeError('proxy fetch timed out: ' + url));
            }
          }, 60000);
        });
      };
    }
    window.addEventListener('message', function (event) {
      var data = event.data;
      if (data && data.type === 'proxy-fetch-result' && state.resolvers[data.id]) {
        var pending = state.resolvers[data.id];
        delete state.resolvers[data.id];
        if (data.error) {
          pending.reject(new TypeError(data.error));
        } else {
          try {
            pending.resolve(new Response(data.body ?? '', {
              status: data.status || 200,
              statusText: data.statusText || '',
              headers: data.headers || {},
            }));
          } catch (e) {
            pending.reject(e);
          }
        }
        return;
      }
      if (data && data.source === 'lithe-codebuddy-host' && data.handle === handle) {
        (state.listeners || []).forEach(function (listener) { listener(data.message); });
      }
    });
  })();</script>`;
  const widened = widenWebviewCsp(html, assetOrigin);
  if (widened.includes("<head>")) {
    return widened.replace("<head>", `<head>${bridge}`);
  }
  return `${bridge}${widened}`;
}
