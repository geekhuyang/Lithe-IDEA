#!/usr/bin/env node
// Compiles the CodeBuddy plugin's Node sidecar (vscode shim + bridge) to a
// single CommonJS entry the Tauri host can spawn. Run before dev and build so
// `Plugins/win/Official/CodeBuddy/host/main.js` stays in sync with its sources.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const pluginRoot = join(repoRoot, "Plugins", "win", "Official", "CodeBuddy");
const hostRoot = join(pluginRoot, "host");
const entry = join(hostRoot, "main.ts");
const output = join(hostRoot, "main.js");

if (!existsSync(entry)) {
  console.error(`[codebuddy-host] missing entry: ${entry}`);
  process.exit(1);
}

mkdirSync(hostRoot, { recursive: true });
rmSync(output, { force: true });

// Windows installs expose bun as `bun.exe`, `bun.cmd`, or the extensionless
// launcher, and a `.cmd` launcher cannot be spawned without a shell, so try
// each in turn. Arguments stay relative to `hostRoot` (the cwd) so shell
// quoting never has to handle repository paths that contain spaces.
const candidates = process.platform === "win32" ? ["bun.exe", "bun.cmd", "bun"] : ["bun"];
const args = ["build", "main.ts", "--target=node", "--format=cjs", "--outfile=main.js"];

let failure = null;
for (const command of candidates) {
  try {
    execFileSync(command, args, {
      cwd: hostRoot,
      stdio: "inherit",
      shell: command.endsWith(".cmd"),
    });
    failure = null;
    break;
  } catch (error) {
    failure = error;
  }
}

if (failure) {
  const hint =
    failure.code === "ENOENT"
      ? "bun was not found on PATH; install it before building the CodeBuddy host."
      : failure.message;
  console.error(`[codebuddy-host] build failed: ${hint}`);
  process.exit(1);
}

if (!existsSync(output)) {
  console.error(`[codebuddy-host] build produced no output: ${output}`);
  process.exit(1);
}
console.log(`[codebuddy-host] built ${output}`);
