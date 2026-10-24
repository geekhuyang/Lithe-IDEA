import { useEffect, useMemo, useRef, useState } from "react";
import { searchFilesContent } from "@/features/file-search/lib/file-search-api";
import { getNativeWorkspaceRootPaths } from "@/features/file-search/utils/file-search-paths";
import { useFileSystemStore } from "@/features/file-system/stores/file-system.store";
import { getBaseName } from "@/utils/path-helpers";
import { MAX_CONTENT_MATCHES_SHOWN } from "../constants/limits";
import type { ContentMatch } from "../types/quick-open.types";

/**
 * Runs the shared Core content search for a Quick Open query and flattens the
 * per-file response into one entry per matched line.
 *
 * The caller passes an already debounced query. Responses from superseded
 * queries are discarded through a request generation, so a slow search never
 * overwrites the results of the query the user is looking at.
 */
export const useContentMatches = (query: string, enabled: boolean) => {
  const rootFolderPath = useFileSystemStore((state) => state.rootFolderPath);
  const workspaceFolders = useFileSystemStore((state) => state.workspaceFolders);
  const nativeRootPaths = useMemo(
    () => getNativeWorkspaceRootPaths(rootFolderPath, workspaceFolders),
    [rootFolderPath, workspaceFolders],
  );
  const rootPathsKey = nativeRootPaths.join("\n");
  const [matches, setMatches] = useState<ContentMatch[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const requestGenerationRef = useRef(0);

  useEffect(() => {
    const trimmedQuery = query.trim();
    if (!enabled || !trimmedQuery || rootPathsKey === "") {
      // Invalidate in-flight searches so their late responses stay discarded.
      requestGenerationRef.current += 1;
      setMatches([]);
      setIsSearching(false);
      return;
    }

    const generation = ++requestGenerationRef.current;
    setIsSearching(true);

    void (async () => {
      try {
        const response = await searchFilesContent({
          root_paths: nativeRootPaths,
          query: trimmedQuery,
          max_results: MAX_CONTENT_MATCHES_SHOWN,
        });
        if (generation !== requestGenerationRef.current) return;

        const flattened: ContentMatch[] = [];
        for (const result of response.results) {
          for (const match of result.matches) {
            if (flattened.length >= MAX_CONTENT_MATCHES_SHOWN) break;
            flattened.push({
              filePath: result.file_path,
              name: getBaseName(result.file_path, result.file_path),
              line: match.line_number,
              // Core reports zero-based match columns; the editor opens one-based positions.
              column: match.column_start + 1,
              preview: match.line_content,
            });
          }
          if (flattened.length >= MAX_CONTENT_MATCHES_SHOWN) break;
        }
        setMatches(flattened);
      } catch (error) {
        if (generation !== requestGenerationRef.current) return;
        console.error("Quick Open content search failed:", error);
        setMatches([]);
      } finally {
        if (generation === requestGenerationRef.current) {
          setIsSearching(false);
        }
      }
    })();
  }, [enabled, nativeRootPaths, query, rootPathsKey]);

  return { matches, isSearching };
};
