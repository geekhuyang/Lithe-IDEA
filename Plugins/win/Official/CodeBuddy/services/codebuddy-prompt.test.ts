import { expect, test } from "bun:test";
import {
  buildChatPrompt,
  buildCommitPrompt,
  buildCommitStdin,
  extractCommitMessage,
} from "./codebuddy-prompt";

test("chat prompts replay only the recent turns as text context", () => {
  const history = Array.from({ length: 12 }, (_, index) => ({
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: `turn ${index}`,
  }));

  const prompt = buildChatPrompt(history, "解释这个函数");
  expect(prompt).toContain("User: turn 10");
  expect(prompt).toContain("Assistant: turn 11");
  // The tail bound keeps the first turns out of the prompt.
  expect(prompt).not.toContain("turn 0\n");
  expect(prompt.endsWith("User: 解释这个函数")).toBe(true);
});

test("blank chat messages produce no prompt", () => {
  expect(buildChatPrompt([], "   ")).toBe("");
});

test("the commit prompt asks for Conventional Commits evidence-only output", () => {
  const prompt = buildCommitPrompt();
  expect(prompt).toContain("Conventional Commits");
  expect(prompt).toContain("commit message only");
  expect(prompt).toContain("never invent changes");
});

test("commit stdin carries one labeled diff block per file", () => {
  const stdin = buildCommitStdin([
    { path: "a.ts", changeKind: "modified", diff: "+a" },
    { path: "b.ts", changeKind: "added", diff: "+b" },
  ]);
  expect(stdin).toBe("--- a.ts (modified)\n+a\n\n--- b.ts (added)\n+b");
});

test("commit message extraction unwraps fences and trims blank edges", () => {
  expect(extractCommitMessage("```\nfeat: add plugin\n\n body\n```")).toBe("feat: add plugin\n\n body");
  expect(extractCommitMessage("\n\n  fix: trim edges  \n\n")).toBe("fix: trim edges");
  expect(extractCommitMessage("   ")).toBe("");
});
