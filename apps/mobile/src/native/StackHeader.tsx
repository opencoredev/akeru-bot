import { Predicate } from "effect";
import { useNavigation, type ParamListBase } from "@react-navigation/native";
import type {
  NativeStackHeaderItem,
  NativeStackHeaderItemMenu,
  NativeStackNavigationOptions,
  NativeStackNavigationProp,
} from "@react-navigation/native-stack";
import {
  Children,
  isValidElement,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactElement,
  type ReactNode,
} from "react";
import type { ColorValue } from "react-native";

export {
  nativeHeaderScrollEdgeEffects,
  nativeTopScrollEdgeEffect,
  type NativeHeaderScrollEdgeEffects,
  type NativeTopScrollEdgeEffect,
} from "./scrollEdgeEffects";

export type AppNativeStackNavigationOptions = Omit<
  NativeStackNavigationOptions,
  "headerTintColor" | "unstable_headerLeftItems" | "unstable_headerRightItems"
> & {
  readonly headerTintColor?: string | ColorValue;
  readonly unstable_headerCenterItems?: unknown;
  readonly unstable_headerLeftItems?: unknown;
  readonly unstable_headerRightItems?: unknown;
  readonly unstable_headerSubtitle?: unknown;
  readonly unstable_headerToolbarItems?: unknown;
  readonly unstable_navigationItemStyle?: unknown;
};

function useNativeStackNavigation(): NativeStackNavigationProp<ParamListBase> | null {
  return useNavigation<NativeStackNavigationProp<ParamListBase>>();
}

function normalizeScreenOptions(
  options: AppNativeStackNavigationOptions | undefined,
): NativeStackNavigationOptions | undefined {
  if (!options) {
    return options;
  }

  const { headerTintColor, ...rest } = options;

  // SAFETY: App-only experimental items are implemented by the native-stack patch bundled with this app.
  return {
    ...rest,
    ...(headerTintColor === undefined ? {} : { headerTintColor: String(headerTintColor) }),
  } as NativeStackNavigationOptions;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Serializes heterogeneous navigation options, including refs and callbacks, without imposing a JSON contract.
function optionsSignature(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null) return "null";

  if (Predicate.isBoolean(value) || Predicate.isNumber(value) || Predicate.isString(value))
    return JSON.stringify(value);

  if (Predicate.isUndefined(value)) return "undefined";

  if (Predicate.isFunction(value)) return `function:${Function.prototype.toString.call(value)}`;

  if (Predicate.isSymbol(value)) return `symbol:${String(value)}`;

  if (Predicate.isBigInt(value)) return `bigint:${String(value)}`;

  if (Predicate.isObjectOrArray(value)) {
    if (seen.has(value)) return "[circular]";
    seen.add(value);

    if (Array.isArray(value))
      return `[${value.map((entry) => optionsSignature(entry, seen)).join(",")}]`;

    if ("current" in value) return "[ref]";

    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${optionsSignature(entry, seen)}`)
      .join(",")}}`;
  }

  return String(value);
}

// oxlint-disable-next-line anti-slop/no-unknown-returns -- Header factories have different arguments and results; the wrapper forwards each invocation unchanged.
type OptionFunction = (...args: ReadonlyArray<unknown>) => unknown;

function stabilizeOptionFunctions<T>(
  value: T,
  path: string,
  latestFunctions: Map<string, OptionFunction>,
  wrappers: Map<string, OptionFunction>,
  seen = new WeakSet<object>(),
): T {
  if (Predicate.isFunction(value)) {
    // SAFETY: The runtime function check allows forwarding arbitrary header factory arguments.
    latestFunctions.set(path, value as OptionFunction);
    let wrapper = wrappers.get(path);

    if (!wrapper) {
      wrapper = (...args: unknown[]) => {
        return latestFunctions.get(path)?.(...args);
      };

      wrappers.set(path, wrapper);
    }

    // SAFETY: The wrapper forwards the original factory arguments and result, preserving its type.
    return wrapper as T;
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) return value;
    seen.add(value);

    // SAFETY: Recursion preserves every array entry and only substitutes equivalent function wrappers.
    return value.map((entry, index) =>
      stabilizeOptionFunctions(entry, `${path}[${index}]`, latestFunctions, wrappers, seen),
    ) as T;
  }

  if (value !== null && Predicate.isObjectOrArray(value)) {
    if (seen.has(value) || "current" in value) return value;
    seen.add(value);

    // SAFETY: Every own enumerable option is copied with its type-preserving stabilized value.
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        stabilizeOptionFunctions(entry, `${path}.${key}`, latestFunctions, wrappers, seen),
      ]),
    ) as T;
  }

  return value;
}

