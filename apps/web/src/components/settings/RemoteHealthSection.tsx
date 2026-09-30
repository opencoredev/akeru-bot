import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@akeru/client-runtime/state/runtime";
import type {
  EnvironmentId,
  RemoteDiagnosticCheck,
  RemoteDiagnosticStatus,
} from "@akeru/contracts";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const CHECK_TITLES: Record<string, string> = {
  service: "Background service",
  "boot-persistence": "Starts at boot",
  disk: "Storage",
  database: "Database",
  "binding-permissions": "Account link permissions",
  "directory-heartbeat": "Directory heartbeat",
  "account-binding": "Account link",
  "update-credential": "Update credential",
  "endpoint-reachability": "Endpoint",
  "update-state": "Update state",
  "update-deferral": "Update deferral",
  "rollback-runtime": "Rollback runtime",
  "serve-ownership": "Tailscale Serve",
  tailscale: "Tailscale",
  "image-lifecycle": "Container image",
  logs: "Logs",
  providers: "Providers",
};

const STATUS_LABELS: Record<RemoteDiagnosticStatus, string> = {
  pass: "OK",
  warning: "Warning",
  fail: "Failing",
};

const STATUS_DOT_CLASSNAMES: Record<RemoteDiagnosticStatus, string> = {
  pass: "bg-success",
  warning: "bg-warning",
  fail: "bg-destructive",
};

function CheckStatus({ status }: { readonly status: RemoteDiagnosticStatus }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span
        aria-hidden="true"
        className={cn("size-2 rounded-full", STATUS_DOT_CLASSNAMES[status])}
      />
      {STATUS_LABELS[status]}
    </span>
  );
}

/**
 * Health of an Akeru Remote install, from the same checks as `akeru remote doctor`. Renders nothing
 * on an environment that is not a remote install. Callers mount it for admin clients only. Repairs
 * run only when the user asks, and only for checks the server marks repairable.
 */
export function RemoteHealthSection({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const doctor = useEnvironmentQuery(serverEnvironment.remoteDoctor({ environmentId, input: {} }));
  const repair = useAtomCommand(serverEnvironment.repairRemoteDoctor, { reportFailure: false });
  const [repairingCheckId, setRepairingCheckId] = useState<string | null>(null);

  if (doctor.data !== null && !doctor.data.applicable) {
    return null;
  }
  if (doctor.data === null && doctor.error === null) {
    // The first run takes a few seconds. Stay hidden rather than flash a section that local
    // environments would immediately drop.
    return null;
  }

  const report = doctor.data?.report ?? null;

  const repairCheck = async (check: RemoteDiagnosticCheck) => {
    setRepairingCheckId(check.id);
    const result = await repair({ environmentId, input: { checkIds: [check.id] } });
    setRepairingCheckId(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not repair",
        description: error instanceof Error ? error.message : "The repair failed.",
      });
      return;
    }
    doctor.refresh();
  };

  return (
    <SettingsSection
      title="Remote health"
      headerAction={
        <Button
          size="xs"
          variant="outline"
          disabled={doctor.isPending || repairingCheckId !== null}
          onClick={doctor.refresh}
        >
          {doctor.isPending ? "Checking" : "Re-run"}
        </Button>
      }
    >
      {doctor.error !== null ? (
        <SettingsRow title="Could not run the checks" description={doctor.error} />
      ) : null}
      {report?.checks.map((check) => (
        <SettingsRow
          key={check.id}
          title={CHECK_TITLES[check.id] ?? check.id}
          description={check.message}
          status={<CheckStatus status={check.status} />}
          control={
            check.repairable && check.status !== "pass" ? (
              <Button
                size="xs"
                variant="outline"
                disabled={doctor.isPending || repairingCheckId !== null}
                onClick={() => void repairCheck(check)}
              >
                {repairingCheckId === check.id ? "Repairing" : "Repair"}
              </Button>
            ) : undefined
          }
        />
      ))}
    </SettingsSection>
  );
}
