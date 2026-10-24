import { useTranslation } from "@/i18n/locale-provider";
import { ThemedFileIcon } from "@/extensions/icon-themes/components/themed-file-icon";
import { CommandItemBadge, CommandItemMeta, CommandItemRow } from "@/ui/command";
import { getDirectoryPath } from "@/utils/path-helpers";
import type { ContentMatch } from "../types/quick-open.types";
import { SearchMatchHighlight } from "./search-match-highlight";

interface ContentMatchListItemProps {
  match: ContentMatch;
  index: number;
  isSelected: boolean;
  onClick: (match: ContentMatch) => void;
  onMouseEnter?: (index: number) => void;
  rootFolderPath: string | null | undefined;
  searchQuery: string;
}

export const ContentMatchListItem = ({
  match,
  index,
  isSelected,
  onClick,
  onMouseEnter,
  rootFolderPath,
  searchQuery,
}: ContentMatchListItemProps) => {
  const { t } = useTranslation();
  const directoryPath = getDirectoryPath(match.filePath, rootFolderPath);

  return (
    <CommandItemRow
      data-item-index={index}
      onClick={() => onClick(match)}
      onMouseEnter={() => onMouseEnter?.(index)}
      isSelected={isSelected}
      icon={<ThemedFileIcon fileName={match.name} isDir={false} />}
      title={<SearchMatchHighlight text={match.name} query={searchQuery} />}
      description={
        <span className="flex min-w-0 items-center gap-1.5">
          <CommandItemBadge>{t("quickOpen.matchLine", { line: match.line })}</CommandItemBadge>
          <SearchMatchHighlight text={match.preview} query={searchQuery} />
        </span>
      }
      accessory={<CommandItemMeta>{directoryPath}</CommandItemMeta>}
    />
  );
};
