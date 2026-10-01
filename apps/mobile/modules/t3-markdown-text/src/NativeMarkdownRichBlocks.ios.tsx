import { useContext } from "react";
import { Image, ScrollView, Text, View } from "react-native";
import type { MarkdownNode } from "react-native-nitro-markdown/headless";
import { nativeMarkdownDocumentRuns } from "./nativeMarkdownText";
import { NativeMarkdownSelectableText } from "./NativeMarkdownSelectableText.ios";
import type {
  NativeMarkdownTextStyle,
  SelectableMarkdownSkill,
} from "./SelectableMarkdownText.types";
import { documentFor, nodeKey } from "./nativeMarkdownNodes";
import { MarkdownImageRendererContext } from "./NativeMarkdownRenderContext";

export function SelectableNode(props: {
  readonly node: MarkdownNode;
  readonly skills: ReadonlyArray<SelectableMarkdownSkill>;
  readonly textStyle: NativeMarkdownTextStyle;
  readonly onLinkPress?: (href: string) => void;
}) {
  return (
    <NativeMarkdownSelectableText
      runs={nativeMarkdownDocumentRuns(documentFor(props.node), props.skills)}
      textStyle={props.textStyle}
      onLinkPress={props.onLinkPress}
    />
  );
}

function collectTableRows(node: MarkdownNode): MarkdownNode[] {
  const rows: MarkdownNode[] = [];
  const visit = (child: MarkdownNode) => {
    if (child.type === "table_row") {
      rows.push(child);
      return;
    }
    for (const nested of child.children ?? []) {
      visit(nested);
    }
  };
  visit(node);
  return rows;
}

export function NativeTable(props: {
  readonly node: MarkdownNode;
  readonly skills: ReadonlyArray<SelectableMarkdownSkill>;
  readonly textStyle: NativeMarkdownTextStyle;
  readonly onLinkPress?: (href: string) => void;
}) {
  const rows = collectTableRows(props.node);
  return (
    <ScrollView horizontal bounces={false} showsHorizontalScrollIndicator={false}>
      <View
        style={{
          borderColor: props.textStyle.dividerColor,
          borderCurve: "continuous",
          borderRadius: 8,
          borderWidth: 1,
          overflow: "hidden",
        }}
      >
        {rows.map((row, rowIndex) => (
          <View
            key={nodeKey(row, rowIndex)}
            style={{
              flexDirection: "row",
              backgroundColor: rowIndex === 0 ? props.textStyle.codeBackgroundColor : "transparent",
              borderTopColor: props.textStyle.dividerColor,
              borderTopWidth: rowIndex === 0 ? 0 : 1,
            }}
          >
            {(row.children ?? []).map((cell, cellIndex) => (
              <View
                key={nodeKey(cell, cellIndex)}
                style={{
                  width: 160,
                  borderLeftColor: props.textStyle.dividerColor,
                  borderLeftWidth: cellIndex === 0 ? 0 : 1,
                  paddingHorizontal: 10,
                  paddingVertical: 8,
                }}
              >
                <NativeMarkdownSelectableText
                  runs={nativeMarkdownDocumentRuns(documentFor(cell), props.skills).map((run) =>
                    rowIndex === 0 || cell.isHeader ? { ...run, bold: true } : run,
                  )}
                  textStyle={props.textStyle}
                  onLinkPress={props.onLinkPress}
                />
              </View>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

export function NativeMarkdownImage(props: {
  readonly node: MarkdownNode;
  readonly skills: ReadonlyArray<SelectableMarkdownSkill>;
  readonly textStyle: NativeMarkdownTextStyle;
  readonly onLinkPress?: (href: string) => void;
}) {
  const renderImage = useContext(MarkdownImageRendererContext);
  const href = props.node.href;
  if (!href) {
    return (
      <SelectableNode
        node={props.node}
        skills={props.skills}
        textStyle={props.textStyle}
        onLinkPress={props.onLinkPress}
      />
    );
  }

  if (renderImage) {
    const rendered = renderImage({
      href,
      alt: props.node.alt ?? null,
      title: props.node.title ?? null,
    });
    if (rendered != null) {
      return <>{rendered}</>;
    }
  }

  return (
    <View style={{ gap: 6 }}>
      <Image
        source={{ uri: href }}
        resizeMode="contain"
        accessibilityLabel={props.node.alt ?? props.node.title}
        style={{
          width: "100%",
          aspectRatio: 16 / 9,
          backgroundColor: props.textStyle.codeBackgroundColor,
          borderRadius: 10,
        }}
      />
      {props.node.alt ? (
        <Text
          selectable
          style={{
            color: props.textStyle.mutedColor,
            fontFamily: props.textStyle.fontFamily,
            fontSize: 12,
            lineHeight: 16,
          }}
        >
          {props.node.alt}
        </Text>
      ) : null}
    </View>
  );
}

function inlineGroups(nodes: ReadonlyArray<MarkdownNode>): MarkdownNode[] {
  const groups: MarkdownNode[] = [];
  let inline: MarkdownNode[] = [];
  const flush = () => {
    if (inline.length === 0) {
      return;
    }
    groups.push({ type: "paragraph", children: inline });
    inline = [];
  };

  for (const node of nodes) {
    if (node.type === "image") {
      flush();
      groups.push(node);
    } else {
      inline.push(node);
    }
  }
  flush();
  return groups;
}

export function NativeMixedParagraph(props: {
  readonly node: MarkdownNode;
  readonly skills: ReadonlyArray<SelectableMarkdownSkill>;
  readonly textStyle: NativeMarkdownTextStyle;
  readonly onLinkPress?: (href: string) => void;
}) {
  return (
    <View style={{ gap: 8 }}>
      {inlineGroups(props.node.children ?? []).map((child, index) =>
        child.type === "image" ? (
          <NativeMarkdownImage
            key={nodeKey(child, index)}
            node={child}
            skills={props.skills}
            textStyle={props.textStyle}
            onLinkPress={props.onLinkPress}
          />
        ) : (
          <SelectableNode
            key={nodeKey(child, index)}
            node={child}
            skills={props.skills}
            textStyle={props.textStyle}
            onLinkPress={props.onLinkPress}
          />
        ),
      )}
    </View>
  );
}
