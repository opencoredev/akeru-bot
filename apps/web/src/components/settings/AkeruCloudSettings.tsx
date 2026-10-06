import {
  CLOUD_COPY,
  CLOUD_HOSTED_SERVICES,
  cloudViewModel,
  type CloudConnectionTone,
} from "@akeru/client-runtime/cloud-presentation";
import type { EnvironmentId } from "@akeru/contracts";
import { ExternalLinkIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { useSettingsEnvironmentId } from "../../settingsDialogStore";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useCloudLinkCommands } from "./useCloudLinkCommands";

const TONE_DOT: Readonly<Record<CloudConnectionTone, string>> = {
  connected: "bg-success",
  connecting: "bg-warning",
  offline: "bg-muted-foreground/60",
};

function AkeruCloudSettingsForEnvironment({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const status = useEnvironmentQuery(serverEnvironment.cloudStatus({ environmentId, input: {} }));
  const view = cloudViewModel(status.data);
  const commands = useCloudLinkCommands(environmentId);
  const [pending, setPending] = useState(false);

  const run = (action: () => Promise<void | boolean>) => async () => {
    setPending(true);

    try {
      await action();
    } finally {
      setPending(false);
    }
  };

  const connectButton = (label: string) => (
    <Button disabled={pending} onClick={run(commands.connect)}>
      {pending ? <Spinner className="size-3.5" /> : null}
      {label}
    </Button>
  );

  return (
    <SettingsPageContainer>
      <SettingsSection {...searchableSetting("akeru-cloud")}>
        {view.kind === "loading" ? (
          <div className="flex justify-center py-6">
            {status.error ? (
              <p className="text-sm text-muted-foreground">{status.error}</p>
            ) : (
              <Spinner />
            )}
          </div>
        ) : null}

        {view.kind === "unlinked" ? (
          <SettingsRow
            title="Not connected"
            description={CLOUD_COPY.explainer}
            control={connectButton(CLOUD_COPY.connect)}
          />
        ) : null}

        {view.kind === "revoked" ? (
          <SettingsRow
            title={CLOUD_COPY.revoked}
            description={CLOUD_COPY.explainer}
            control={connectButton(CLOUD_COPY.connectAgain)}
          />
        ) : null}

        {view.kind === "linking" ? (
          <SettingsRow title={CLOUD_COPY.waiting} description={CLOUD_COPY.enterCode}>
            <div className="flex flex-col gap-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <code className="font-mono text-3xl font-semibold tracking-widest text-foreground select-all">
                {view.userCode}
              </code>
              <div className="flex gap-2">
                <Button render={<a href={view.verificationUrl} target="_blank" rel="noreferrer" />}>
                  <ExternalLinkIcon className="size-3.5" />
                  {CLOUD_COPY.openVerification}
                </Button>
                <Button variant="outline" disabled={pending} onClick={run(commands.cancel)}>
                  {CLOUD_COPY.cancel}
                </Button>
              </div>
            </div>
          </SettingsRow>
        ) : null}

        {view.kind === "linked" ? (
          <>
            <SettingsRow
              title={CLOUD_COPY.account}
              description={view.email}
              control={
                <Button
                  variant="destructive-outline"
                  disabled={pending}
                  onClick={run(commands.disconnect)}
                >
                  {CLOUD_COPY.disconnect}
                </Button>
              }
            />
            <SettingsRow
              title={CLOUD_COPY.forget}
              description={CLOUD_COPY.forgetConfirmBody}
              control={
                <Button
                  variant="destructive-outline"
                  disabled={pending}
                  onClick={run(commands.forget)}
                >
                  {CLOUD_COPY.forget}
                </Button>
              }
            />
            <SettingsRow
              title={CLOUD_COPY.connection}
              control={
                <span className="flex items-center gap-2 text-sm text-muted-foreground">
                  <span
                    aria-hidden
                    className={cn("size-2 rounded-full", TONE_DOT[view.connectionTone])}
                  />
                  {view.connectionLabel}
                </span>
              }
            />
          </>
        ) : null}
      </SettingsSection>

      {view.kind === "linked" ? (
        <SettingsSection title={CLOUD_COPY.hostedServices}>
          {CLOUD_HOSTED_SERVICES.map((service) => (
            <SettingsRow key={service.id} title={service.label} description={service.detail} />
          ))}
        </SettingsSection>
      ) : null}
    </SettingsPageContainer>
  );
}

export function AkeruCloudSettingsPanel() {
  const environmentId = useSettingsEnvironmentId();

  if (environmentId === null) {
    return (
      <SettingsPageContainer>
        <SettingsSection title={CLOUD_COPY.title}>
          <p className="px-4 py-6 text-sm text-muted-foreground">
            Connect an environment to use Akeru Cloud.
          </p>
        </SettingsSection>
      </SettingsPageContainer>
    );
  }

  return <AkeruCloudSettingsForEnvironment environmentId={environmentId} />;
}
