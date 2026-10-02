import { Text, View } from "react-native";
import type { MarkdownNode } from "react-native-nitro-markdown/headless";
import { nativeMarkdownListItemBlocks } from "./nativeMarkdownText";
import type {
  MarkdownCodeHighlighter,
  NativeMarkdownTextStyle,
  SelectableMarkdownSkill,
} from "./SelectableMarkdownText.types";
import { nodeKey } from "./nativeMarkdownNodes";
import { NativeCodeBlock } from "./NativeMarkdownCodeBlock.ios";
import {
  NativeMarkdownImage,
  NativeMixedParagraph,
  NativeTable,
  SelectableNode,
} from "./NativeMarkdownRichBlocks.ios";

export { MarkdownImageRendererContext } from "./NativeMarkdownRenderContext";

function NativeList(props: {
  readonly node: MarkdownNode;
  readonly skills: ReadonlyArray<SelectableMarkdownSkill>;
  readonly textStyle: NativeMarkdownTextStyle;
  readonly highlightCode: MarkdownCodeHighlighter;
  readonly onLinkPress?: (href: string) => void;
  readonly depth: number;
}) {
  const ordered = props.node.ordered ?? false;
  const start = props.node.start ?? 1;
  const nested = props.depth > 0;

  return (
    <View
      style={{
        gap: nested ? 3 : 5,
      }}
    >
      {(props.node.children ?? []).map((item, index) => {
        const taskMarker = item.type === "task_list_item";

        const marker = taskMarker
          ? item.checked
            ? "☑︎"
            : "☐︎"
          : ordered
            ? `${start + index}.`
            : props.depth % 3 === 1
              ? "◦"
              : props.depth % 3 === 2
                ? "▪︎"
                : "•";

        const markerWidth = ordered ? 28 : taskMarker ? 20 : 18;
        const markerOffset = taskMarker ? 3 : ordered ? 0 : 2;

        return (
          <View
            key={nodeKey(item, index)}
            style={{ alignItems: "flex-start", flexDirection: "row" }}
          >
            <View
              style={{
                width: markerWidth,
                height: props.textStyle.lineHeight,
                marginRight: 6,
                alignItems: ordered ? "flex-end" : "center",
                justifyContent: "flex-start",
              }}
            >
              <Text
                style={{
                  color: props.textStyle.color,
                  fontFamily: props.textStyle.fontFamily,
                  fontSize: taskMarker ? 14 : props.textStyle.fontSize,
                  lineHeight: props.textStyle.lineHeight,
                  fontVariant: ordered ? ["tabular-nums"] : undefined,
                  transform: [{ translateY: markerOffset }],
                }}
              >
                {marker}
              </Text>
            </View>
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              {nativeMarkdownListItemBlocks(item).map((child, childIndex) => (
                <NativeMarkdownBlock
                  key={nodeKey(child, childIndex)}
                  node={child}
                  skills={props.skills}
                  textStyle={props.textStyle}
                  highlightCode={props.highlightCode}
                  onLinkPress={props.onLinkPress}
                  depth={props.depth + 1}
                  compact
                />
              ))}
            </View>
          </View>
        );
      })}
    </View>
  );
}

export function NativeMarkdownBlock(props: {
  readonly node: MarkdownNode;
  readonly skills: ReadonlyArray<SelectableMarkdownSkill>;
  readonly textStyle: NativeMarkdownTextStyle;
  readonly highlightCode: MarkdownCodeHighlighter;
  readonly onLinkPress?: (href: string) => void;
  readonly depth?: number;
  readonly compact?: boolean;
}) {
  const depth = props.depth ?? 0;

  switch (props.node.type) {
    case "document":
      return (
        <View style={{ gap: 8 }}>
          {(props.node.children ?? []).map((child, index) => (
            <NativeMarkdownBlock
              key={nodeKey(child, index)}
              node={child}
              skills={props.skills}
              textStyle={props.textStyle}
              highlightCode={props.highlightCode}
              onLinkPress={props.onLinkPress}
              depth={depth}
            />
          ))}
        </View>
      );
    case "code_block":
      return (
        <NativeCodeBlock
          node={props.node}
          textStyle={props.textStyle}
          highlightCode={props.highlightCode}
          compact={props.compact}
        />
      );
    case "table":
      return (
        <NativeTable
          node={props.node}
          skills={props.skills}
          textStyle={props.textStyle}
          onLinkPress={props.onLinkPress}
        />
      );
    case "image":
      return (
        <NativeMarkdownImage
          node={props.node}
          skills={props.skills}
          textStyle={props.textStyle}
          onLinkPress={props.onLinkPress}
        />
      );
    case "horizontal_rule":
      return (
        <View
          style={{
            height: 1,
            backgroundColor: props.textStyle.dividerColor,
          }}
        />
      );
    case "blockquote":
      return (
        <View
          style={{
            borderLeftColor: props.textStyle.quoteMarkerColor,
            borderLeftWidth: 2,
            marginVertical: props.compact ? 4 : 0,
            paddingLeft: 11,
            paddingVertical: 2,
            gap: 6,
          }}
        >
          {(props.node.children ?? []).map((child, index) => (
            <NativeMarkdownBlock
              key={nodeKey(child, index)}
              node={child}
              skills={props.skills}
              textStyle={props.textStyle}
              highlightCode={props.highlightCode}
              onLinkPress={props.onLinkPress}
              depth={depth}
              compact
            />
          ))}
        </View>
      );
    case "list":
      return (
        <NativeList
          node={props.node}
          skills={props.skills}
          textStyle={props.textStyle}
          highlightCode={props.highlightCode}
          onLinkPress={props.onLinkPress}
          depth={depth}
        />
      );
    case "paragraph":
      return (props.node.children ?? []).some((child) => child.type === "image") ? (
        <NativeMixedParagraph
          node={props.node}
          skills={props.skills}
          textStyle={props.textStyle}
          onLinkPress={props.onLinkPress}
        />
      ) : (
        <SelectableNode
          node={props.node}
          skills={props.skills}
          textStyle={props.textStyle}
          onLinkPress={props.onLinkPress}
        />
      );
    case "html_block":
    case "math_block":
      return (
        <View
          style={{
            marginVertical: props.compact ? 2 : 0,
            paddingHorizontal: props.node.type === "math_block" ? 10 : 0,
            paddingVertical: props.node.type === "math_block" ? 8 : 0,
            backgroundColor:
              props.node.type === "math_block"
                ? props.textStyle.codeBackgroundColor
                : "transparent",
          }}
        >
          <SelectableNode
            node={props.node}
            skills={props.skills}
            textStyle={props.textStyle}
            onLinkPress={props.onLinkPress}
          />
        </View>
      );
    case "table_head":
    case "table_body":
    case "table_row":
    case "table_cell":
    case "list_item":
    case "task_list_item":
      return (
        <View style={{ gap: 4 }}>
          {(props.node.children ?? []).map((child, index) => (
            <NativeMarkdownBlock
              key={nodeKey(child, index)}
              node={child}
              skills={props.skills}
              textStyle={props.textStyle}
              highlightCode={props.highlightCode}
              onLinkPress={props.onLinkPress}
              depth={depth}
              compact
            />
          ))}
        </View>
      );
    default:
      return (
        <SelectableNode
          node={props.node}
          skills={props.skills}
          textStyle={props.textStyle}
          onLinkPress={props.onLinkPress}
        />
      );
  }
}
