import { afterEach, expect, mock, test } from "bun:test";
import {
  getCommitDraftActions,
  registerCommitDraftAction,
  unregisterCommitDraftActionsByExtension,
} from "./commit-draft-action-registry";

const EXTENSION_ID = "lithe.codebuddy";
const OTHER_EXTENSION_ID = "lithe.other";

afterEach(() => {
  unregisterCommitDraftActionsByExtension(EXTENSION_ID);
  unregisterCommitDraftActionsByExtension(OTHER_EXTENSION_ID);
});

test("commit draft actions are listed for the commit panel to render", () => {
  registerCommitDraftAction({
    id: `${EXTENSION_ID}.generate-commit-message`,
    extensionId: EXTENSION_ID,
    title: "CodeBuddy",
    generate: async () => "chore: draft",
  });

  expect(getCommitDraftActions().map((action) => action.id)).toEqual([
    `${EXTENSION_ID}.generate-commit-message`,
  ]);
});

test("deactivating one extension keeps other extensions' actions", () => {
  registerCommitDraftAction({
    id: `${EXTENSION_ID}.codebuddy-action`,
    extensionId: EXTENSION_ID,
    title: "CodeBuddy",
    generate: async () => "a",
  });
  registerCommitDraftAction({
    id: `${OTHER_EXTENSION_ID}.other-action`,
    extensionId: OTHER_EXTENSION_ID,
    title: "Other",
    generate: async () => "b",
  });

  unregisterCommitDraftActionsByExtension(EXTENSION_ID);
  expect(getCommitDraftActions().map((action) => action.id)).toEqual([
    `${OTHER_EXTENSION_ID}.other-action`,
  ]);
});

test("a registered action receives the repository, selected files and signal", async () => {
  const generate = mock(async () => "feat: add codebuddy plugin");
  registerCommitDraftAction({
    id: `${EXTENSION_ID}.generate-commit-message`,
    extensionId: EXTENSION_ID,
    title: "CodeBuddy",
    generate,
  });

  const controller = new AbortController();
  const message = await getCommitDraftActions()[0]?.generate({
    repoPath: "D:/fixture/project",
    files: [{ path: "src/a.ts", changeKind: "modified", diff: "+let a = 1;" }],
    signal: controller.signal,
  });

  expect(message).toBe("feat: add codebuddy plugin");
  expect(generate).toHaveBeenCalledTimes(1);
});
