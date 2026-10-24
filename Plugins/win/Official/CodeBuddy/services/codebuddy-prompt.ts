/** Pure prompt construction and output cleanup for the CodeBuddy CLI. */

export interface CodeBuddyChatTurn {
  role: "user" | "assistant";
  content: string;
}

/** Maximum recent turns replayed as text context for the stateless CLI. */
const MAX_CONTEXT_TURNS = 8;

/**
 * The CLI is invoked once per message without a session, so recent turns are
 * replayed as plain text. Only the tail is kept to bound the prompt size.
 */
export function buildChatPrompt(history: CodeBuddyChatTurn[], message: string): string {
  const trimmed = message.trim();
  if (!trimmed) return "";
  const context = history
    .slice(-MAX_CONTEXT_TURNS)
    .map((turn) => `${turn.role === "user" ? "User" : "Assistant"}: ${turn.content}`)
    .join("\n\n");
  if (!context) return trimmed;
  return `Previous conversation:\n\n${context}\n\nUser: ${trimmed}`;
}

/**
 * Asks for a commit message for the diff passed on stdin. The instruction
 * mirrors the shared AI commit rules: Conventional Commits, no invention
 * beyond the evidence, and only the message in the reply.
 */
export function buildCommitPrompt(): string {
  return [
    "Write a git commit message for the staged changes provided on stdin.",
    "Rules:",
    "- Reply with the commit message only, no explanation or Markdown fences.",
    "- Use the Conventional Commits format: type(scope): subject.",
    "- Describe only what the diff proves; never invent changes.",
    "- Keep the subject under 72 characters.",
  ].join("\n");
}

/** Builds the stdin payload: one diff block per selected file. */
export function buildCommitStdin(
  files: Array<{ path: string; changeKind: string; diff: string }>,
): string {
  return files.map((file) => `--- ${file.path} (${file.changeKind})\n${file.diff}`).join("\n\n");
}

/**
 * Extracts the commit message from CLI output: unwraps a single fenced block,
 * otherwise keeps the text as-is. Mirrors the shared decoder's fence handling.
 */
export function extractCommitMessage(output: string): string {
  const trimmed = output.trim();
  const fence = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(trimmed);
  const body = fence ? fence[1] : trimmed;
  const lines = body
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line, index, all) => line.trim() !== "" || all.slice(index).some((rest) => rest.trim() !== ""));
  return lines.join("\n").trim();
}
