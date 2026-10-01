import type { AssetResource } from "@akeru/contracts";
import { Data, Predicate } from "effect";
import { useMobileI18n } from "../../lib/i18n";
import type { EnvironmentId, ThreadId } from "@akeru/contracts";
import { SymbolView } from "../../components/AppSymbol";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  StyleSheet,
  View,
  type ViewStyle,
} from "react-native";
import { TouchableOpacity } from "react-native-gesture-handler";
import { useThemeColor } from "../../lib/useThemeColor";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { AppText as Text } from "../../components/AppText";
import { useAssetUrl, useAssetUrlState } from "../../state/assets";
import { MARKDOWN_IMAGE_MAX_WIDTH, resolveMarkdownImageDisplaySize } from "./markdownImageSize";

export function MessageAttachmentImage(props: {
  readonly environmentId: EnvironmentId;
  readonly attachmentId: string;
  readonly className: string;
  readonly onPressImage: (uri: string, headers?: Record<string, string>) => void;
}) {
  const uri = useAssetUrl(
    props.environmentId,
    assetResource.attachment({
      attachmentId: props.attachmentId,
    }),
  );

  if (uri === null) {
    return (
      <View className={`${props.className} items-center justify-center`}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <TouchableOpacity activeOpacity={0.7} onPress={() => props.onPressImage(uri)}>
      <Image source={{ uri }} className={props.className} resizeMode="cover" />
    </TouchableOpacity>
  );
}

export function MessageAttachmentFile(props: {
  readonly environmentId: EnvironmentId;
  readonly attachmentId: string;
  readonly name: string;
}) {
  const uri = useAssetUrl(
    props.environmentId,
    assetResource.attachment({
      attachmentId: props.attachmentId,
    }),
  );

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${props.name}`}
      className="flex-row items-center gap-2 rounded-[14px] bg-black/5 px-3 py-3 dark:bg-white/10"
      disabled={uri === null}
      onPress={() => {
        if (uri) void tryOpenExternalUrl(uri, "file-preview");
      }}
    >
      <SymbolView name="doc.text" size={20} tintColor="gray" />
      <Text className="min-w-0 flex-1" numberOfLines={1}>
        {props.name}
      </Text>
    </Pressable>
  );
}

export function ThreadMarkdownImageView(props: {
  readonly uri: string | null;
  readonly sourceKey: string;
  readonly unavailable: boolean;
  readonly alt: string | null;
  readonly onPressImage: (uri: string) => void;
}) {
  const { t } = useMobileI18n();
  const codeBackground = useThemeColor("--color-md-code-bg");
  const [availableWidth, setAvailableWidth] = useState(0);
  const [sourceSize, setSourceSize] = useState<{ width: number; height: number } | null>(null);
  const [failedUri, setFailedUri] = useState<string | null>(null);

  useEffect(() => {
    setSourceSize(null);
  }, [props.sourceKey]);

  useEffect(() => {
    setFailedUri(null);
  }, [props.uri]);

  const displaySize =
    sourceSize === null
      ? null
      : resolveMarkdownImageDisplaySize({
          sourceWidth: sourceSize.width,
          sourceHeight: sourceSize.height,
          availableWidth,
        });

  const failed = props.unavailable || (props.uri !== null && failedUri === props.uri);

  const placeholderWidth: ViewStyle["width"] =
    availableWidth > 0 ? Math.min(availableWidth, MARKDOWN_IMAGE_MAX_WIDTH) : "100%";

  const frameStyle: ViewStyle = displaySize ?? { width: placeholderWidth, aspectRatio: 16 / 9 };

  return (
    <View
      onLayout={(event) => setAvailableWidth(event.nativeEvent.layout.width)}
      style={{ alignSelf: "stretch", gap: 6 }}
    >
      {props.uri === null || failed ? (
        <View
          style={{
            ...frameStyle,
            borderRadius: 10,
            backgroundColor: codeBackground,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {failed ? (
            <Text className="text-xs text-foreground-muted">{t("Image unavailable")}</Text>
          ) : (
            <ActivityIndicator />
          )}
        </View>
      ) : (
        <TouchableOpacity
          accessibilityRole="imagebutton"
          accessibilityLabel={props.alt ?? "Markdown image"}
          activeOpacity={0.7}
          onPress={() => props.onPressImage(props.uri!)}
          style={{ alignSelf: "flex-start" }}
        >
          <View
            style={{
              ...frameStyle,
              borderRadius: 10,
              backgroundColor: codeBackground,
              alignItems: "center",
              justifyContent: "center",
              overflow: "hidden",
            }}
          >
            <ThreadMarkdownImageRequest
              key={props.uri}
              uri={props.uri}
              onLoad={setSourceSize}
              onError={() => setFailedUri(props.uri)}
            />
          </View>
        </TouchableOpacity>
      )}
      {props.alt ? (
        <Text selectable className="text-xs text-foreground-muted">
          {props.alt}
        </Text>
      ) : null}
    </View>
  );
}

function ThreadMarkdownImageRequest(props: {
  readonly uri: string;
  readonly onLoad: (sourceSize: { width: number; height: number }) => void;
  readonly onError: () => void;
}) {
  const { t } = useMobileI18n();
  const [loaded, setLoaded] = useState(false);

  return (
    <>
      <Image
        source={{ uri: props.uri }}
        resizeMode="contain"
        accessible={false}
        onLoad={(event) => {
          setLoaded(true);
          props.onLoad(event.nativeEvent.source);
        }}
        onError={props.onError}
        style={{ width: "100%", height: "100%", opacity: loaded ? 1 : 0 }}
      />
      {loaded ? null : (
        <View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center" }]}
        >
          <Text className="text-xs text-foreground-muted">{t("Loading image…")}</Text>
        </View>
      )}
    </>
  );
}

/** Markdown image whose src is a workspace file — loads through a signed asset URL. */
export function ThreadMarkdownImage(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly path: string;
  readonly alt: string | null;
  readonly onPressImage: (uri: string) => void;
}) {
  const assetUrl = useAssetUrlState(
    props.environmentId,
    assetResource["workspace-file"]({
      threadId: props.threadId,
      path: props.path,
    }),
  );

  return (
    <ThreadMarkdownImageView
      uri={Predicate.isTagged(assetUrl, "Success") ? assetUrl.url : null}
      sourceKey={props.path}
      unavailable={Predicate.isTagged(assetUrl, "Failure")}
      alt={props.alt}
      onPressImage={props.onPressImage}
    />
  );
}

export function ThreadMarkdownImageUnavailable(props: { readonly alt: string | null }) {
  return (
    <ThreadMarkdownImageView
      uri={null}
      sourceKey="unavailable"
      unavailable
      alt={props.alt}
      onPressImage={() => undefined}
    />
  );
}

const assetResource = Data.taggedEnum<AssetResource>();
