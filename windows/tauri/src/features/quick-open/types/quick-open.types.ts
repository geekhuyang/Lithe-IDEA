export interface FileItem {
  name: string;
  path: string;
  isDir: boolean;
}

export interface CategorizedFiles {
  openBufferFiles: FileItem[];
  recentFilesInResults: FileItem[];
  otherFiles: FileItem[];
}

export type FileCategory = "open" | "recent" | "other";

export interface SearchResult {
  file: FileItem;
  score: number;
}

/** One matched line inside a file, produced by the shared Core content search. */
export interface ContentMatch {
  filePath: string;
  name: string;
  /** One-based line number of the matched line. */
  line: number;
  /** One-based column where the match starts. */
  column: number;
  preview: string;
}

/**
 * Keyboard-navigation entry shared by every Quick Open result kind. `id` is
 * unique across kinds because content matches repeat a file path once per
 * matched line.
 */
export interface QuickOpenNavigationItem {
  id: string;
  path: string;
  line?: number;
  column?: number;
}
