import { invoke } from "@/platform/tauri-core";
import {
  buildChatPrompt,
  buildCommitPrompt,
  buildCommitStdin,
  extractCommitMessage,
  type CodeBuddyChatTurn,
} from "./codebuddy-prompt";
import { getConfiguredCliPath } from "./codebuddy-settings";

/**
 * Drives the locally installed CodeBuddy CLI
 * (`npm install -g @tencent-ai/codebuddy-code`). The documented
 * non-interactive form passes the prompt as a positional argument and pipes
 * extra evidence on stdin, so no CLI-specific flags are assumed.
 */
const CLI_EXECUTABLES = ["codebuddy", "cbc", "codebuddy-code"] as const;

const CLI_TIMEOUT_MS = 120_000;

export const CODEBUDDY_CLI_MISSING = "CODEBUDDY_CLI_MISSING";
export const CODEBUDDY_CLI_FAILED = "CODEBUDDY_CLI_FAILED";
export const CODEBUDDY_CLI_TIMEOUT = "CODEBUDDY_CLI_TIMEOUT";
export const CODEBUDDY_CLI_EMPTY = "CODEBUDDY_CLI_EMPTY";

export interface BoundedProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
}

/** Resolves the configured path first, then the documented executable names. */
export async function resolveCodeBuddyExecutable(): Promise<string | null> {
  const configured = getConfiguredCliPath();
  const candidates = configured
    ? [configured, ...CLI_EXECUTABLES]
    : [...CLI_EXECUTABLES];
  return invoke<string | null>("resolve_executable", { candidates });
}

async function runCli(options: {
  prompt: string;
  stdin?: string;
  cwd?: string;
}): Promise<string> {
  const executable = await resolveCodeBuddyExecutable();
  if (!executable) throw new Error(CODEBUDDY_CLI_MISSING);
  const result = await invoke<BoundedProcessResult>("run_bounded_process", {
    executable,
    arguments: [options.prompt],
    stdin: options.stdin ?? null,
    cwd: options.cwd ?? null,
    timeoutMs: CLI_TIMEOUT_MS,
  });
  if (result.timedOut) throw new Error(CODEBUDDY_CLI_TIMEOUT);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(detail ? `${CODEBUDDY_CLI_FAILED}: ${detail}` : CODEBUDDY_CLI_FAILED);
  }
  const stdout = result.stdout.trim();
  if (!stdout) throw new Error(CODEBUDDY_CLI_EMPTY);
  return stdout;
}

/** Sends one chat turn; recent history is replayed as text context. */
export async function runCodeBuddyChat(
  history: CodeBuddyChatTurn[],
  message: string,
  cwd?: string,
): Promise<string> {
  const prompt = buildChatPrompt(history, message);
  if (!prompt) throw new Error(CODEBUDDY_CLI_EMPTY);
  const output = await runCli({ prompt, cwd });
  return output.trim();
}

/** Drafts a commit message for the selected files' diffs. */
export async function runCodeBuddyCommit(options: {
  repoPath: string;
  files: Array<{ path: string; changeKind: string; diff: string }>;
}): Promise<string> {
  const stdin = buildCommitStdin(options.files);
  if (!stdin.trim()) throw new Error(CODEBUDDY_CLI_EMPTY);
  const output = await runCli({
    prompt: buildCommitPrompt(),
    stdin,
    cwd: options.repoPath,
  });
  const message = extractCommitMessage(output);
  if (!message) throw new Error(CODEBUDDY_CLI_EMPTY);
  return message;
}

export { extractCommitMessage };
