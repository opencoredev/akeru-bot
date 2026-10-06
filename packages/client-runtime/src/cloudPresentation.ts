import type { CloudLinkStatus } from "@akeru/contracts";

/** Akeru Cloud copy shared by the web and mobile settings screens. */
export const CLOUD_COPY = {
  title: "Akeru Cloud",
  explainer:
    "Optional. Link your environment to an Akeru Cloud account for hosted services. Chats, keys, and files stay on your environment.",
  connect: "Connect Akeru Cloud",
  connectAgain: "Connect again",
  openVerification: "Open Akeru Cloud",
  enterCode: "Enter this code in Akeru Cloud to approve this environment.",
  waiting: "Waiting for approval…",
  cancel: "Cancel",
  account: "Account",
  connection: "Connection",
  hostedServices: "Hosted services",
  forget: "Forget this link",
  forgetConfirmTitle: "Forget this link locally?",
  forgetConfirmBody:
    "This removes credentials from this environment and stops reconnecting. Akeru Cloud may still list this environment until you revoke it there.",
  disconnect: "Disconnect",
  disconnectConfirmTitle: "Disconnect Akeru Cloud?",
  disconnectConfirmBody:
    "This environment forgets its Akeru Cloud link. Hosted services such as Slack stop reaching your bots until you connect again.",
  revoked: "This environment was disconnected from Akeru Cloud.",
} as const;

export type CloudConnectionTone = "connected" | "connecting" | "offline";

export interface CloudHostedServiceRow {
  readonly id: "slack";
  readonly label: string;
  readonly detail: string;
}

export const CLOUD_HOSTED_SERVICES: ReadonlyArray<CloudHostedServiceRow> = [
  { id: "slack", label: "Slack", detail: "Hosted Slack setup is coming." },
];

export type CloudViewModel =
  | { readonly kind: "loading" }
  | { readonly kind: "unlinked" }
  | {
      readonly kind: "linking";
      readonly userCode: string;
      readonly verificationUrl: string;
      readonly expiresAt: string;
    }
  | {
      readonly kind: "linked";
      readonly email: string;
      readonly connectionLabel: string;
      readonly connectionTone: CloudConnectionTone;
    }
  | { readonly kind: "revoked" };

export function cloudConnectionLabel(connection: CloudConnectionTone): string {
  switch (connection) {
    case "connected":
      return "Connected";
    case "connecting":
      return "Connecting";
    case "offline":
      return "Offline";
  }
}

/** Maps the environment's link status to what a settings screen renders. `null` means not loaded yet. */
export function cloudViewModel(status: CloudLinkStatus | null): CloudViewModel {
  if (status === null) return { kind: "loading" };

  switch (status.status) {
    case "unlinked":
      return { kind: "unlinked" };
    case "linking":
      return {
        kind: "linking",
        userCode: status.userCode,
        verificationUrl: status.verificationUrl,
        expiresAt: status.expiresAt,
      };
    case "linked":
      return {
        kind: "linked",
        email: status.account.email,
        connectionLabel: cloudConnectionLabel(status.connection),
        connectionTone: status.connection,
      };
    case "revoked":
      return { kind: "revoked" };
  }
}

/** The status line shown next to Akeru Cloud in a settings list. */
export function cloudSummaryLabel(view: CloudViewModel): string {
  switch (view.kind) {
    case "loading":
      return "";
    case "unlinked":
      return "Not connected";
    case "linking":
      return "Waiting for approval";
    case "linked":
      return view.connectionLabel;
    case "revoked":
      return "Disconnected";
  }
}
