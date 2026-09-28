import type { AuthSessionState } from "@t3tools/contracts";
import React, { startTransition, useEffect, useRef, useState, useCallback } from "react";

import {
  isPrimaryEnvironmentPairingCredentialRejectedError,
  peekPairingTokenFromUrl,
  PrimaryEnvironmentPairingCredentialRejectedError,
  readPrimaryEnvironmentDescriptor,
  resolveInitialPrimaryEnvironmentDescriptor,
  stripPairingTokenFromUrl,
  submitServerAuthCredential,
} from "../../environments/primary";
import { isPrimaryEnvironmentPairingCredentialRequiredError } from "../../environments/primary/auth";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import {
  type PairingEnvironmentSummary,
  PairingPanel,
  type PairingPanelStatus,
} from "./PairingPanel";

export function PairingPendingSurface() {
  const environment = usePrimaryEnvironmentSummary();
  return <PairingPanel environment={environment} status={{ kind: "checking" }} />;
}

type PairingError =
  | { readonly kind: "rejected" }
  | { readonly kind: "missing-token"; readonly message: string }
  | { readonly kind: "failed"; readonly message: string };

const REJECTED_TOKEN_MESSAGE = new PrimaryEnvironmentPairingCredentialRejectedError({
  providedLength: 0,
  cause: null,
}).message;

/** Sorts a pairing failure into the state the page shows for it. */
export function pairingErrorFromUnknown(error: unknown): PairingError {
  if (isPrimaryEnvironmentPairingCredentialRejectedError(error)) {
    return { kind: "rejected" };
  }
  if (isPrimaryEnvironmentPairingCredentialRequiredError(error)) {
    return { kind: "missing-token", message: error.message };
  }
  return pairingErrorFromMessage(errorMessageFromUnknown(error));
}

/** Bootstrap hands the route only a message, so match the rejection by its text. */
export function pairingErrorFromMessage(message: string): PairingError {
  return message === REJECTED_TOKEN_MESSAGE ? { kind: "rejected" } : { kind: "failed", message };
}

