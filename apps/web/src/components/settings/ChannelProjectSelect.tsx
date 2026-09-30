import type { ProjectId } from "@t3tools/contracts";

import { useI18n } from "../../i18n";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

/**
 * Required project picker for channel attach and repair. Channel turns run in the chosen project,
 * so callers keep their action disabled while `value` is null.
 */
export function ChannelProjectSelect({
  projects,
  value,
  onChange,
  label,
  disabled,
  size,
}: {
  readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly title: string }>;
  readonly value: ProjectId | null;
  readonly onChange: (projectId: ProjectId) => void;
  readonly label: string;
  readonly disabled?: boolean;
  readonly size?: "xs" | "sm" | "default";
}) {
  const { t } = useI18n();
  if (projects.length === 0) {
    return (
      <p role="status" className="text-xs text-muted-foreground">
        {t("Add a project before connecting a channel.")}
      </p>
    );
  }
  const selected = projects.find((project) => project.id === value);
  return (
    <div className="flex w-full min-w-0 flex-col gap-1 sm:w-auto">
      <span className="text-xs font-medium text-muted-foreground">{t("Project")}</span>
      <Select
        value={selected?.id ?? null}
        onValueChange={(next) => {
          const project = projects.find((candidate) => candidate.id === next);
          if (project) onChange(project.id);
        }}
      >
        <SelectTrigger
          aria-label={label}
          className="w-full sm:w-48"
          disabled={disabled}
          {...(size ? { size } : {})}
        >
          <SelectValue>{selected?.title ?? t("Choose a project")}</SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {projects.map((project) => (
            <SelectItem key={project.id} value={project.id}>
              {project.title}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}
