import { expect, test } from "bun:test";
import {
  assetUrlOrigin,
  buildWebviewDocument,
  extractWebviewNonce,
  rewriteWebviewAssets,
  widenWebviewCsp,
} from "./codebuddy-webview-bridge";

test("the CSP nonce is extracted so the injected bridge passes the page policy", () => {
  const html = '<meta http-equiv="Content-Security-Policy" content="script-src \'nonce-abc123\'"/>';
  expect(extractWebviewNonce(html)).toBe("abc123");
  expect(extractWebviewNonce("<html><body>no policy</body></html>")).toBeNull();
});

test("local extension paths are rewritten to loadable asset URLs", () => {
  const html =
    '<script src="D:\\\\app\\\\vsix\\\\extension\\\\out\\\\webviews\\\\runtime.js"></script>' +
    '<link href="D:/app/vsix/extension/out/webviews/css/main.css"/>';
  const seen: string[] = [];
  const rewritten = rewriteWebviewAssets(html, "D:\\app\\vsix\\extension", (path) => {
    seen.push(path.replace(/\\/g, "/"));
    return `http://asset.localhost/${encodeURIComponent(path)}`;
  });
  // Both separator styles reach the mapper as one normalized path.
  expect(seen).toEqual([
    "D:/app/vsix/extension/out/webviews/runtime.js",
    "D:/app/vsix/extension/out/webviews/css/main.css",
  ]);
  expect(rewritten).not.toContain("D:\\\\app");
  expect(rewritten).toContain("http://asset.localhost");
  expect(rewritten.match(/asset\.localhost/g)?.length).toBe(2);
});

test("a directory reference keeps a literal trailing slash so relative assets resolve", () => {
  // Tauri's convertFileSrc percent-encodes the whole Windows path into one URL
  // segment, so a base href without a literal slash makes every relative asset
  // reference resolve against the origin root.
  const html = '<base href="D:\\app\\vsix\\extension/out/webviews/"/>';
  const rewritten = rewriteWebviewAssets(html, "D:\\app\\vsix\\extension", (path) =>
    `http://asset.localhost/${encodeURIComponent(path)}`,
  );
  expect(rewritten).toBe(
    '<base href="http://asset.localhost/D%3A%5Capp%5Cvsix%5Cextension%2Fout%2Fwebviews/"/>',
  );
  expect(rewritten.endsWith('/"/>')).toBe(true);
});

test("the asset origin is read off the mapped URL", () => {
  expect(assetUrlOrigin("http://asset.localhost/D%3A%5Capp")).toBe("http://asset.localhost");
  expect(assetUrlOrigin("asset://localhost/D%3A%5Capp")).toBe("asset://localhost");
  expect(assetUrlOrigin("not a url")).toBe("");
});

test("the page policy allows the asset origin for styles, images and fonts", () => {
  const html =
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; ' +
    "style-src 'unsafe-inline' lithe-codebuddy:; img-src lithe-codebuddy: data:; " +
    "font-src https: data: file:; script-src 'nonce-n1' 'strict-dynamic' lithe-codebuddy:;" +
    '"/>';
  const widened = widenWebviewCsp(html, "http://asset.localhost");
  expect(widened).toContain("style-src 'unsafe-inline' lithe-codebuddy: http://asset.localhost");
  expect(widened).toContain("img-src lithe-codebuddy: data: http://asset.localhost");
  expect(widened).toContain("font-src https: data: file: http://asset.localhost");
  // `default-src 'none'` stays untouched, and the nonce is preserved.
  expect(widened).toContain("default-src 'none'");
  expect(widened).toContain("'nonce-n1'");
  // Widening twice does not duplicate the origin.
  expect(widenWebviewCsp(widened, "http://asset.localhost")).toBe(widened);
});

test("connect-src opens every https endpoint for the chat page's API calls", () => {
  const html =
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; ' +
    'connect-src ws: wss: https://galileotelemetry.tencent.com"/>';
  const widened = widenWebviewCsp(html, "http://asset.localhost");
  expect(widened).toContain(
    "connect-src ws: wss: https://galileotelemetry.tencent.com https: http://asset.localhost",
  );
  // Widening twice does not duplicate the additions.
  expect(widenWebviewCsp(widened, "http://asset.localhost")).toBe(widened);
});

test("the bridge script is injected with the page nonce and relays by handle", () => {
  const html =
    '<html><head><meta http-equiv="Content-Security-Policy" content="script-src \'nonce-n1\'"/></head><body>chat</body></html>';
  const document = buildWebviewDocument(html, "webview-7");
  expect(document).toContain('<head><script nonce="n1">');
  expect(document).toContain("acquireVsCodeApi");
  expect(document).toContain('var handle = "webview-7"');
  expect(document).toContain(
    "parent.postMessage({ source: 'lithe-codebuddy-webview', handle: handle",
  );
  // The original document is preserved after the injected bridge.
  expect(document).toContain("<body>chat</body>");
});

test("building the document widens the page policy for the asset origin", () => {
  const html =
    '<html><head><meta http-equiv="Content-Security-Policy" content="style-src \'unsafe-inline\';"/>' +
    "</head><body>chat</body></html>";
  const document = buildWebviewDocument(html, "webview-7", "http://asset.localhost");
  expect(document).toContain("style-src 'unsafe-inline' http://asset.localhost");
});

test("a document without a head still receives the bridge", () => {
  const document = buildWebviewDocument("<html><body>x</body></html>", "webview-1");
  expect(document.startsWith("<script")).toBe(true);
  expect(document).toContain("<body>x</body>");
});
