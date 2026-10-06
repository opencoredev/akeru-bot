import type { TimelineSpec } from "./generativeSchemas";
import { GenerativeFrame } from "./GenerativeFrame";

export function GenerativeTimeline({ spec }: { readonly spec: TimelineSpec }) {
  return (
    <GenerativeFrame kind="timeline" title={spec.title}>
      <ol className="m-0 flex list-none flex-col p-0">
        {spec.events.map((event, index) => (
          <li
            key={`${event.time}-${event.label}`}
            className="m-0 flex gap-3 p-0"
            data-tone={event.tone ?? "neutral"}
          >
            <span className="w-12 shrink-0 pt-px text-right font-mono text-xs text-muted-foreground tabular-nums">
              {event.time}
            </span>
            <span className="relative flex w-2.5 shrink-0 justify-center">
              <span className="gen-tone-dot relative z-10 mt-1.5 size-2 rounded-full ring-3 ring-card" />
              {index < spec.events.length - 1 ? (
                <span className="gen-rail absolute top-3 -bottom-1.5 w-px" />
              ) : null}
            </span>
            <span className="flex min-w-0 flex-1 flex-col pb-3.5">
              <span className="text-sm text-foreground">{event.label}</span>
              {event.detail ? (
                <span className="text-xs text-muted-foreground">{event.detail}</span>
              ) : null}
            </span>
          </li>
        ))}
      </ol>
    </GenerativeFrame>
  );
}