export function PairingRouteSurface({
  auth,
  initialErrorMessage,
  onAuthenticated,
}: {
  auth: AuthSessionState["auth"];
  initialErrorMessage?: string;
  onAuthenticated: () => void;
}) {
  const environment = usePrimaryEnvironmentSummary();
  const autoPairTokenRef = useRef<string | null>(peekPairingTokenFromUrl());
  const [credential, setCredential] = useState(() => autoPairTokenRef.current ?? "");
  const [pairingError, setPairingError] = useState<PairingError | null>(() =>
    initialErrorMessage ? pairingErrorFromMessage(initialErrorMessage) : null,
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const autoSubmitAttemptedRef = useRef(false);

  const submitCredential = useCallback(
    async (nextCredential: string) => {
      setIsSubmitting(true);
      setPairingError(null);

      const submitError = await submitServerAuthCredential(nextCredential).then(
        () => null,
        (error) => pairingErrorFromUnknown(error),
      );

      setIsSubmitting(false);

      if (submitError) {
        setPairingError(submitError);
        return;
      }

      startTransition(() => {
        onAuthenticated();
      });
    },
    [onAuthenticated],
  );

  const handleSubmit = useCallback(
    async (event?: React.SubmitEvent<HTMLFormElement>) => {
      event?.preventDefault();
      await submitCredential(credential);
    },
    [submitCredential, credential],
  );

  useEffect(() => {
    const token = autoPairTokenRef.current;
    if (!token || autoSubmitAttemptedRef.current) {
      return;
    }

    autoSubmitAttemptedRef.current = true;
    stripPairingTokenFromUrl();
    void submitCredential(token);
  }, [submitCredential]);

  const supportedMethodsNote = describeSupportedMethods(auth.bootstrapMethods);
  const status: PairingPanelStatus = isSubmitting
    ? { kind: "submitting" }
    : pairingError?.kind === "rejected"
      ? { kind: "rejected" }
      : pairingError?.kind === "failed"
        ? { kind: "failed", message: pairingError.message }
        : { kind: "ready" };

  return (
    <PairingPanel
      environment={environment}
      readyDescription={describeAuthGate(auth.bootstrapMethods)}
      status={status}
    >
      <PairingTokenForm
        credential={credential}
        fieldError={pairingError?.kind === "missing-token" ? pairingError.message : null}
        isSubmitting={isSubmitting}
        onCredentialChange={setCredential}
        onSubmit={(event) => void handleSubmit(event)}
        showReload={pairingError?.kind === "failed"}
        submitLabel={pairingError?.kind === "failed" ? "Try again" : "Pair this browser"}
        tokenLabel={pairingError?.kind === "rejected" ? "New pairing token" : "Pairing token"}
      />
      {supportedMethodsNote ? (
        <p className="mt-4 text-xs leading-relaxed text-muted-foreground">{supportedMethodsNote}</p>
      ) : null}
    </PairingPanel>
  );
}

export function PairingTokenForm({
  credential,
  fieldError,
  isSubmitting,
  onCredentialChange,
  onSubmit,
  showReload,
  submitLabel,
  tokenLabel,
}: {
  readonly credential: string;
  readonly fieldError: string | null;
  readonly isSubmitting: boolean;
  readonly onCredentialChange: (value: string) => void;
  readonly onSubmit: (event: React.SubmitEvent<HTMLFormElement>) => void;
  readonly showReload: boolean;
  readonly submitLabel: string;
  readonly tokenLabel: string;
}) {
  return (
    <form className="space-y-3" onSubmit={onSubmit}>
      <div className="space-y-1.5">
        <label className="text-sm font-medium" htmlFor="pairing-token">
          {tokenLabel}
        </label>
        <Input
          id="pairing-token"
          aria-describedby={fieldError ? "pairing-token-error" : undefined}
          aria-invalid={fieldError ? true : undefined}
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect="off"
          className="font-mono"
          disabled={isSubmitting}
          nativeInput
          onChange={(event) => onCredentialChange(event.currentTarget.value)}
          placeholder="Paste a token"
          spellCheck={false}
          value={credential}
        />
        {fieldError ? (
          <p className="text-xs text-destructive-foreground" id="pairing-token-error">
            {fieldError}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-2 pt-1">
        <Button className="w-full" disabled={isSubmitting} size="lg" type="submit">
          {isSubmitting ? (
            <>
              <Spinner className="size-4" />
              Pairing
            </>
          ) : (
            submitLabel
          )}
        </Button>
        {showReload ? (
          <Button
            className="w-full"
            disabled={isSubmitting}
            onClick={() => window.location.reload()}
            size="lg"
            variant="ghost"
          >
            Reload page
          </Button>
        ) : null}
      </div>
    </form>
  );
}

/**
 * Names the environment this page pairs with. The descriptor endpoint is
 * public, so it resolves before pairing; the address falls back to the page
 * host until then.
 */
function usePrimaryEnvironmentSummary(): PairingEnvironmentSummary {
  const [name, setName] = useState(() => readPrimaryEnvironmentDescriptor()?.label ?? null);

  useEffect(() => {
    if (name) {
      return;
    }
    let cancelled = false;
    resolveInitialPrimaryEnvironmentDescriptor().then(
      (descriptor) => {
        if (!cancelled) {
          setName(descriptor.label);
        }
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [name]);

  return { name, address: typeof window === "undefined" ? null : window.location.host || null };
}

function errorMessageFromUnknown(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return "Authentication failed.";
}

function describeAuthGate(bootstrapMethods: ReadonlyArray<string>): string {
  if (bootstrapMethods.includes("desktop-bootstrap")) {
    return "Paste the pairing credential from the desktop app to connect.";
  }

  return "Paste the pairing token from your link to connect.";
}

function describeSupportedMethods(bootstrapMethods: ReadonlyArray<string>): string | null {
  if (!bootstrapMethods.includes("desktop-bootstrap")) {
    return null;
  }

  if (bootstrapMethods.includes("one-time-token")) {
    return "This environment accepts desktop pairing and one-time pairing tokens.";
  }

  return "The desktop app manages this environment. Open it there, or paste a credential it issued.";
}
