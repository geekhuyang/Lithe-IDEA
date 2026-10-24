import Command, {
  CommandEmpty,
  CommandHeader,
  CommandHeaderBadge,
  CommandInput,
  CommandList,
} from "@/ui/command";
import { useTranslation } from "@/i18n/locale-provider";
import { useQuickOpen } from "../hooks/use-quick-open";
import { getWorkspaceSymbolKey } from "../hooks/use-workspace-symbol-search";
import { ContentMatchListItem } from "./content-match-list-item";
import { EmptyState } from "./empty-state";
import { FileCountBadge } from "./file-count-badge";
import { FileListItem } from "./file-list-item";
import { SymbolListItem } from "./symbol-list-item";

const QuickOpen = () => {
  const { t } = useTranslation();
  const {
    isVisible,
    query,
    setQuery,
    debouncedQuery,
    inputRef,
    handleInputKeyDown,
    scrollContainerRef,
    onClose,
    files,
    isLoadingFiles,
    isIndexing,
    openBufferFiles,
    recentFilesInResults,
    otherFiles,
    contentMatches,
    openContentMatch,
    selectedIndex,
    handleItemSelect,
    handleItemHover,
    setSelectedIndex,
    rootFolderPath,
    isSymbolMode,
    symbols,
    isLoadingSymbols,
    handleSymbolSelect,
    isWorkspaceSymbolMode,
    workspaceSymbols,
    isLoadingWorkspaceSymbols,
    handleWorkspaceSymbolSelect,
  } = useQuickOpen();

  if (!isVisible) {
    return null;
  }

  const hasResults =
    openBufferFiles.length > 0 || recentFilesInResults.length > 0 || otherFiles.length > 0;
  const totalResults = openBufferFiles.length + recentFilesInResults.length + otherFiles.length;
  const hasContentMatches = contentMatches.length > 0;
  const symbolSearchQuery = isSymbolMode || isWorkspaceSymbolMode ? query.slice(1).trim() : query;

  return (
    <Command isVisible={isVisible} onClose={onClose}>
      <CommandHeader onClose={onClose}>
        <CommandInput
          ref={inputRef}
          value={query}
          onChange={setQuery}
          onKeyDown={handleInputKeyDown}
          placeholder={
            isSymbolMode
              ? t("quickOpen.searchSymbols")
              : isWorkspaceSymbolMode
                ? t("quickOpen.searchWorkspaceSymbols")
                : t("quickOpen.searchFiles")
          }
          className="font-sans"
        />
        {isSymbolMode ? (
          <CommandHeaderBadge>
            {isLoadingSymbols
              ? "..."
              : t("quickOpen.symbolsCount", { count: symbols.length })}
          </CommandHeaderBadge>
        ) : isWorkspaceSymbolMode ? (
          <CommandHeaderBadge>
            {isLoadingWorkspaceSymbols
              ? "..."
              : t("quickOpen.symbolsCount", { count: workspaceSymbols.length })}
          </CommandHeaderBadge>
        ) : (
          <>
            <FileCountBadge
              totalFiles={files.length}
              resultCount={totalResults}
              hasQuery={!!debouncedQuery}
              isLoading={isLoadingFiles}
            />
            {hasContentMatches && (
              <CommandHeaderBadge>
                {t("quickOpen.contentMatchesCount", { count: contentMatches.length })}
              </CommandHeaderBadge>
            )}
          </>
        )}
      </CommandHeader>

      <CommandList ref={scrollContainerRef}>
        {isSymbolMode ? (
          symbols.length === 0 ? (
            <CommandEmpty>
              {isLoadingSymbols ? t("quickOpen.loadingSymbols") : t("quickOpen.noSymbols")}
            </CommandEmpty>
          ) : (
            symbols.map((symbol, index) => (
              <SymbolListItem
                key={`${symbol.name}:${symbol.line}`}
                symbol={symbol}
                index={index}
                isSelected={index === selectedIndex}
                onClick={handleSymbolSelect}
                onMouseEnter={(idx) => setSelectedIndex(idx)}
                searchQuery={symbolSearchQuery}
              />
            ))
          )
        ) : isWorkspaceSymbolMode ? (
          workspaceSymbols.length === 0 ? (
            <CommandEmpty>
              {isLoadingWorkspaceSymbols
                ? t("quickOpen.loadingSymbols")
                : t("quickOpen.noSymbols")}
            </CommandEmpty>
          ) : (
            workspaceSymbols.map((symbol, index) => (
              <SymbolListItem
                key={getWorkspaceSymbolKey(symbol)}
                symbol={symbol}
                index={index}
                isSelected={index === selectedIndex}
                onClick={handleWorkspaceSymbolSelect}
                onMouseEnter={(idx) => setSelectedIndex(idx)}
                searchQuery={symbolSearchQuery}
                showFilePath
              />
            ))
          )
        ) : !hasResults && !hasContentMatches ? (
          <EmptyState
            isLoadingFiles={isLoadingFiles}
            isIndexing={isIndexing}
            debouncedQuery={debouncedQuery}
            query={query}
            filesLength={files.length}
            hasRootFolder={!!rootFolderPath}
          />
        ) : (
          <>
            {openBufferFiles.length > 0 && (
              <div className="p-0">
                {openBufferFiles.map((file, index) => (
                  <FileListItem
                    key={`open-${file.path}`}
                    file={file}
                    category="open"
                    index={index}
                    isSelected={index === selectedIndex}
                    onClick={handleItemSelect}
                    onMouseEnter={handleItemHover}
                    rootFolderPath={rootFolderPath}
                    searchQuery={debouncedQuery}
                  />
                ))}
              </div>
            )}

            {recentFilesInResults.length > 0 && (
              <div className="p-0">
                {recentFilesInResults.map((file, index) => {
                  const globalIndex = openBufferFiles.length + index;
                  return (
                    <FileListItem
                      key={`recent-${file.path}`}
                      file={file}
                      category="recent"
                      index={globalIndex}
                      isSelected={globalIndex === selectedIndex}
                      onClick={handleItemSelect}
                      onMouseEnter={handleItemHover}
                      rootFolderPath={rootFolderPath}
                      searchQuery={debouncedQuery}
                    />
                  );
                })}
              </div>
            )}

            {otherFiles.length > 0 && (
              <div className="p-0">
                {otherFiles.map((file, index) => {
                  const globalIndex = openBufferFiles.length + recentFilesInResults.length + index;
                  return (
                    <FileListItem
                      key={`other-${file.path}`}
                      file={file}
                      category="other"
                      index={globalIndex}
                      isSelected={globalIndex === selectedIndex}
                      onClick={handleItemSelect}
                      onMouseEnter={handleItemHover}
                      rootFolderPath={rootFolderPath}
                      searchQuery={debouncedQuery}
                    />
                  );
                })}
              </div>
            )}

            {hasContentMatches && (
              <div className="p-0">
                {contentMatches.map((match, index) => {
                  // Content matches follow the filename results in navigation order.
                  const globalIndex = totalResults + index;
                  return (
                    <ContentMatchListItem
                      key={`content-${match.filePath}:${match.line}:${match.column}`}
                      match={match}
                      index={globalIndex}
                      isSelected={globalIndex === selectedIndex}
                      onClick={(selected) =>
                        openContentMatch(selected.filePath, selected.line, selected.column)
                      }
                      onMouseEnter={handleItemHover}
                      rootFolderPath={rootFolderPath}
                      searchQuery={debouncedQuery}
                    />
                  );
                })}
              </div>
            )}
          </>
        )}
      </CommandList>
    </Command>
  );
};

export default QuickOpen;
