import { Schema } from "effect";
import { TrimmedNonEmptyString } from "../baseSchemas.ts";
import {
  PREVIEW_VIEWPORT_MAX_AREA,
  PreviewRenderedViewportSize,
  PreviewTabId,
  PreviewViewportPresetId,
  PreviewViewportSetting,
  PreviewViewportSize,
} from "../preview.ts";
import {
  BoundedUrl,
  URL_GUIDANCE,
  OptionalTimeoutMs,
  PreviewAutomationTabTargetFields,
  BrowserNavigationTarget,
  PreviewAutomationColorScheme,
} from "./targets.ts";

export const PreviewAutomationOpenInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  url: Schema.optional(BoundedUrl).annotate({
    description: `Optional initial page URL. ${URL_GUIDANCE} Omit to open a blank tab.`,
  }),
  open: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Whether to open the thread-bound inline preview for the human. Defaults to true; set false for background-only automation.",
    }),
  ),
  show: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Deprecated alias for open. Whether to reveal the thread-bound inline preview to the human.",
    }),
  ),
  reuseExistingTab: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Reuse tabId when supplied, otherwise this agent session's current tab. Defaults to true; set false to create a new tab.",
    }),
  ),
})
  .check(
    Schema.makeFilter(
      (input) =>
        !(input.tabId !== undefined && input.reuseExistingTab === false) ||
        "tabId cannot be combined with reuseExistingTab=false.",
    ),
  )
  .annotate({
    description:
      "Opens the collaborative browser for the current thread. Use preview_navigate afterward when readiness waiting matters.",
  });

export type PreviewAutomationOpenInput = typeof PreviewAutomationOpenInput.Type;

export const PreviewAutomationNavigateInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  url: Schema.optional(BoundedUrl).annotate({
    description: `Website URL. ${URL_GUIDANCE} Use this for public pages and directly reachable URLs.`,
  }),
  target: Schema.optional(
    BrowserNavigationTarget.annotate({
      description:
        "Environment-relative target. Prefer {kind:'environment-port',port:5173} for a dev server in the current environment.",
    }),
  ).annotate({
    description:
      "Environment-relative target. Prefer {kind:'environment-port',port:5173} for a dev server in the current environment.",
  }),
  readiness: Schema.optional(
    Schema.Literals(["load", "domContentLoaded", "none"]).annotate({
      description:
        "Readiness milestone before returning. 'load' waits for loading to stop (default), 'domContentLoaded' waits for an interactive document, and 'none' returns immediately.",
    }),
  ).annotate({
    description:
      "Readiness milestone before returning. 'load' is the default; use 'none' only when a later wait call will verify the page.",
  }),
  timeoutMs: OptionalTimeoutMs,
})
  .check(
    Schema.makeFilter(
      (input) =>
        Number(input.url !== undefined) + Number(input.target !== undefined) === 1 ||
        "Provide exactly one of url or target.",
    ),
  )
  .annotate({
    description:
      "Navigates the active browser tab. Provide exactly one of url or target; for most public pages use url.",
  });

export type PreviewAutomationNavigateInput = typeof PreviewAutomationNavigateInput.Type;

export const PreviewAutomationResizeInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  mode: Schema.Literals(["fill", "freeform", "preset"]).annotate({
    description:
      "Viewport mode: fill follows the preview panel, freeform uses exact independently resizable dimensions, and preset uses a named device size.",
  }),
  preset: Schema.optional(
    PreviewViewportPresetId.annotate({
      description: "Named viewport from Chrome DevTools' standard device catalog.",
    }),
  ).annotate({
    description: "Named device size. Required only when mode is preset.",
  }),
  width: Schema.optional(
    PreviewViewportSize.fields.width.annotate({
      description: "Freeform viewport width in CSS pixels. Required only in freeform mode.",
    }),
  ).annotate({
    description: "Freeform viewport width in CSS pixels. Required only in freeform mode.",
  }),
  height: Schema.optional(
    PreviewViewportSize.fields.height.annotate({
      description: "Freeform viewport height in CSS pixels. Required only in freeform mode.",
    }),
  ).annotate({
    description: "Freeform viewport height in CSS pixels. Required only in freeform mode.",
  }),
  orientation: Schema.optional(
    Schema.Literals(["portrait", "landscape"]).annotate({
      description:
        "Orientation for a fixed device preset. Defaults to the preset's native orientation.",
    }),
  ).annotate({
    description:
      "Orientation for a named device preset. It is not accepted in fill or freeform mode.",
  }),
  timeoutMs: OptionalTimeoutMs,
})
  .check(
    Schema.makeFilter((input) => {
      const hasPreset = input.preset !== undefined;
      const hasWidth = input.width !== undefined;
      const hasHeight = input.height !== undefined;
      if (hasWidth !== hasHeight) return "Custom dimensions require both width and height.";
      if (input.mode === "fill") {
        return !hasPreset && !hasWidth && input.orientation === undefined
          ? true
          : "Fill mode does not accept a preset, dimensions, or orientation.";
      }
      if (input.mode === "freeform") {
        if (!hasWidth || !hasHeight || hasPreset || input.orientation !== undefined) {
          return "Freeform mode requires width and height and does not accept a preset or orientation.";
        }
      } else if (!hasPreset || hasWidth || hasHeight) {
        return "Preset mode requires a preset and does not accept custom dimensions.";
      }
      if (hasWidth && hasHeight && input.width! * input.height! > PREVIEW_VIEWPORT_MAX_AREA) {
        return `Custom viewport area must not exceed ${PREVIEW_VIEWPORT_MAX_AREA} pixels.`;
      }
      return true;
    }),
  )
  .annotate({
    description:
      "Sets the active browser tab to fill-panel, independently resizable freeform, or named device-preset sizing.",
  });

