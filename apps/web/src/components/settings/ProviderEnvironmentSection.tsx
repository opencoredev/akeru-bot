import { PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { type ProviderInstanceEnvironmentVariable } from "@akeru/contracts";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { DraftInput } from "../ui/draft-input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";

const ENVIRONMENT_VARIABLE_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

let environmentVariableDraftId = 0;

const nextEnvironmentVariableDraftId = () => `provider-env-${environmentVariableDraftId++}`;

type EnvironmentDraftRow = {
  readonly id: string;
  readonly name: string;
  readonly value: string;
  readonly sensitive: boolean;
  readonly valueRedacted?: boolean;
};

function makeEnvironmentDraftRow(
  variable: ProviderInstanceEnvironmentVariable,
  index: number,
): EnvironmentDraftRow {
  return {
    id: `${index}:${variable.name}`,
    name: variable.name,
    value: variable.value,
    sensitive: variable.sensitive,
    ...(variable.valueRedacted !== undefined ? { valueRedacted: variable.valueRedacted } : {}),
  };
}

export function ProviderEnvironmentSection(props: {
  readonly environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>;
  readonly onChange: (environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>) => void;
}) {
  const [rows, setRows] = useState<ReadonlyArray<EnvironmentDraftRow>>(() =>
    props.environment.map(makeEnvironmentDraftRow),
  );

  const publishRows = (nextRows: ReadonlyArray<EnvironmentDraftRow>) => {
    const published: ProviderInstanceEnvironmentVariable[] = [];
    for (const row of nextRows) {
      const name = row.name.trim();
      if (!ENVIRONMENT_VARIABLE_NAME_PATTERN.test(name)) {
        if (
          name.length > 0 ||
          row.value.length > 0 ||
          row.sensitive !== true ||
          row.valueRedacted !== undefined
        ) {
          return;
        }
        continue;
      }
      const { id: _id, ...rest } = row;
      published.push({ ...rest, name });
    }
    props.onChange(published);
  };

  const updateVariable = (id: string, patch: Partial<Omit<EnvironmentDraftRow, "id">>) => {
    const nextRows = rows.map((row) =>
      row.id === id
        ? {
            ...row,
            ...patch,
            ...(patch.value !== undefined ? { valueRedacted: false } : {}),
          }
        : row,
    );
    setRows(nextRows);
    publishRows(nextRows);
  };

  const removeVariable = (id: string) => {
    const nextRows = rows.filter((row) => row.id !== id);
    setRows(nextRows);
    publishRows(nextRows);
  };

  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-foreground">Environment variables</span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          presentation="environment-add"
          onClick={() =>
            setRows([
              ...rows,
              {
                id: nextEnvironmentVariableDraftId(),
                name: "",
                value: "",
                sensitive: true,
              },
            ])
          }
        >
          <PlusIcon className="size-3" />
          Add
        </Button>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Add variables to pass API keys, base URLs, or other per-instance CLI settings.
        </p>
      ) : (
        <div className="overflow-hidden rounded-md border border-border/70">
          <Table>
            <TableHeader presentation="provider-environment">
              <TableRow presentation="provider-environment-header">
                <TableHead>Variable</TableHead>
                <TableHead>Value</TableHead>
                <TableHead className="w-20">Sensitive</TableHead>
                <TableHead className="w-12 text-right">
                  <span className="sr-only">Options</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((variable, index) => (
                <TableRow key={variable.id} presentation="provider-environment">
                  <TableCell>
                    <DraftInput
                      value={variable.name}
                      onCommit={(name) => updateVariable(variable.id, { name: name.trim() })}
                      placeholder="VARIABLE_NAME"
                      spellCheck={false}
                      aria-label={`Environment variable name ${index + 1}`}
                    />
                  </TableCell>
                  <TableCell>
                    <DraftInput
                      value={variable.valueRedacted ? "" : variable.value}
                      onCommit={(value) => updateVariable(variable.id, { value })}
                      type={variable.sensitive ? "password" : undefined}
                      autoComplete="off"
                      placeholder={
                        variable.valueRedacted
                          ? "Stored secret - enter a new value to replace"
                          : "Value"
                      }
                      spellCheck={false}
                      aria-label={`Environment variable value ${index + 1}`}
                    />
                  </TableCell>
                  <TableCell className="w-20">
                    <div className="flex h-8 items-center justify-center">
                      <Checkbox
                        checked={variable.sensitive}
                        onCheckedChange={(checked) => {
                          const sensitive = Boolean(checked);
                          updateVariable(variable.id, {
                            sensitive,
                            ...(sensitive && variable.valueRedacted === undefined
                              ? {}
                              : { valueRedacted: sensitive ? variable.valueRedacted : false }),
                          });
                        }}
                        aria-label={`Mark environment variable ${variable.name || index + 1} as sensitive`}
                      />
                    </div>
                  </TableCell>
                  <TableCell className="w-12">
                    <div className="flex justify-end">
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        presentation="environment-remove"
                        onClick={() => removeVariable(variable.id)}
                        aria-label={`Remove environment variable ${variable.name || index + 1}`}
                      >
                        <XIcon className="size-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <span className="text-xs text-muted-foreground">
        Sensitive values are stored separately and are not returned to the app after saving.
      </span>
    </div>
  );
}
