import { cn } from "../../lib/utils";
import type { ThemeCardPreviewColors } from "./ThemePreviewCircles";

// Agent rows in the orchestrator island. A row without a status dot class
// takes the previewed theme's message action color.
const AGENT_ROWS = [
  { topClassName: "top-1/10", dotClassName: "wireframe-agent-dot-running" },
  { topClassName: "top-2/5", dotClassName: "bg-(--wf-message-action)" },
  { topClassName: "top-7/10", dotClassName: "wireframe-agent-dot-waiting" },
] as const;

// A simple miniature of the app: sidebar, a short conversation, the
// composer, and the orchestrator panel floating over the interface as an
// island with horizontal agent rows. Geometry lives in theme-wireframe.css;
// the previewed theme's colors ride --wf-* custom properties.
export function ThemeWireframePane({
  colors,
  clip,
}: {
  colors: ThemeCardPreviewColors;
  clip?: "left" | "right" | undefined;
}) {
  return (
    <span
      className={cn(
        "wireframe-pane absolute inset-0",
        clip === "left" && "wireframe-clip-left",
        clip === "right" && "wireframe-clip-right",
      )}
      style={{
        "--wf-canvas": colors.canvas,
        "--wf-sidebar": colors.sidebar,
        "--wf-surface": colors.surface,
        "--wf-accent-surface": colors.accentSurface,
        "--wf-message-surface": colors.messageSurface,
        "--wf-message-action": colors.messageAction,
      }}
    >
      <span className="absolute inset-0 bg-(--wf-canvas)" />
      <span className="wireframe-sidebar absolute inset-y-0 left-0 bg-(--wf-sidebar)" />

      {/* Sidebar: search, then thread rows */}
      <span className="wireframe-search absolute rounded-md bg-(--wf-surface)" />
      <span className="wireframe-thread wireframe-thread-first absolute rounded-md bg-(--wf-accent-surface)" />
      <span className="wireframe-thread wireframe-thread-second absolute rounded-md bg-(--wf-message-surface) opacity-70" />
      <span className="wireframe-thread wireframe-thread-third absolute rounded-md bg-(--wf-message-surface) opacity-50" />

      {/* Conversation */}
      <span className="wireframe-user-message absolute rounded-lg bg-(--wf-message-surface)" />
      <span className="wireframe-reply-line wireframe-reply-line-first absolute h-1/20 rounded-sm bg-(--wf-line)" />
      <span className="wireframe-reply-line wireframe-reply-line-second absolute h-1/20 rounded-sm bg-(--wf-line)" />

      {/* Composer */}
      <span className="wireframe-composer absolute flex h-3/20 items-center justify-between rounded-md bg-(--wf-surface)">
        <span className="wireframe-composer-input block rounded-full bg-(--wf-line) opacity-70" />
        <span className="wireframe-composer-send block aspect-square rounded-full bg-(--wf-message-action)" />
      </span>

      {/* Orchestrator island floating over the composer */}
      <span className="wireframe-island absolute right-1/20 w-1/5 rounded-lg bg-(--wf-surface)">
        {AGENT_ROWS.map((row) => (
          <span
            className={cn("wireframe-agent-row absolute flex h-1/5 items-center", row.topClassName)}
            key={row.topClassName}
          >
            <span
              className={cn(
                "wireframe-agent-dot block aspect-square rounded-full opacity-55",
                row.dotClassName,
              )}
            />
            <span className="wireframe-agent-label block h-3/10 rounded-sm bg-(--wf-line)" />
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