export function NativeStackScreenOptions(props: {
  readonly options?: AppNativeStackNavigationOptions;
  /**
   * Causes dynamic native header factories to be reapplied when their closed-over
   * menu content changes. Factory functions are intentionally stabilized, so
   * their source alone cannot capture a menu that was initially empty while
   * asynchronous data was loading.
   */
  readonly optionsVersion?: unknown;
  readonly listeners?: Record<string, (event: never) => void>;
  readonly name?: string;
}) {
  const navigation = useNativeStackNavigation();
  const lastAppliedOptionsSignatureRef = useRef<string | undefined>(undefined);
  const latestOptionFunctionsRef = useRef(new Map<string, OptionFunction>());
  const optionFunctionWrappersRef = useRef(new Map<string, OptionFunction>());
  const normalizedOptions = useMemo(() => normalizeScreenOptions(props.options), [props.options]);

  // Keyed on the options identity: callers that memoize their options skip the
  // deep copy and the signature walk below on unrelated re-renders.
  const stableOptions = useMemo(
    () =>
      normalizedOptions
        ? stabilizeOptionFunctions(
            normalizedOptions,
            "options",
            latestOptionFunctionsRef.current,
            optionFunctionWrappersRef.current,
          )
        : undefined,
    [normalizedOptions],
  );

  useLayoutEffect(() => {
    if (!navigation || !stableOptions) {
      return;
    }

    const signature = optionsSignature([stableOptions, props.optionsVersion]);

    // Avoid re-entering navigation state when semantically equal options are
    // reapplied every layout (common when callers pass unstable object literals).
    if (lastAppliedOptionsSignatureRef.current === signature) {
      return;
    }

    lastAppliedOptionsSignatureRef.current = signature;
    navigation.setOptions(stableOptions);
  }, [navigation, props.optionsVersion, stableOptions]);

  useEffect(() => {
    if (!navigation || !props.listeners) {
      return;
    }

    // SAFETY: Listener names include native-stack patch events omitted from the upstream event map.
    const subscriptions = Object.entries(props.listeners).map(([eventName, listener]) =>
      navigation.addListener(eventName as never, listener as never),
    );

    return () => {
      for (const unsubscribe of subscriptions) {
        unsubscribe();
      }
    };
  }, [navigation, props.listeners]);

  return null;
}

function labelFromChildren(children: ReactNode): string {
  const parts: string[] = [];
  Children.forEach(children, (child) => {
    if (Predicate.isString(child) || Predicate.isNumber(child)) {
      parts.push(String(child));
    } else if (isValidElement<{ children?: ReactNode }>(child)) {
      parts.push(labelFromChildren(child.props.children));
    }
  });

  return parts.join("");
}

type NativeStackHeaderIcon = NonNullable<
  Extract<NativeStackHeaderItem, { type: "button" }>["icon"]
>;

type NativeStackOptionsWithToolbar = NativeStackNavigationOptions & {
  unstable_headerToolbarItems?: () => NativeStackHeaderItem[];
};

function iconFromProp(icon: string | undefined): NativeStackHeaderIcon | undefined {
  if (!Predicate.isString(icon)) {
    return undefined;
  }

  // SAFETY: Toolbar icons are app-owned SF Symbol names; the native bridge accepts the platform symbol string.
  return { type: "sfSymbol", name: icon as never };
}

type ToolbarElementProps = {
  readonly children?: ReactNode;
  readonly subtitle?: string;
  readonly disabled?: boolean;
  readonly icon?: string;
  readonly onPress?: () => void;
  readonly isOn?: boolean;
  readonly destructive?: boolean;
  readonly discoverabilityLabel?: string;
  readonly title?: string;
  readonly label?: string;
  readonly accessibilityLabel?: string;
  readonly separateBackground?: boolean;
  readonly tintColor?: ColorValue;
  readonly width?: number;
  readonly flexible?: boolean;
  readonly inline?: boolean;
};