export type PreviewAutomationResizeInput = typeof PreviewAutomationResizeInput.Type;

export const PreviewAutomationResizeResult = Schema.Struct({
  tabId: PreviewTabId,
  setting: PreviewViewportSetting,
  viewport: PreviewRenderedViewportSize,
});

export type PreviewAutomationResizeResult = typeof PreviewAutomationResizeResult.Type;

export const PreviewAutomationSetColorSchemeInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  colorScheme: PreviewAutomationColorScheme.annotate({
    description:
      "Emulated prefers-color-scheme for the page: light, dark, or system to follow the OS appearance.",
  }),
}).annotate({
  description:
    "Emulates prefers-color-scheme in the active browser tab without changing the OS or app theme.",
});

export type PreviewAutomationSetColorSchemeInput = typeof PreviewAutomationSetColorSchemeInput.Type;

export const PreviewAutomationSetColorSchemeResult = Schema.Struct({
  tabId: PreviewTabId,
  colorScheme: PreviewAutomationColorScheme,
});

export type PreviewAutomationSetColorSchemeResult =
  typeof PreviewAutomationSetColorSchemeResult.Type;

const Locator = TrimmedNonEmptyString.annotate({
  description:
    "Playwright selector, preferably role/text based, for example role=button[name='Send'] or text=Continue. Use snapshot first to inspect the page.",
});

const LegacySelector = TrimmedNonEmptyString.annotate({
  description:
    "Legacy CSS selector such as button[type='submit']. Prefer locator for resilient role/text targeting.",
});

export const PreviewAutomationClickInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  selector: Schema.optional(LegacySelector).annotate({
    description:
      "Legacy CSS selector such as button[type='submit']. Prefer locator for resilient role/text targeting.",
  }),
  locator: Schema.optional(Locator).annotate({
    description:
      "Playwright selector, preferably role/text based, for example role=button[name='Send'] or text=Continue. Use snapshot first to inspect the page.",
  }),
  x: Schema.optional(
    Schema.Finite.annotate({
      description: "Viewport-relative X coordinate in CSS pixels. Must be paired with y.",
    }),
  ),
  y: Schema.optional(
    Schema.Finite.annotate({
      description: "Viewport-relative Y coordinate in CSS pixels. Must be paired with x.",
    }),
  ),
  timeoutMs: OptionalTimeoutMs,
})
  .check(
    Schema.makeFilter((input) => {
      const selectorModes =
        Number(input.selector !== undefined) + Number(input.locator !== undefined);
      const hasX = input.x !== undefined;
      const hasY = input.y !== undefined;
      if (hasX !== hasY) return "Coordinates require both x and y.";
      const coordinateModes = hasX && hasY ? 1 : 0;
      return selectorModes + coordinateModes === 1 || "Provide exactly one click target.";
    }),
  )
  .annotate({
    description:
      "Clicks one target. Provide exactly one of locator, selector, or the x/y coordinate pair.",
  });

export type PreviewAutomationClickInput = typeof PreviewAutomationClickInput.Type;

export const PreviewAutomationTypeInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  text: Schema.String.annotate({ description: "Literal text to insert." }),
  selector: Schema.optional(LegacySelector).annotate({
    description: "Legacy CSS selector for the input. Prefer locator.",
  }),
  locator: Schema.optional(Locator).annotate({
    description:
      "Playwright selector for the input, for example role=textbox[name='Message'] or textarea[placeholder*='Message'].",
  }),
  clear: Schema.optional(
    Schema.Boolean.annotate({
      description: "Clear the existing input value before inserting text. Defaults to false.",
    }),
  ),
  timeoutMs: OptionalTimeoutMs,
})
  .check(
    Schema.makeFilter(
      (input) =>
        !(input.selector !== undefined && input.locator !== undefined) ||
        "Provide at most one of selector or locator.",
    ),
  )
  .annotate({
    description:
      "Types into locator/selector, or into the currently focused element when neither target is provided.",
  });

