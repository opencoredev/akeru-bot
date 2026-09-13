import { useEffect, useState, type KeyboardEvent, type PointerEvent } from "react";

import { cn } from "../../lib/utils";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { clampColorFraction, hexToHsv, hsvToHex, type HsvColor } from "./avatarColorPicker.logic";
import { BLOB_COLORS, DEFAULT_BLOB_COLOR, isBotAvatarColor } from "./roster.logic";

function ColorThumb({ color, left, top }: { color: string; left: string; top: string }) {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgb(0_0_0/60%)]"
      style={{ backgroundColor: color, left, top }}
    />
  );
}

function pointerFraction(event: PointerEvent<HTMLDivElement>) {
  const bounds = event.currentTarget.getBoundingClientRect();
  return {
    x: clampColorFraction((event.clientX - bounds.left) / bounds.width),
    y: clampColorFraction((event.clientY - bounds.top) / bounds.height),
  };
}

function ColorPickerPanel({
  value,
  onChange,
}: {
  value: string;
  onChange: (color: string) => void;
}) {
  const [hsv, setHsv] = useState<HsvColor>(() => hexToHsv(value) ?? { h: 210, s: 0.5, v: 0.7 });
  const [draft, setDraft] = useState<string | null>(null);

  useEffect(() => {
    const next = hexToHsv(value);
    if (!next) return;
    setHsv((current) => (next.s === 0 || next.v === 0 ? { ...next, h: current.h } : next));
    setDraft(null);
  }, [value]);

  const commitHsv = (next: HsvColor) => {
    setHsv(next);
    setDraft(null);
    onChange(hsvToHex(next));
  };

  const commitHex = (candidate: string) => {
    const next = hexToHsv(candidate);
    if (next) commitHsv(next);
    else setDraft(null);
  };

  const updateField = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const { x, y } = pointerFraction(event);
    commitHsv({ ...hsv, s: x, v: 1 - y });
  };

  const updateHue = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    commitHsv({ ...hsv, h: pointerFraction(event).x * 360 });
  };

  const handleFieldKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 0.1 : 0.02;
    const next = { ...hsv };
    if (event.key === "ArrowLeft") next.s = clampColorFraction(hsv.s - step);
    else if (event.key === "ArrowRight") next.s = clampColorFraction(hsv.s + step);
    else if (event.key === "ArrowUp") next.v = clampColorFraction(hsv.v + step);
    else if (event.key === "ArrowDown") next.v = clampColorFraction(hsv.v - step);
    else return;
    event.preventDefault();
    commitHsv(next);
  };

  const handleHueKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const direction = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    if (direction === 0) return;
    event.preventDefault();
    const step = event.shiftKey ? 30 : 4;
    commitHsv({ ...hsv, h: (hsv.h + direction * step + 360) % 360 });
  };

  const color = hsvToHex(hsv);
  const hueColor = hsvToHex({ h: hsv.h, s: 1, v: 1 });

  return (
    <div className="w-60 p-3">
      <div
        role="slider"
        tabIndex={0}
        aria-label="Saturation and brightness"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(hsv.v * 100)}
        aria-valuetext={color}
        className="relative h-36 cursor-crosshair touch-none rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
        style={{
          backgroundColor: hueColor,
          backgroundImage:
            "linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent)",
        }}
        onKeyDown={handleFieldKeyDown}
        onPointerDown={updateField}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) updateField(event);
        }}
      >
        <ColorThumb color={color} left={`${hsv.s * 100}%`} top={`${(1 - hsv.v) * 100}%`} />
      </div>

      <div
        role="slider"
        tabIndex={0}
        aria-label="Hue"
        aria-valuemin={0}
        aria-valuemax={360}
        aria-valuenow={Math.round(hsv.h)}
        className="relative mt-3 h-3 cursor-ew-resize touch-none rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
        style={{
          background: "linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)",
        }}
        onKeyDown={handleHueKeyDown}
        onPointerDown={updateHue}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) updateHue(event);
        }}
      >
        <ColorThumb color={hueColor} left={`${(hsv.h / 360) * 100}%`} top="50%" />
      </div>

      <label className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
        Hex
        <span className="flex h-8 flex-1 items-center rounded-md border border-input bg-background px-2 font-mono text-foreground focus-within:ring-2 focus-within:ring-ring">
          #
          <input
            aria-label="Avatar color hex value"
            className="min-w-0 flex-1 bg-transparent outline-none"
            value={(draft ?? color).replace("#", "")}
            maxLength={6}
            spellCheck={false}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onBlur={() => commitHex(draft ?? color)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitHex(draft ?? color);
              } else if (event.key === "Escape") {
                setDraft(null);
              }
            }}
          />
        </span>
      </label>
    </div>
  );
}

export function AvatarColorPicker({
  value,
  onChange,
  className,
  label = "Avatar color",
}: {
  value: string;
  onChange: (color: string) => void;
  className?: string;
  label?: string;
}) {
  const color = isBotAvatarColor(value) ? value.toUpperCase() : DEFAULT_BLOB_COLOR;
  const presetSelected = BLOB_COLORS.includes(color);

  return (
    <div
      role="group"
      aria-label={label}
      className={cn("flex flex-wrap items-center gap-2.5", className)}
    >
      {BLOB_COLORS.map((preset) => (
        <button
          key={preset}
          type="button"
          aria-label={`Use ${preset}`}
          aria-pressed={color === preset}
          onClick={() => onChange(preset)}
          style={{ backgroundColor: preset }}
          className={cn(
            "size-8 cursor-pointer rounded-full border border-foreground/10 outline-none focus-visible:ring-2 focus-visible:ring-ring",
            color === preset && "ring-2 ring-ring ring-offset-2 ring-offset-background",
          )}
        />
      ))}

      <Popover>
        <PopoverTrigger
          render={
            <button
              type="button"
              aria-label={`Choose a custom avatar color. Current color ${color}`}
              aria-pressed={!presetSelected}
              className={cn(
                "size-8 cursor-pointer rounded-full border border-foreground/15 outline-none focus-visible:ring-2 focus-visible:ring-ring",
                !presetSelected && "ring-2 ring-ring ring-offset-2 ring-offset-background",
              )}
              style={{
                background:
                  "conic-gradient(from 90deg, #ff3b30, #ffcc00, #34c759, #00c7be, #0a84ff, #bf5af2, #ff375f, #ff3b30)",
              }}
            />
          }
        />
        <PopoverPopup
          align="end"
          sideOffset={8}
          className="overflow-hidden"
          viewportClassName="p-0 [--viewport-inline-padding:0px]"
        >
          <ColorPickerPanel value={color} onChange={onChange} />
        </PopoverPopup>
      </Popover>
    </div>
  );
}
