import type {
  PortabilityApplyImportResult,
  PortabilityImportItem,
  PortabilityImportPreview,
  PortabilityProjectFolderMap,
  ProjectId,
} from "@akeru/contracts";
import { useI18n } from "../../i18n";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Translate } from "./portabilityPresentation";

export interface ImportPreviewState {
  readonly contents: string;
  readonly filename: string;
  readonly preview: PortabilityImportPreview;
  readonly projectFolders: PortabilityProjectFolderMap;
}

function ImportItems({
  title,
  items,
}: {
  readonly title: string;
  readonly items: readonly PortabilityImportItem[];
}) {
  return (
    <section className="space-y-1.5">
      <h3 className="text-xs font-semibold text-foreground">
        {title} <span className="text-muted-foreground">{items.length}</span>
      </h3>
      {items.length > 0 ? (
        <ul className="space-y-1 text-xs text-muted-foreground">
          {items.map((item) => (
            <li key={`${item.recordType}:${item.id}`} className="flex justify-between gap-4">
              <span className="truncate text-foreground/80">{item.title}</span>
              <span className="shrink-0">{item.recordType}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function ImportPreview({
  preview,
  projectFolders,
  canPickProjectFolders,
  pending,
  onProjectFolderChange,
  onProjectFolderPick,
}: {
  readonly preview: PortabilityImportPreview;
  readonly projectFolders: PortabilityProjectFolderMap;
  readonly canPickProjectFolders: boolean;
  readonly pending: boolean;
  readonly onProjectFolderChange: (projectId: ProjectId, destination: string) => void;
  readonly onProjectFolderPick: (projectId: ProjectId, destination: string | null) => void;
}) {
  const { t } = useI18n();
  const unsupported = preview.unsupported.filter((item) => item.count > 0);
  return (
    <div className="space-y-5">
      {preview.projectFolders.length > 0 ? (
        <section className="space-y-2">
          <h3 className="text-xs font-semibold text-foreground">{t("Project locations")}</h3>
          <p className="text-xs text-muted-foreground">
            {t(
              "Choose an existing folder for each project. Akeru Bot links the project to the folder without copying its files.",
            )}
          </p>
          {preview.projectFolders.map((project) => (
            <div key={project.projectId} className="space-y-1">
              <label className="text-xs text-foreground/80" htmlFor={`folder-${project.projectId}`}>
                {project.title}
              </label>
              <div className="flex gap-1.5">
                <DraftInput
                  id={`folder-${project.projectId}`}
                  size="compact"
                  disabled={pending}
                  value={projectFolders[project.projectId] ?? project.destination ?? ""}
                  placeholder={project.workspaceName}
                  onCommit={(destination) => onProjectFolderChange(project.projectId, destination)}
                />
                {canPickProjectFolders ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={pending}
                    onClick={() => onProjectFolderPick(project.projectId, project.destination)}
                  >
                    {t("Choose")}
                  </Button>
                ) : null}
              </div>
            </div>
          ))}
        </section>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <ImportItems title={t("Additions")} items={preview.additions} />
        <ImportItems title={t("Changes")} items={preview.changes} />
        <ImportItems title={t("Conflicts")} items={preview.conflicts} />
      </div>

      <section className="space-y-1.5">
        <h3 className="text-xs font-semibold text-foreground">
          {t("Missing providers")}{" "}
          <span className="text-muted-foreground">{preview.missingProviders.length}</span>
        </h3>
        {preview.missingProviders.length > 0 ? (
          <p className="text-xs text-muted-foreground">{preview.missingProviders.join(", ")}</p>
        ) : null}
      </section>

      <section className="space-y-1.5">
        <h3 className="text-xs font-semibold text-foreground">{t("Not transferred")}</h3>
        <ul className="space-y-1 text-xs text-muted-foreground">
          {preview.skippedSecrets.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">
          {t(
            "After restore, sign in to providers and reconnect imported MCP servers on this device.",
          )}
        </p>
      </section>

      {unsupported.length > 0 ? (
        <section className="space-y-1.5">
          <h3 className="text-xs font-semibold text-foreground">{t("Not restored")}</h3>
          <ul className="space-y-2 text-xs text-muted-foreground">
            {unsupported.map((item) => (
              <li key={item.kind}>
                <span className="font-medium text-foreground/80">
                  {item.kind} ({item.count})
                </span>
                <span className="block">{item.reason}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

export function importResultDescription(
  result: PortabilityApplyImportResult,
  t: Translate,
): string {
  const counts = [
    t("{count} restored.", { count: result.applied }),
    ...(result.skipped > 0 ? [t("{count} skipped.", { count: result.skipped })] : []),
    ...(result.failed > 0 ? [t("{count} failed.", { count: result.failed })] : []),
    ...(result.partial > 0 ? [t("{count} partly restored.", { count: result.partial })] : []),
  ];
  const firstFailure = result.failures[0];
  return `${counts.join(" ")}${firstFailure ? ` ${firstFailure.title}: ${firstFailure.message}` : ""}`;
}
