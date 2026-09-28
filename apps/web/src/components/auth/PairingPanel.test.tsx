import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { PairingPanel, type PairingPanelStatus } from "./PairingPanel";
import {
  pairingErrorFromMessage,
  pairingErrorFromUnknown,
  PairingTokenForm,
} from "./PairingRouteSurface";
import { PrimaryEnvironmentPairingCredentialRejectedError } from "../../environments/primary";
import { PrimaryEnvironmentPairingCredentialRequiredError } from "../../environments/primary/auth";

const environment = { name: "Leo's workstation", address: "ms-a2.tail.ts.net:3773" };

function renderPanel(status: PairingPanelStatus, children?: React.ReactNode): string {
  return renderToStaticMarkup(
    <PairingPanel environment={environment} status={status}>
      {children}
    </PairingPanel>,
  );
}

function renderForm(overrides: Partial<Parameters<typeof PairingTokenForm>[0]> = {}): string {
  return renderToStaticMarkup(
    <PairingTokenForm
      credential=""
      fieldError={null}
      isSubmitting={false}
      onCredentialChange={() => undefined}
      onSubmit={() => undefined}
      showReload={false}
      submitLabel="Pair this browser"
      tokenLabel="Pairing token"
      {...overrides}
    />,
  );
}

describe("PairingPanel", () => {
  it("names the environment and lists what pairing grants before pairing", () => {
    const html = renderPanel({ kind: "ready" });

    expect(html).toContain("Pair this browser");
    expect(html).toContain("Leo&#x27;s workstation");
    expect(html).toContain("ms-a2.tail.ts.net:3773");
    expect(html).toContain("Pairing lets this browser");
    expect(html).toContain("Run terminals and commands on this machine");
    expect(html).toContain("Settings &gt; Connections");
  });

  it("shows progress while the link is checked", () => {
    const html = renderPanel({ kind: "checking" });

    expect(html).toContain("Checking your pairing link.");
    expect(html).toContain('role="status"');
  });

  it("explains how to get a new link when the token is rejected", () => {
    const html = renderPanel({ kind: "rejected" });

    expect(html).toContain("This link no longer works");
    expect(html).toContain("npx akeru-bot pair");
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("Pairing lets this browser");
  });

  it("shows the failure message", () => {
    const html = renderPanel({ kind: "failed", message: "Server unreachable." });

    expect(html).toContain("Pairing failed");
    expect(html).toContain("Server unreachable.");
  });

  it("confirms success with the environment name", () => {
    const html = renderPanel({ kind: "paired" });

    expect(html).toContain("This browser can now use Leo&#x27;s workstation.");
  });

  it("flags a hosted link with no host or token", () => {
    const html = renderToStaticMarkup(
      <PairingPanel environment={{ name: null, address: null }} status={{ kind: "incomplete" }} />,
    );

    expect(html).toContain("This link is incomplete");
    expect(html).not.toContain("Address");
  });
});

describe("PairingTokenForm", () => {
  it("offers a primary pair action", () => {
    const html = renderForm();

    expect(html).toContain("Pairing token");
    expect(html).toContain("Pair this browser");
    expect(html).not.toContain("Reload page");
  });

  it("disables input and shows progress while submitting", () => {
    const html = renderForm({ isSubmitting: true });

    expect(html).toContain("Pairing");
    expect(html).toContain('role="status"');
    expect(html).toMatch(/<input[^>]*disabled/);
  });

  it("offers retry and reload after a failure", () => {
    const html = renderForm({ showReload: true, submitLabel: "Try again" });

    expect(html).toContain("Try again");
    expect(html).toContain("Reload page");
  });

  it("marks an empty token inline", () => {
    const html = renderForm({ fieldError: "Enter a pairing token to continue." });

    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain("Enter a pairing token to continue.");
  });
});

describe("pairing error classification", () => {
  it("treats a rejected credential as an expired or used link", () => {
    const rejected = new PrimaryEnvironmentPairingCredentialRejectedError({
      providedLength: 4,
      cause: null,
    });

    expect(pairingErrorFromUnknown(rejected)).toEqual({ kind: "rejected" });
    expect(pairingErrorFromMessage(rejected.message)).toEqual({ kind: "rejected" });
  });

  it("keeps an empty token as an inline field error", () => {
    const required = new PrimaryEnvironmentPairingCredentialRequiredError({ providedLength: 0 });

    expect(pairingErrorFromUnknown(required)).toEqual({
      kind: "missing-token",
      message: required.message,
    });
  });

  it("keeps other messages as failures", () => {
    expect(pairingErrorFromMessage("Timed out.")).toEqual({
      kind: "failed",
      message: "Timed out.",
    });
    expect(pairingErrorFromUnknown(new Error("Boom"))).toEqual({
      kind: "failed",
      message: "Boom",
    });
  });
});
