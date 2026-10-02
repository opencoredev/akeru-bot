"use client";

import { PipetteIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";

import { ColorSelector } from "../color-selector";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { normalizeProviderAccentColor } from "../../providerInstances";
import { cn } from "../../lib/utils";

const PROVIDER_ACCENT_SWATCHES = [
  "#2563eb",
  "#16a34a",
  "#ea580c",
  "#dc2626",
  "#7c3aed",
  "#0891b2",
] as const;

/** The stored accent as a hex color, or the first swatch when none is valid. */
function resolveAccentColor(value: string | undefined): string {
  return normalizeProviderAccentColor(value) ?? PROVIDER_ACCENT_SWATCHES[0];
}

function clamp(value: number, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function hexToHsv(hex: string) {
  const normalized = resolveAccentColor(hex);
  const numeric = Number.parseInt(normalized.slice(1), 16);
  const red = ((numeric >> 16) & 255) / 255;
  const green = ((numeric >> 8) & 255) / 255;
  const blue = (numeric & 255) / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;

  let hue = 0;

  if (delta !== 0) {
    if (max === red) {
      hue = ((green - blue) / delta) % 6;
    } else if (max === green) {
      hue = (blue - red) / delta + 2;
    } else {
      hue = (red - green) / delta + 4;
    }

    hue *= 60;

    if (hue < 0) hue += 360;
  }

  return {
    h: hue,
    s: max === 0 ? 0 : delta / max,
    v: max,
  };
}

function hsvToHex(hue: number, saturation: number, value: number) {
  const chroma = value * saturation;
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const match = value - chroma;

  const [red, green, blue] =
    hue < 60
      ? [chroma, x, 0]
      : hue < 120
        ? [x, chroma, 0]
        : hue < 180
          ? [0, chroma, x]
          : hue < 240
            ? [0, x, chroma]
            : hue < 300
              ? [x, 0, chroma]
              : [chroma, 0, x];

  return `#${[red, green, blue]
    .map((channel) =>
      Math.round((channel + match) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function ProviderCustomColorPanel(props: {
  readonly value: string;
  readonly onCommit: (value: string) => void;
}) {
  const { onCommit } = props;
  const initialHsv = useMemo(() => hexToHsv(props.value), [props.value]);
  const [hsv, setHsv] = useState(initialHsv);
  const currentColor = hsvToHex(hsv.h, hsv.s, hsv.v);

  const commitHsv = useCallback(
    (nextHsv: typeof hsv) => {
      setHsv(nextHsv);
      onCommit(hsvToHex(nextHsv.h, nextHsv.s, nextHsv.v));
    },
    [onCommit],
  );

  const updateFromPlane = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const bounds = event.currentTarget.getBoundingClientRect();
      const saturation = clamp((event.clientX - bounds.left) / bounds.width);
      const value = 1 - clamp((event.clientY - bounds.top) / bounds.height);
      commitHsv({ ...hsv, s: saturation, v: value });
    },
    [commitHsv, hsv],
  );

  const updateFromHue = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const bounds = event.currentTarget.getBoundingClientRect();
      commitHsv({ ...hsv, h: clamp((event.clientX - bounds.left) / bounds.width) * 360 });
    },
    [commitHsv, hsv],
  );

  const handlePointerDown = (handler: (event: PointerEvent<HTMLDivElement>) => void) => {
    return (event: PointerEvent<HTMLDivElement>) => {
      event.currentTarget.setPointerCapture(event.pointerId);
      handler(event);
    };
  };

  return (
    <div className="w-56 bg-popover">
      <div
        className="relative h-36 cursor-crosshair touch-none bg-pure-hue bg-saturation-value-plane"
        style={{ "--hue": String(hsv.h) }}
        onPointerDown={handlePointerDown(updateFromPlane)}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            updateFromPlane(event);
          }
        }}
      >
        <span
          className="pointer-events-none absolute top-(--thumb-top) left-(--thumb-left) size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-on-solid ring-1 ring-shade/35"
          style={{ "--thumb-left": `${hsv.s * 100}%`, "--thumb-top": `${(1 - hsv.v) * 100}%` }}
        />
      </div>
      <div className="grid gap-3 p-3">
        <div
          className="relative h-3 cursor-pointer touch-none rounded-full bg-hue-spectrum"
          onPointerDown={handlePointerDown(updateFromHue)}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              updateFromHue(event);
            }
          }}
        >
          <span
            className="pointer-events-none absolute top-1/2 left-(--thumb-left) size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-on-solid ring-1 ring-shade/35 swatch-fill"
            style={{ "--thumb-left": `${(hsv.h / 360) * 100}%`, "--swatch": currentColor }}
          />
        </div>
        <input
          value={currentColor}
          onChange={(event) => {
            const nextColor = event.currentTarget.value;

            if (!/^#[\da-f]{6}$/i.test(nextColor)) return;
            setHsv(hexToHsv(nextColor));
            props.onCommit(nextColor);
          }}
          className="h-8 rounded-md border border-input bg-background px-2 font-mono text-xs text-foreground outline-none transition-colors focus:border-foreground/30"
          aria-label="Custom hex accent color"
          spellCheck={false}
        />
      </div>
    </div>
  );
}

function ProviderCustomColorPicker(props: {
  readonly displayName: string;
  readonly value: string | undefined;
  readonly selected: boolean;
  readonly onCommit: (value: string) => void;
}) {
  const normalized = resolveAccentColor(props.value);

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            className={cn(
              "flex size-6 cursor-pointer items-center justify-center rounded-full swatch-fill text-on-solid transition-transform duration-200 active:scale-90",
              "hover:scale-105",
              // The trigger wears the user's custom accent; selected adds a ring in that color.
              props.selected && "swatch-ring",
            )}
            style={{ "--swatch": normalized }}
            aria-label={`Choose custom accent color for ${props.displayName}`}
          >
            <PipetteIcon className="size-3 text-foreground/25" aria-hidden />
          </button>
        }
      />
      <PopoverPopup
        side="bottom"
        align="start"
        sideOffset={6}
        className="overflow-hidden"
        variant="accent-picker"
      >
        <ProviderCustomColorPanel value={normalized} onCommit={props.onCommit} />
      </PopoverPopup>
    </Popover>
  );
}

export function ProviderAccentColorPicker(props: {
  readonly displayName: string;
  readonly value: string | undefined;
  readonly onCommit: (value: string) => void;
  readonly description?: string;
  readonly commitDelayMs?: number;
}) {
  const { commitDelayMs = 0, description, displayName, onCommit, value } = props;
  const [optimisticValue, setOptimisticValue] = useState(() => value ?? "");
  const commitTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingCommitRef = useRef<string | null>(null);
  const onCommitRef = useRef(onCommit);

  useEffect(() => {
    onCommitRef.current = onCommit;
  }, [onCommit]);

  useEffect(() => {
    if (pendingCommitRef.current !== null) return;
    setOptimisticValue(value ?? "");
  }, [value]);

  useEffect(() => {
    return () => {
      if (commitTimeoutRef.current !== null) {
        clearTimeout(commitTimeoutRef.current);
      }

      const pendingCommit = pendingCommitRef.current;

      if (pendingCommit !== null) {
        onCommitRef.current(pendingCommit);
      }
    };
  }, []);

  const commitAccentColor = useCallback(
    (value: string) => {
      const normalizedValue = normalizeProviderAccentColor(value) ?? "";
      setOptimisticValue(normalizedValue);

      if (commitDelayMs <= 0) {
        pendingCommitRef.current = null;

        if (commitTimeoutRef.current !== null) {
          clearTimeout(commitTimeoutRef.current);
          commitTimeoutRef.current = null;
        }

        onCommit(normalizedValue);

        return;
      }

      pendingCommitRef.current = normalizedValue;

      if (commitTimeoutRef.current !== null) {
        clearTimeout(commitTimeoutRef.current);
      }

      commitTimeoutRef.current = setTimeout(() => {
        commitTimeoutRef.current = null;
        const pendingCommit = pendingCommitRef.current;
        pendingCommitRef.current = null;

        if (pendingCommit !== null) {
          onCommitRef.current(pendingCommit);
        }
      }, commitDelayMs);
    },
    [commitDelayMs, onCommit],
  );

  const normalized = normalizeProviderAccentColor(optimisticValue);

  const selectedValue =
    normalized && PROVIDER_ACCENT_SWATCHES.some((swatch) => swatch === normalized)
      ? normalized
      : "";

  const customSelected = Boolean(normalized && selectedValue === "");

  return (
    <div className="grid gap-2">
      <span className="text-xs font-medium text-foreground">Accent color</span>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <ProviderCustomColorPicker
          displayName={displayName}
          value={normalized}
          selected={customSelected}
          onCommit={commitAccentColor}
        />
        <ColorSelector
          key={selectedValue}
          colors={[...PROVIDER_ACCENT_SWATCHES]}
          defaultValue={selectedValue}
          size="lg"
          onColorSelect={commitAccentColor}
          className="flex-wrap gap-1.5"
        />
        <Button
          type="button"
          size="icon"
          variant="ghost-fade"
          className="size-7 shrink-0"
          onClick={() => commitAccentColor("")}
          aria-label={`Clear accent color for ${displayName}`}
          aria-hidden={!normalized}
          tabIndex={normalized ? 0 : -1}
        >
          <XIcon className="size-3.5" aria-hidden />
        </Button>
      </div>
      {description ? <span className="text-xs text-muted-foreground">{description}</span> : null}
    </div>
  );
}
