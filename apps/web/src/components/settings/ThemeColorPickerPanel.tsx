import type { CSSProperties, KeyboardEvent, PointerEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  clampThemeColor,
  normalizeThemePickerColor,
  themeHexToHsv,
  themeHsvToHex,
  themePickerAlphaSuffix,
  themeRgbToHex,
  themeRgbValue,
  type ThemeColorHsv,
} from "./themeColorPicker.logic";

/* oxlint-disable shadcn/no-inline-styles -- full hue spectrum track, not app chrome */
const HUE_TRACK_STYLE: CSSProperties = {
  background: "linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)",
};
/* oxlint-enable shadcn/no-inline-styles */

export function ThemeColorPickerPanel({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const normalizedValue = normalizeThemePickerColor(value);
  const alphaSuffix = themePickerAlphaSuffix(value);
  const [hsv, setHsv] = useState(() => themeHexToHsv(normalizedValue));
  const [hexDraft, setHexDraft] = useState(normalizedValue);
  const [rgbDraft, setRgbDraft] = useState(() => themeRgbValue(normalizedValue));
  const [isDragging, setIsDragging] = useState(false);
  const isEditingTextRef = useRef(false);
  const currentColor = themeHsvToHex(hsv.h, hsv.s, hsv.v);
  const currentRgb = themeRgbValue(currentColor);

  useEffect(() => {
    // While a text field is focused, the incoming value may be the guided
    // editor's readability-adjusted echo of what is being typed; rewriting the
    // draft would fight the keystrokes. The swatch still tracks via hsv.
    if (!isEditingTextRef.current) {
      setHexDraft(normalizedValue);
      setRgbDraft(themeRgbValue(normalizedValue));
    }
    // Keep the current hue/saturation when the incoming value is just our own
    // change echoed back; hex → HSV is lossy for greys, white, and black.
    setHsv((current) =>
      themeHsvToHex(current.h, current.s, current.v) === normalizedValue
        ? current
        : themeHexToHsv(normalizedValue),
    );
  }, [normalizedValue]);

  // Local state updates immediately for a smooth thumb; the parent commit
  // (which can regenerate a whole guided palette) is batched to one call per
  // animation frame.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const pendingCommitRef = useRef<string | null>(null);
  const commitFrameRef = useRef<number | null>(null);
  // The final drag frame must not be lost when the popover closes or the
  // pointer lifts before the animation frame fires.
  const flushPendingCommit = useCallback(() => {
    if (commitFrameRef.current !== null) {
      cancelAnimationFrame(commitFrameRef.current);
      commitFrameRef.current = null;
    }
    const pending = pendingCommitRef.current;
    pendingCommitRef.current = null;
    if (pending !== null) onChangeRef.current(pending);
  }, []);
  useEffect(() => () => flushPendingCommit(), [flushPendingCommit]);
  const scheduleCommit = useCallback((color: string) => {
    pendingCommitRef.current = color;
    commitFrameRef.current ??= requestAnimationFrame(() => {
      commitFrameRef.current = null;
      const pending = pendingCommitRef.current;
      pendingCommitRef.current = null;
      if (pending !== null) onChangeRef.current(pending);
    });
  }, []);

  const commitHsv = useCallback(
    (nextHsv: ThemeColorHsv) => {
      setHsv(nextHsv);
      const nextColor = themeHsvToHex(nextHsv.h, nextHsv.s, nextHsv.v);
      setHexDraft(nextColor);
      setRgbDraft(themeRgbValue(nextColor));
      scheduleCommit(nextColor + alphaSuffix);
    },
    [alphaSuffix, scheduleCommit],
  );

  const updateFromPlane = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const bounds = event.currentTarget.getBoundingClientRect();
      const saturation = clampThemeColor((event.clientX - bounds.left) / bounds.width);
      const value = 1 - clampThemeColor((event.clientY - bounds.top) / bounds.height);
      commitHsv({ ...hsv, s: saturation, v: value });
    },
    [commitHsv, hsv],
  );

  const updateFromHue = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const bounds = event.currentTarget.getBoundingClientRect();
      const hue = clampThemeColor((event.clientX - bounds.left) / bounds.width) * 360;
      commitHsv({ ...hsv, h: hue });
    },
    [commitHsv, hsv],
  );

  const handleHueKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 10 : 1;
    const direction = event.key === "ArrowRight" || event.key === "ArrowUp" ? 1 : -1;
    if (!["ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp"].includes(event.key)) return;
    event.preventDefault();
    commitHsv({ ...hsv, h: (hsv.h + direction * step + 360) % 360 });
  };

  const handlePlaneKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp"].includes(event.key)) return;
    event.preventDefault();
    const step = event.shiftKey ? 0.1 : 0.02;
    const nextHsv = { ...hsv };
    if (event.key === "ArrowLeft") nextHsv.s = clampThemeColor(hsv.s - step);
    if (event.key === "ArrowRight") nextHsv.s = clampThemeColor(hsv.s + step);
    if (event.key === "ArrowUp") nextHsv.v = clampThemeColor(hsv.v + step);
    if (event.key === "ArrowDown") nextHsv.v = clampThemeColor(hsv.v - step);
    commitHsv(nextHsv);
  };

  const handlePointerDown = (handler: (event: PointerEvent<HTMLDivElement>) => void) => {
    return (event: PointerEvent<HTMLDivElement>) => {
      event.currentTarget.setPointerCapture(event.pointerId);
      setIsDragging(true);
      handler(event);
    };
  };

  const stopDragging = () => {
    setIsDragging(false);
    flushPendingCommit();
  };

  // Thumbs travel inside the control by half their own size so they never
  // clip at the extremes; movement only animates for keyboard steps and
  // click-to-jump, never while dragging.
  const thumbTransition = isDragging
    ? undefined
    : "left 80ms linear, top 80ms linear, background-color 80ms linear";
  // The plane and thumbs paint the picked color and sit where it lies on the
  // HSV axes, so their styles are runtime values rather than app chrome.
  /* oxlint-disable shadcn/no-inline-styles -- picked color and HSV thumb geometry */
  const pureHue = `hsl(${hsv.h} 100% 50%)`;
  const planeStyle: CSSProperties = {
    backgroundColor: pureHue,
    backgroundImage:
      "linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent)",
  };
  const planeThumbStyle: CSSProperties = {
    left: `calc(${hsv.s} * (100% - 0.75rem) + 0.375rem)`,
    top: `calc(${1 - hsv.v} * (100% - 0.75rem) + 0.375rem)`,
    transition: thumbTransition,
  };
  const hueThumbStyle: CSSProperties = {
    left: `calc(${hsv.h / 360} * (100% - 1rem) + 0.5rem)`,
    // The ball shows the pure hue so it stays visually anchored to the track;
    // the header swatch carries the full current color.
    backgroundColor: pureHue,
    transition: thumbTransition,
  };
  /* oxlint-enable shadcn/no-inline-styles */

  const handleHexChange = (nextValue: string) => {
    setHexDraft(nextValue);
    if (!/^#[0-9a-f]{6}$/i.test(nextValue)) return;
    const nextHsv = themeHexToHsv(nextValue);
    setHsv(nextHsv);
    setRgbDraft(themeRgbValue(nextValue));
    onChange(nextValue.toLowerCase());
  };

  const handleRgbChange = (nextValue: string) => {
    setRgbDraft(nextValue);
    const nextColor = themeRgbToHex(nextValue);
    if (!nextColor) return;
    setHsv(themeHexToHsv(nextColor));
    setHexDraft(nextColor);
    // RGB cannot express alpha, so a commit keeps the incoming suffix just
    // like the plane and hue controls do.
    onChange(nextColor + alphaSuffix);
  };

  return (
    <div className="w-72 bg-popover">
      <div className="flex items-center justify-between border-b border-border/70 px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-xs font-semibold text-foreground">{label}</p>
          <p className="text-[11px] text-muted-foreground">Choose a color</p>
        </div>
        <span
          className="size-7 shrink-0 rounded-full shadow-sm"
          // oxlint-disable-next-line shadcn/no-inline-styles -- swatch shows the picked color
          style={{ backgroundColor: currentColor }}
        />
      </div>
      <div className="grid gap-3 px-3 pb-3 pt-3">
        <div
          aria-label={`${label} saturation and brightness`}
          aria-valuetext={`saturation ${Math.round(hsv.s * 100)}%, brightness ${Math.round(hsv.v * 100)}%`}
          className="relative h-32 cursor-crosshair touch-none overflow-hidden rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover"
          role="slider"
          style={planeStyle}
          tabIndex={0}
          onKeyDown={handlePlaneKeyDown}
          onLostPointerCapture={stopDragging}
          onPointerDown={handlePointerDown(updateFromPlane)}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) updateFromPlane(event);
          }}
          onPointerUp={stopDragging}
        >
          <span
            className="pointer-events-none absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white ring-1 ring-black/40"
            style={planeThumbStyle}
          />
        </div>
        <div
          aria-label={`${label} hue`}
          aria-valuemax={360}
          aria-valuemin={0}
          aria-valuenow={Math.round(hsv.h)}
          className="relative flex h-6 cursor-pointer touch-none items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover"
          role="slider"
          tabIndex={0}
          onKeyDown={handleHueKeyDown}
          onLostPointerCapture={stopDragging}
          onPointerDown={handlePointerDown(updateFromHue)}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) updateFromHue(event);
          }}
          onPointerUp={stopDragging}
        >
          <span
            aria-hidden
            className="h-2.5 w-full rounded-full inset-ring inset-ring-black/12"
            style={HUE_TRACK_STYLE}
          />
          <span
            className="pointer-events-none absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white ring-1 ring-black/40"
            style={hueThumbStyle}
          />
        </div>
        <div className="grid grid-cols-[1fr_1.2fr] gap-2">
          <label className="grid min-w-0 gap-1">
            <span className="px-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              HEX
            </span>
            <span className="flex min-w-0 items-center gap-2 rounded-lg border border-input bg-background px-2 focus-within:border-foreground/30">
              <span
                className="size-3.5 shrink-0 rounded-full"
                // oxlint-disable-next-line shadcn/no-inline-styles -- swatch shows the picked color
                style={{ backgroundColor: currentColor }}
              />
              <input
                aria-label={`${label} picker hex value`}
                className="h-8 min-w-0 flex-1 bg-transparent font-mono text-xs text-foreground outline-none"
                onBlur={() => {
                  isEditingTextRef.current = false;
                  setHexDraft(currentColor);
                  setRgbDraft(currentRgb);
                }}
                onChange={(event) => handleHexChange(event.currentTarget.value)}
                onFocus={() => {
                  isEditingTextRef.current = true;
                }}
                spellCheck={false}
                value={hexDraft}
              />
            </span>
          </label>
          <label className="grid min-w-0 gap-1">
            <span className="px-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              RGB
            </span>
            <span className="flex min-w-0 items-center rounded-lg border border-input bg-background px-2 focus-within:border-foreground/30">
              <input
                aria-label={`${label} picker RGB value`}
                className="h-8 min-w-0 flex-1 bg-transparent font-mono text-xs text-foreground outline-none"
                onBlur={() => {
                  isEditingTextRef.current = false;
                  setHexDraft(currentColor);
                  setRgbDraft(currentRgb);
                }}
                onChange={(event) => handleRgbChange(event.currentTarget.value)}
                onFocus={() => {
                  isEditingTextRef.current = true;
                }}
                spellCheck={false}
                value={rgbDraft}
              />
            </span>
          </label>
        </div>
      </div>
    </div>
  );
}