export type PreviewAutomationTypeInput = typeof PreviewAutomationTypeInput.Type;

export const PreviewAutomationPressInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  key: Schema.String.check(Schema.isTrimmed())
    .check(
      Schema.isNonEmpty({
        description:
          "Keyboard key name such as Enter, Escape, Tab, ArrowDown, Backspace, or a single character.",
      }),
    )
    .annotateKey({
      description:
        "Keyboard key name such as Enter, Escape, Tab, ArrowDown, Backspace, or a single character.",
    }),
  modifiers: Schema.optional(
    Schema.Array(Schema.Literals(["Alt", "Control", "Meta", "Shift"])).annotate({
      description: "Modifier keys held while pressing key.",
    }),
  ),
}).annotate({ description: "Presses one keyboard key in the active browser tab." });

export type PreviewAutomationPressInput = typeof PreviewAutomationPressInput.Type;

export const PreviewAutomationScrollInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  deltaX: Schema.optional(
    Schema.Finite.annotate({
      description: "Horizontal scroll delta in CSS pixels. Positive scrolls right. Defaults to 0.",
    }),
  ),
  deltaY: Schema.optional(
    Schema.Finite.annotate({
      description: "Vertical scroll delta in CSS pixels. Positive scrolls down. Defaults to 0.",
    }),
  ),
  selector: Schema.optional(LegacySelector).annotate({
    description: "Legacy CSS selector for a scrollable container. Omit to scroll the viewport.",
  }),
  locator: Schema.optional(Locator).annotate({
    description: "Playwright selector for a scrollable container. Omit to scroll the viewport.",
  }),
})
  .check(
    Schema.makeFilter((input) => {
      if (input.selector !== undefined && input.locator !== undefined) {
        return "Provide at most one of selector or locator.";
      }
      return (
        input.deltaX !== undefined || input.deltaY !== undefined || "Provide deltaX or deltaY."
      );
    }),
  )
  .annotate({
    description:
      "Scrolls the viewport, or a locator/selector container. Provide deltaX, deltaY, or both.",
  });

export type PreviewAutomationScrollInput = typeof PreviewAutomationScrollInput.Type;

export const PreviewAutomationEvaluateInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  expression: Schema.String.check(Schema.isTrimmed())
    .check(
      Schema.isNonEmpty({
        description:
          "JavaScript expression evaluated in the page's main frame, for example document.title or (() => ({href: location.href}))().",
      }),
    )
    .check(Schema.isMaxLength(64_000))
    .annotateKey({
      description:
        "JavaScript expression evaluated in the page's main frame, for example document.title or (() => ({href: location.href}))().",
    }),
  awaitPromise: Schema.optional(
    Schema.Boolean.annotate({ description: "Await a returned Promise. Defaults to true." }),
  ),
  returnByValue: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Serialize and return the value instead of a remote object reference. Defaults to true.",
    }),
  ),
}).annotate({
  description:
    "Evaluates JavaScript in the page. Prefer snapshot and semantic actions; use evaluate for inspection or unsupported interactions.",
});

export type PreviewAutomationEvaluateInput = typeof PreviewAutomationEvaluateInput.Type;

export const PreviewAutomationWaitForInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  selector: Schema.optional(LegacySelector).annotate({
    description: "Legacy CSS selector that must match an element. Prefer locator.",
  }),
  locator: Schema.optional(Locator).annotate({
    description:
      "Playwright selector that must match an element, for example role=button[name='Send'].",
  }),
  text: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Case-sensitive substring that must appear in visible document text.",
    }),
  ).annotate({
    description: "Case-sensitive substring that must appear in visible document text.",
  }),
  urlIncludes: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Substring that must appear in the current absolute URL.",
    }),
  ).annotate({ description: "Substring that must appear in the current absolute URL." }),
  timeoutMs: OptionalTimeoutMs,
})
  .check(
    Schema.makeFilter((input) => {
      if (input.selector !== undefined && input.locator !== undefined) {
        return "Provide at most one of selector or locator.";
      }
      return (
        input.selector !== undefined ||
        input.locator !== undefined ||
        input.text !== undefined ||
        input.urlIncludes !== undefined ||
        "Provide at least one wait condition."
      );
    }),
  )
  .annotate({
    description:
      "Waits until all provided conditions match. Use after click/type when the page changes asynchronously.",
  });

export type PreviewAutomationWaitForInput = typeof PreviewAutomationWaitForInput.Type;