function elementTypeName(element: ReactElement): string | undefined {
  const type = element.type;

  if (Predicate.isFunction(type)) {
    return "displayName" in type && Predicate.isString(type.displayName)
      ? type.displayName
      : type.name;
  }

  return undefined;
}

function convertMenuAction(
  element: ReactElement<ToolbarElementProps>,
): NativeStackHeaderItemMenu["menu"]["items"][number] | null {
  const typeName = elementTypeName(element);

  if (typeName === "NativeHeaderToolbarMenuAction") {
    const label = labelFromChildren(element.props.children);

    return {
      type: "action",
      label,
      description: Predicate.isString(element.props.subtitle) ? element.props.subtitle : undefined,
      disabled: Boolean(element.props.disabled),
      icon: iconFromProp(element.props.icon),
      onPress: Predicate.isFunction(element.props.onPress)
        ? element.props.onPress
        : () => undefined,
      state: element.props.isOn === true ? "on" : undefined,
      destructive: Boolean(element.props.destructive),
      discoverabilityLabel: Predicate.isString(element.props.discoverabilityLabel)
        ? element.props.discoverabilityLabel
        : undefined,
    };
  }

  if (typeName === "NativeHeaderToolbarMenu") {
    return {
      type: "submenu",
      label: Predicate.isString(element.props.title)
        ? element.props.title
        : labelFromChildren(element.props.children),
      icon: iconFromProp(element.props.icon),
      inline: Boolean(element.props.inline),
      items: collectMenuItems(element.props.children),
    };
  }

  return null;
}

function collectMenuItems(children: ReactNode): NativeStackHeaderItemMenu["menu"]["items"] {
  const items: NativeStackHeaderItemMenu["menu"]["items"] = [];
  Children.forEach(children, (child) => {
    if (!isValidElement<ToolbarElementProps>(child)) {
      return;
    }

    const item = convertMenuAction(child);

    if (item) {
      items.push(item);

      return;
    }

    items.push(...collectMenuItems(child.props.children));
  });

  return items;
}

type ToolbarHeaderItem = NativeStackHeaderItem & { flexible?: boolean; index?: number };

function convertToolbarChild(child: ReactNode): ToolbarHeaderItem | null {
  if (!isValidElement<ToolbarElementProps>(child)) {
    return null;
  }

  const typeName = elementTypeName(child);

  if (typeName === "NativeHeaderToolbarButton") {
    return {
      type: "button",
      label: Predicate.isString(child.props.label) ? child.props.label : "",
      accessibilityLabel: Predicate.isString(child.props.accessibilityLabel)
        ? child.props.accessibilityLabel
        : undefined,
      disabled: Boolean(child.props.disabled),
      icon: iconFromProp(child.props.icon),
      onPress: Predicate.isFunction(child.props.onPress) ? child.props.onPress : () => undefined,
      sharesBackground: !child.props.separateBackground,
      tintColor: child.props.tintColor,
      variant: "plain",
    };
  }

  if (typeName === "NativeHeaderToolbarMenu") {
    return {
      type: "menu",
      label: Predicate.isString(child.props.title) ? child.props.title : "",
      accessibilityLabel: Predicate.isString(child.props.accessibilityLabel)
        ? child.props.accessibilityLabel
        : undefined,
      disabled: Boolean(child.props.disabled),
      icon: iconFromProp(child.props.icon),
      menu: {
        title: Predicate.isString(child.props.title) ? child.props.title : undefined,
        items: collectMenuItems(child.props.children),
      },
      sharesBackground: !child.props.separateBackground,
      tintColor: child.props.tintColor,
      variant: "plain",
    };
  }

  if (typeName === "NativeHeaderToolbarSpacer") {
    return {
      type: "spacing",
      spacing: Predicate.isNumber(child.props.width) ? child.props.width : 8,
      flexible: Boolean(child.props.flexible),
    };
  }

  return null;
}

