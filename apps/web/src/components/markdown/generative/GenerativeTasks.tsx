import { CircleAlertIcon, CircleCheckIcon, CircleDotIcon, CircleIcon } from "lucide-react";
import type { TasksSpec } from "./generativeSchemas";
import { GenerativeFrame } from "./GenerativeFrame";

type TaskState = TasksSpec["items"][number]["state"];

function TaskStateIcon({ state }: { readonly state: TaskState }) {
  switch (state) {
    case "done":
      return <CircleCheckIcon className="size-4 text-success" aria-label="Done" />;
    case "running":
      return <CircleDotIcon className="size-4 text-primary" aria-label="In progress" />;
    case "blocked":
      return <CircleAlertIcon className="size-4 text-warning" aria-label="Blocked" />;
    case "todo":
      return <CircleIcon className="size-4 text-muted-foreground/60" aria-label="Not started" />;
  }
}

export function GenerativeTasks({ spec }: { readonly spec: TasksSpec }) {
  const done = spec.items.filter((item) => item.state === "done").length;
  const total = spec.items.length;

  return (
    <GenerativeFrame
      kind="tasks"
      title={spec.title}
      aside={
        <span className="text-xs text-muted-foreground tabular-nums">
          {done}/{total}
        </span>
      }
    >
      <div className="gen-progress-track mb-3 h-1 overflow-hidden rounded-full">
        <div
          className="gen-progress-fill h-full w-(--gen-progress) rounded-full"
          style={{ "--gen-progress": `${total === 0 ? 0 : (done / total) * 100}%` }}
        />
      </div>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {spec.items.map((item) => (
          <li key={item.label} className="m-0 flex items-start gap-2.5 p-0">
            <span className="mt-0.5 shrink-0">
              <TaskStateIcon state={item.state} />
            </span>
            <span
              className={
                item.state === "done"
                  ? "min-w-0 flex-1 text-sm text-muted-foreground"
                  : "min-w-0 flex-1 text-sm text-foreground"
              }
            >
              {item.label}
            </span>
            {item.note ? (
              <span
                className="gen-tone-text shrink-0 text-xs"
                data-tone={item.state === "blocked" ? "warn" : "neutral"}
              >
                {item.note}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </GenerativeFrame>
  );
}
