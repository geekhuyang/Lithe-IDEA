# Vendored CodeBuddy VS Code extension

This directory contains the unmodified `coding-copilot` VS Code extension from
the official CodeBuddy JetBrains plugin release
`coding-copilot-jetbrains-4.12.41911495-8d24ca2b.zip` (JetBrains Marketplace).
It is the reference VS Code implementation of the CodeBuddy product: chat,
commit-message generation and the cloud session protocol all live in
`out/extension/index.js`.

- License: MIT, Copyright 2023 Tencent Cloud (`LICENSE.txt`).
- Source of truth: the JetBrains plugin release archive. Update this directory
  only by replacing it with a newer official release and re-verifying
  activation through `host/`.
- `integration-mcp/` from the original release is intentionally not vendored;
  the bundled MCP skill servers are lazy-loaded tooling that phase one does not
  exercise.
- Do not edit files under `vsix/extension/`. Lithe-specific behavior lives in
  the `vscode` API shim under `host/`, which is the supported integration
  surface.
