import type { FlowSpec } from "./generativeSchemas";
import { GenerativeFrame } from "./GenerativeFrame";

// Node size matches the w-32 h-13.5 classes on each node box.
const NODE_WIDTH = 128;

const NODE_HEIGHT = 54;

const COLUMN_GAP = 44;

const ROW_GAP = 14;

interface PlacedNode {
  readonly node: FlowSpec["nodes"][number];
  readonly x: number;
  readonly y: number;
}

/**
 * Ranks nodes left to right by longest incoming path; cycles stop at the first revisit.
 * Entry nodes then move right to sit just before their nearest child, so edges never skip a column.
 */
export function layoutFlow(spec: FlowSpec) {
  const ids = new Set(spec.nodes.map((node) => node.id));
  const edges = spec.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
  const rank = new Map<string, number>();

  const rankOf = (id: string, visiting: Set<string>): number => {
    const known = rank.get(id);

    if (known !== undefined) return known;

    if (visiting.has(id)) return 0;
    visiting.add(id);
    const parents = edges.filter((edge) => edge.to === id).map((edge) => edge.from);

    const value =
      parents.length === 0 ? 0 : Math.max(...parents.map((p) => rankOf(p, visiting) + 1));

    visiting.delete(id);
    rank.set(id, value);

    return value;
  };

  for (const node of spec.nodes) rankOf(node.id, new Set());

  for (const node of spec.nodes) {
    const isEntry = !edges.some((edge) => edge.to === node.id);

    const childRanks = edges
      .filter((edge) => edge.from === node.id)
      .map((edge) => rank.get(edge.to) ?? 0);

    if (isEntry && childRanks.length > 0)
      rank.set(node.id, Math.max(0, Math.min(...childRanks) - 1));
  }

  const columns: Array<Array<FlowSpec["nodes"][number]>> = [];

  for (const node of spec.nodes) {
    (columns[rank.get(node.id) ?? 0] ??= []).push(node);
  }

  const tallest = Math.max(...columns.map((column) => column?.length ?? 0));
  const height = tallest * NODE_HEIGHT + (tallest - 1) * ROW_GAP;
  const placed = new Map<string, PlacedNode>();

  columns.forEach((column, columnIndex) => {
    if (!column) return;
    const columnHeight = column.length * NODE_HEIGHT + (column.length - 1) * ROW_GAP;
    const top = (height - columnHeight) / 2;
    column.forEach((node, rowIndex) => {
      placed.set(node.id, {
        node,
        x: columnIndex * (NODE_WIDTH + COLUMN_GAP),
        y: top + rowIndex * (NODE_HEIGHT + ROW_GAP),
      });
    });
  });

  const width = columns.length * NODE_WIDTH + (columns.length - 1) * COLUMN_GAP;

  return { placed, edges, width, height };
}

export function GenerativeFlow({ spec }: { readonly spec: FlowSpec }) {
  const { placed, edges, width, height } = layoutFlow(spec);

  const highlighted = new Set(
    edges.filter((edge) => edge.highlight).flatMap((edge) => [edge.from, edge.to]),
  );

  const routes = edges.flatMap((edge) => {
    const from = placed.get(edge.from);
    const to = placed.get(edge.to);

    if (!from || !to) return [];
    const startX = from.x + NODE_WIDTH;
    const startY = from.y + NODE_HEIGHT / 2;
    const endX = to.x;
    const endY = to.y + NODE_HEIGHT / 2;
    const bend = Math.max(24, Math.abs(endX - startX) / 2);
    const path = `M${startX},${startY} C${startX + bend},${startY} ${endX - bend},${endY} ${endX - 5},${endY}`;

    return [{ edge, path, endX, endY, midX: (startX + endX) / 2, midY: (startY + endY) / 2 }];
  });

  return (
    <GenerativeFrame kind="flow" title={spec.title}>
      <div className="overflow-x-auto pb-1">
        <div
          className="relative mx-auto h-(--gen-h) w-(--gen-w)"
          style={{ "--gen-w": `${width}px`, "--gen-h": `${height}px` }}
        >
          <svg
            className="absolute inset-0 overflow-visible"
            width={width}
            height={height}
            aria-hidden="true"
          >
            {routes.map(({ edge, path, endX, endY }) => (
              <g key={`${edge.from}-${edge.to}`} data-highlight={edge.highlight === true}>
                <path className="gen-edge" d={path} />
                <path
                  className="gen-edge-head"
                  d={`M${endX - 6},${endY - 4} L${endX},${endY} L${endX - 6},${endY + 4} Z`}
                />
              </g>
            ))}
          </svg>
          {routes.map(({ edge, midX, midY }) =>
            edge.label ? (
              <span
                key={`${edge.from}-${edge.to}-label`}
                className="absolute top-(--gen-y) left-(--gen-x) -translate-x-1/2 -translate-y-1/2 rounded-full border border-border/70 bg-card px-1.5 text-10px whitespace-nowrap text-muted-foreground"
                style={{ "--gen-x": `${midX}px`, "--gen-y": `${midY}px` }}
              >
                {edge.label}
              </span>
            ) : null,
          )}
          {[...placed.values()].map(({ node, x, y }) => (
            <div
              key={node.id}
              className="gen-flow-node absolute top-(--gen-y) left-(--gen-x) flex h-13.5 w-32 flex-col justify-center rounded-lg border border-border bg-background px-2.5"
              data-highlight={highlighted.has(node.id)}
              data-tone={node.tone ?? "neutral"}
              style={{ "--gen-x": `${x}px`, "--gen-y": `${y}px` }}
            >
              <span className="flex items-center gap-1.5 truncate text-xs font-medium text-foreground">
                {node.tone && node.tone !== "neutral" ? (
                  <span className="gen-tone-dot size-1.5 shrink-0 rounded-full" />
                ) : null}
                {node.label}
              </span>
              {node.detail ? (
                <span className="truncate text-10px text-muted-foreground">{node.detail}</span>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </GenerativeFrame>
  );
}
