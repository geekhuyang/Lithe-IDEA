import { expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useFileSystemStore } from "@/features/file-system/stores/file-system.store";
import { installHappyDom } from "@/test-utils/happy-dom";
import type {
  SearchFilesRequest,
  SearchFilesResponse,
} from "@/features/file-search/lib/file-search-api";
import type { ContentMatch } from "../types/quick-open.types";

interface PendingCall {
  request: SearchFilesRequest;
  resolve: (response: SearchFilesResponse) => void;
}

const pendingCalls: PendingCall[] = [];
const searchFilesContentMock = mock(
  (request: SearchFilesRequest) =>
    new Promise<SearchFilesResponse>((resolve) => {
      pendingCalls.push({ request, resolve });
    }),
);

mock.module("@/features/file-search/lib/file-search-api", () => ({
  searchFilesContent: searchFilesContentMock,
}));

const { useContentMatches } = await import("./use-content-matches");

const ROOT = "D:/fixture/project";

const contentResponse = (
  files: Array<{ path: string; lines: Array<{ line: number; column: number; text: string }> }>,
): SearchFilesResponse => {
  const results = files.map((file) => ({
    file_path: file.path,
    matches: file.lines.map((entry) => ({
      line_number: entry.line,
      line_content: entry.text,
      column_start: entry.column,
      column_end: entry.column + "alpha".length,
    })),
    total_matches: file.lines.length,
  }));
  return {
    results,
    total_files: results.length,
    searched_files: results.length,
    searchable_files: results.length,
    files_with_matches: results.length,
    next_file_offset: results.length,
    has_more: false,
    is_indexing: false,
    indexed_files: results.length,
  };
};

const alphaResponse = () =>
  contentResponse([
    {
      path: `${ROOT}/src/alpha.ts`,
      lines: [
        { line: 4, column: 6, text: "const alpha = 1;" },
        { line: 9, column: 0, text: "alpha();" },
      ],
    },
  ]);

const betaResponse = () =>
  contentResponse([
    { path: `${ROOT}/src/beta.ts`, lines: [{ line: 12, column: 2, text: "beta()" }] },
  ]);

const mountProbe = async (query: string, read: (matches: ContentMatch[]) => void) => {
  const restoreDom = installHappyDom();
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousAct = environment.IS_REACT_ACT_ENVIRONMENT;
  const previousRootFolderPath = useFileSystemStore.getState().rootFolderPath;
  const previousWorkspaceFolders = useFileSystemStore.getState().workspaceFolders;
  const host = document.createElement("div");
  let root: Root | undefined;

  function Probe({ query: probeQuery }: { query: string }) {
    const { matches } = useContentMatches(probeQuery, true);
    read(matches);
    return null;
  }

  try {
    environment.IS_REACT_ACT_ENVIRONMENT = true;
    useFileSystemStore.setState({ rootFolderPath: ROOT, workspaceFolders: [] });
    document.body.append(host);
    root = createRoot(host);
    const mountedRoot = root;
    await act(async () => mountedRoot.render(<Probe query={query} />));
  } catch (error) {
    await act(async () => root?.unmount());
    host.remove();
    useFileSystemStore.setState({
      rootFolderPath: previousRootFolderPath,
      workspaceFolders: previousWorkspaceFolders,
    });
    if (previousAct === undefined) delete environment.IS_REACT_ACT_ENVIRONMENT;
    else environment.IS_REACT_ACT_ENVIRONMENT = previousAct;
    restoreDom();
    throw error;
  }

  return {
    rerender: async (nextQuery: string) => {
      await act(async () => root?.render(<Probe query={nextQuery} />));
    },
    unmount: async () => {
      try {
        await act(async () => root?.unmount());
      } finally {
        host.remove();
        useFileSystemStore.setState({
          rootFolderPath: previousRootFolderPath,
          workspaceFolders: previousWorkspaceFolders,
        });
        if (previousAct === undefined) delete environment.IS_REACT_ACT_ENVIRONMENT;
        else environment.IS_REACT_ACT_ENVIRONMENT = previousAct;
        restoreDom();
      }
    },
  };
};

test("content search flattens grouped matches into one-based line and column entries", async () => {
  let latest: ContentMatch[] = [];
  const probe = await mountProbe("alpha", (matches) => {
    latest = matches;
  });

  try {
    expect(pendingCalls).toHaveLength(1);
    expect(pendingCalls[0]?.request).toMatchObject({
      root_paths: [ROOT],
      query: "alpha",
    });

    await act(async () => pendingCalls[0]?.resolve(alphaResponse()));

    expect(latest).toEqual([
      {
        filePath: `${ROOT}/src/alpha.ts`,
        name: "alpha.ts",
        line: 4,
        column: 7,
        preview: "const alpha = 1;",
      },
      {
        filePath: `${ROOT}/src/alpha.ts`,
        name: "alpha.ts",
        line: 9,
        column: 1,
        preview: "alpha();",
      },
    ]);
  } finally {
    await probe.unmount();
    pendingCalls.length = 0;
  }
});

test("a blank query clears matches without searching", async () => {
  let latest: ContentMatch[] = [];
  const probe = await mountProbe("   ", (matches) => {
    latest = matches;
  });

  try {
    expect(pendingCalls).toHaveLength(0);
    expect(latest).toEqual([]);
  } finally {
    await probe.unmount();
    pendingCalls.length = 0;
  }
});

test("responses from superseded queries never overwrite the current results", async () => {
  let latest: ContentMatch[] = [];
  const probe = await mountProbe("alpha", (matches) => {
    latest = matches;
  });

  try {
    expect(pendingCalls).toHaveLength(1);
    const staleCall = pendingCalls[0];

    await probe.rerender("beta");
    expect(pendingCalls).toHaveLength(2);
    const currentCall = pendingCalls[1];

    // Resolve the current query first, then let the superseded response arrive late.
    await act(async () => currentCall?.resolve(betaResponse()));
    expect(latest.map((match) => match.filePath)).toEqual([`${ROOT}/src/beta.ts`]);

    await act(async () => staleCall?.resolve(alphaResponse()));
    expect(latest.map((match) => match.filePath)).toEqual([`${ROOT}/src/beta.ts`]);
  } finally {
    await probe.unmount();
    pendingCalls.length = 0;
  }
});
