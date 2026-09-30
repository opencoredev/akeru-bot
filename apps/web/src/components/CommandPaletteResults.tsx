import { type ResolvedKeybindingsConfig } from "@akeru/contracts";
import { shortcutLabelForCommand } from "../keybindings";
import { type CommandPaletteActionItem, type CommandPaletteGroup } from "./CommandPalette.logic";
import {
  CommandCollection,
  CommandGroup,
  CommandGroupLabel,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "./ui/command";
import { cn } from "~/lib/utils";

interface CommandPaletteResultsProps {
  groups: ReadonlyArray<CommandPaletteGroup>;
  highlightedItemValue?: string | null;
  keybindings: ResolvedKeybindingsConfig;
  onExecuteItem: (item: CommandPaletteActionItem) => void;
  /** Replaces the no-results line, such as while chat search is still running. */
  emptyStateMessage?: string;
}

export function CommandPaletteResults(props: CommandPaletteResultsProps) {
  if (props.groups.length === 0) {
    return (
      <div className="py-10 text-center text-sm text-muted-foreground">
        {props.emptyStateMessage ?? "No matching commands."}
      </div>
    );
  }

  return (
    <CommandList>
      {props.groups.map((group) => (
        <CommandGroup items={group.items} key={group.value}>
          <CommandGroupLabel className="ps-[9px]">{group.label}</CommandGroupLabel>
          <CommandCollection>
            {(item: CommandPaletteActionItem) =>
              item.disabled ? (
                <div
                  className="flex min-h-8 select-none items-center gap-2 rounded-sm px-2 py-1.5 text-base opacity-64 sm:min-h-7 sm:text-sm"
                  key={item.value}
                >
                  <CommandPaletteItemLabel item={item} />
                </div>
              ) : (
                <CommandPaletteResultRow
                  item={item}
                  key={item.value}
                  keybindings={props.keybindings}
                  isActive={props.highlightedItemValue === item.value}
                  onExecuteItem={props.onExecuteItem}
                />
              )
            }
          </CommandCollection>
        </CommandGroup>
      ))}
    </CommandList>
  );
}

function CommandPaletteItemLabel(props: { item: CommandPaletteActionItem }) {
  return (
    <>
      {props.item.icon}
      {props.item.description ? (
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm text-foreground">{props.item.title}</span>
          <span className="min-w-0 text-muted-foreground/70 text-xs">{props.item.description}</span>
        </span>
      ) : (
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">{props.item.title}</span>
      )}
    </>
  );
}

function CommandPaletteResultRow(props: {
  item: CommandPaletteActionItem;
  isActive: boolean;
  keybindings: ResolvedKeybindingsConfig;
  onExecuteItem: (item: CommandPaletteActionItem) => void;
}) {
  const shortcutLabel = props.item.shortcutCommand
    ? shortcutLabelForCommand(props.keybindings, props.item.shortcutCommand)
    : null;

  return (
    <CommandItem
      value={props.item.value}
      className={cn(
        "cursor-pointer gap-2 hover:bg-transparent hover:text-inherit data-highlighted:bg-transparent data-highlighted:text-inherit data-selected:bg-transparent data-selected:text-inherit [&[data-highlighted][data-selected]]:bg-transparent [&[data-highlighted][data-selected]]:text-inherit",
        props.isActive && "bg-accent! text-accent-foreground!",
      )}
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={() => {
        props.onExecuteItem(props.item);
      }}
    >
      <CommandPaletteItemLabel item={props.item} />
      {shortcutLabel ? <CommandShortcut>{shortcutLabel}</CommandShortcut> : null}
    </CommandItem>
  );
}
