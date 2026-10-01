/* oxlint-disable shadcn/no-inline-styles -- the wireframe paints the previewed theme's own colors, not app chrome */
/* oxlint-disable shadcn/no-arbitrary-values -- a miniature drawing positioned in percentages of its frame; exact simple fractions use the scale */
import { cn } from "../../lib/utils";
import type { ThemeCardPreviewColors } from "./ThemePreviewCircles";

// Agent rows in the orchestrator island. A null dot takes the previewed
// theme's message action color.
const AGENT_ROWS = [
  { topClassName: "top-1/10", dotColor: "#34d399" },
  { topClassName: "top-2/5", dotColor: null },
  { topClassName: "top-7/10", dotColor: "#fbbf24" },
] as const;

// A simple miniature of the app: sidebar, a short conversation, the
// composer, and the orchestrator panel floating over the interface as an
// island with horizontal agent rows.
export function ThemeWireframePane({
  colors,
  clip,
}: {
  colors: ThemeCardPreviewColors;
  clip?: "left" | "right" | undefined;
}) {
  const line = "rgb(127 127 127 / 0.25)";
  return (
    <span
      className="absolute inset-0"
      style={
        clip === undefined
          ? undefined
          : {
              clipPath:
                clip === "left"
                  ? "polygon(0 0, calc(50% - 1px) 0, calc(50% - 1px) 100%, 0 100%)"
                  : "polygon(calc(50% + 1px) 0, 100% 0, 100% 100%, calc(50% + 1px) 100%)",
            }
      }
    >
      <span className="absolute inset-0" style={{ backgroundColor: colors.canvas }} />
      <span
        className="absolute inset-y-0 left-0 w-[22%]"
        style={{ backgroundColor: colors.sidebar, boxShadow: `inset -1px 0 0 ${line}` }}
      />

      {/* Sidebar: search, then thread rows */}
      <span
        className="absolute left-[3%] top-[8%] h-[8%] w-[16%] rounded-md"
        style={{ backgroundColor: colors.surface, boxShadow: `inset 0 0 0 1px ${line}` }}
      />
      <span
        className="absolute left-[3%] top-[22%] h-[7%] w-[16%] rounded-md"
        style={{ backgroundColor: colors.accentSurface }}
      />
      <span
        className="absolute left-[3%] top-[32%] h-[7%] w-[16%] rounded-md opacity-70"
        style={{ backgroundColor: colors.messageSurface }}
      />
      <span
        className="absolute left-[3%] top-[42%] h-[7%] w-[16%] rounded-md opacity-50"
        style={{ backgroundColor: colors.messageSurface }}
      />

      {/* Conversation */}
      <span
        className="absolute right-[28%] top-[11%] h-[9%] w-[24%] rounded-lg"
        style={{ backgroundColor: colors.messageSurface }}
      />
      <span
        className="absolute left-[27%] top-[28%] h-1/20 w-[34%] rounded-sm"
        style={{ backgroundColor: line }}
      />
      <span
        className="absolute left-[27%] top-[38%] h-1/20 w-[26%] rounded-sm"
        style={{ backgroundColor: line }}
      />

      {/* Composer */}
      <span
        className="absolute bottom-[8%] left-[26%] right-[6%] flex h-3/20 items-center justify-between rounded-md px-[2.5%]"
        style={{
          backgroundColor: colors.surface,
          boxShadow: `inset 0 0 0 1px ${line}`,
        }}
      >
        <span
          className="block h-[26%] w-[34%] rounded-full opacity-70"
          style={{ backgroundColor: line }}
        />
        <span
          className="block aspect-square h-[58%] rounded-full"
          style={{ backgroundColor: colors.messageAction }}
        />
      </span>

      {/* Orchestrator island floating over the composer */}
      <span
        className="absolute right-1/20 top-[8%] h-[46%] w-1/5 rounded-lg"
        style={{
          backgroundColor: colors.surface,
          boxShadow: `inset 0 0 0 1px ${line}, 0 2px 5px rgb(0 0 0 / 0.14)`,
        }}
      >
        {AGENT_ROWS.map((row) => (
          <span
            className={cn(
              "absolute left-[11%] right-[11%] flex h-1/5 items-center gap-[5%]",
              row.topClassName,
            )}
            key={row.topClassName}
          >
            <span
              className="block aspect-square h-[26%] rounded-full opacity-55"
              style={{ backgroundColor: row.dotColor ?? colors.messageAction }}
            />
            <span className="block h-3/10 w-[52%] rounded-sm" style={{ backgroundColor: line }} />
          </span>
        ))}
      </span>
    </span>
  );
}

export function ThemeWireframe({
  className,
  panes,
}: {
  /** Sizing (height) for the frame; the pane geometry is percentage based. */
  className?: string;
  panes: ReadonlyArray<{ colors: ThemeCardPreviewColors; clip?: "left" | "right" }>;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative block w-full overflow-hidden rounded-lg border border-border/60",
        className,
      )}
    >
      {panes.map((pane) => (
        <ThemeWireframePane clip={pane.clip} colors={pane.colors} key={pane.clip ?? "pane"} />
      ))}
    </span>
  );
}