function collectToolbarItems(children: ReactNode): NativeStackHeaderItem[] {
  const items: NativeStackHeaderItem[] = [];
  Children.forEach(children, (child) => {
    const item = convertToolbarChild(child);

    if (item) {
      if (item.type === "spacing") {
        // Native inserts spacing items at `index`, treating a missing index
        // as 0 — which would move the spacer in front of earlier siblings.
        item.index = items.length;
      }

      items.push(item);
    }
  });

  return items;
}

function NativeHeaderToolbarRoot(props: {
  readonly placement?: "left" | "right" | "bottom";
  readonly children?: ReactNode;
}) {
  const navigation = useNativeStackNavigation();
  const items = useMemo(() => collectToolbarItems(props.children), [props.children]);

  // Swap toolbar owners before paint so split and compact headers cannot clear each other.
  useLayoutEffect(() => {
    if (!navigation) {
      return;
    }

    if (props.placement === "bottom") {
      const options: NativeStackOptionsWithToolbar = { unstable_headerToolbarItems: () => items };
      navigation.setOptions(options);

      return () => {
        const options: NativeStackOptionsWithToolbar = { unstable_headerToolbarItems: () => [] };
        navigation.setOptions(options);
      };
    }

    if (props.placement === "left") {
      navigation.setOptions({ unstable_headerLeftItems: () => items });

      return () => {
        navigation.setOptions({ unstable_headerLeftItems: () => [] });
      };
    }

    navigation.setOptions({ unstable_headerRightItems: () => items });

    return () => {
      navigation.setOptions({ unstable_headerRightItems: () => [] });
    };
  }, [items, navigation, props.placement]);

  return null;
}

function NativeHeaderToolbarButton(_props: {
  readonly accessibilityLabel?: string;
  readonly disabled?: boolean;
  readonly icon?: string;
  readonly label?: string;
  readonly onPress?: () => void;
  readonly separateBackground?: boolean;
  readonly tintColor?: ColorValue;
}) {
  return null;
}

NativeHeaderToolbarButton.displayName = "NativeHeaderToolbarButton";

function NativeHeaderToolbarMenu(_props: {
  readonly accessibilityLabel?: string;
  readonly children?: ReactNode;
  readonly disabled?: boolean;
  readonly icon?: string;
  readonly inline?: boolean;
  readonly separateBackground?: boolean;
  readonly tintColor?: ColorValue;
  readonly title?: string;
}) {
  return null;
}

NativeHeaderToolbarMenu.displayName = "NativeHeaderToolbarMenu";

function NativeHeaderToolbarMenuAction(_props: {
  readonly children?: ReactNode;
  readonly destructive?: boolean;
  readonly disabled?: boolean;
  readonly discoverabilityLabel?: string;
  readonly icon?: string;
  readonly isOn?: boolean;
  readonly onPress?: () => void;
  readonly subtitle?: string;
}) {
  return null;
}

NativeHeaderToolbarMenuAction.displayName = "NativeHeaderToolbarMenuAction";

function NativeHeaderToolbarLabel(_props: { readonly children?: ReactNode }) {
  return null;
}

NativeHeaderToolbarLabel.displayName = "NativeHeaderToolbarLabel";

function NativeHeaderToolbarSpacer(_props: {
  readonly flexible?: boolean;
  readonly sharesBackground?: boolean;
  readonly width?: number;
}) {
  return null;
}

NativeHeaderToolbarSpacer.displayName = "NativeHeaderToolbarSpacer";

function NativeHeaderToolbarSearchBarSlot() {
  return null;
}

NativeHeaderToolbarSearchBarSlot.displayName = "NativeHeaderToolbarSearchBarSlot";

export const NativeHeaderToolbar = Object.assign(NativeHeaderToolbarRoot, {
  Button: NativeHeaderToolbarButton,
  Label: NativeHeaderToolbarLabel,
  Menu: Object.assign(NativeHeaderToolbarMenu, {
    Action: NativeHeaderToolbarMenuAction,
  }),
  MenuAction: NativeHeaderToolbarMenuAction,
  SearchBarSlot: NativeHeaderToolbarSearchBarSlot,
  Spacer: NativeHeaderToolbarSpacer,
});
