import {
  Alert02Icon,
  BubbleChatIcon,
  ComputerTerminal01Icon,
  Link02Icon,
  Tick02Icon,
  Unlink02Icon,
} from "@hugeicons/core-free-icons";
import type { ReactNode } from "react";

import { AppIcon } from "../ui/app-icon";
import { Spinner } from "../ui/spinner";
import { cn } from "~/lib/utils";
import { AuthSurfaceSection, AuthSurfaceShell } from "./AuthSurfaceShell";

/**
 * Every state the pairing page can show.
 * - checking: the route is exchanging a token from the link.
 * - ready / submitting: waiting for, or sending, a pasted token.
 * - rejected: the server refused the token (expired, used, or mistyped).
 * - incomplete: a hosted link is missing its host or token.
 * - failed: anything else went wrong; `message` explains it.
 * - paired: the browser now has a session.
 */
export type PairingPanelStatus =
  | { readonly kind: "checking" }
  | { readonly kind: "ready" }
  | { readonly kind: "submitting" }
  | { readonly kind: "rejected" }
  | { readonly kind: "incomplete" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "paired" };

export interface PairingEnvironmentSummary {
  readonly name: string | null;
  readonly address: string | null;
}

type Tone = "neutral" | "danger" | "success";

const TONE_TILE_CLASS: Record<Tone, string> = {
  neutral: "bg-muted text-foreground/80",
  danger: "bg-destructive/10 text-destructive-foreground",
  success: "bg-success/12 text-success-foreground",
};

const PAIRING_GRANTS = [
  { icon: BubbleChatIcon, label: "Chat with your bots and start new work" },
  { icon: ComputerTerminal01Icon, label: "Run terminals and commands on this machine" },
] as const;

export const NEW_LINK_COMMAND = "npx akeru-bot pair";

function describeStatus(
  status: PairingPanelStatus,
  environmentName: string | null,
  readyDescription: string,
): { icon: typeof Link02Icon; tone: Tone; title: string; description: string } {
  switch (status.kind) {
    case "checking":
      return {
        icon: Link02Icon,
        tone: "neutral",
        title: "Pairing this browser",
        description: "Checking your pairing link.",
      };
    case "ready":
      return {
        icon: Link02Icon,
        tone: "neutral",
        title: "Pair this browser",
        description: readyDescription,
      };
    case "submitting":
      return {
        icon: Link02Icon,
        tone: "neutral",
        title: "Pairing this browser",
        description: "Connecting to the environment.",
      };
    case "rejected":
      return {
        icon: Unlink02Icon,
        tone: "danger",
        title: "This link no longer works",
        description:
          "Pairing links work once and expire after a while. Get a new link and open it on this device.",
      };
    case "incomplete":
      return {
        icon: Unlink02Icon,
        tone: "danger",
        title: "This link is incomplete",
        description:
          "It is missing the server address or the token. Copy the whole link and open it again.",
      };
    case "failed":
      return {
        icon: Alert02Icon,
        tone: "danger",
        title: "Pairing failed",
        description: status.message,
      };
    case "paired":
      return {
        icon: Tick02Icon,
        tone: "success",
        title: "Paired",
        description: `This browser can now use ${environmentName ?? "the environment"}.`,
      };
  }
}

/**
 * The pairing card. Pure: callers own the pairing flow and pass the actions
 * (form or buttons) as children.
 */
export function PairingPanel({
  status,
  environment,
  readyDescription = "Paste the pairing token from your link to connect.",
  children,
}: {
  readonly status: PairingPanelStatus;
  readonly environment: PairingEnvironmentSummary;
  readonly readyDescription?: string;
  readonly children?: ReactNode;
}) {
  const { icon, tone, title, description } = describeStatus(
    status,
    environment.name,
    readyDescription,
  );
  const showGrants =
    status.kind === "checking" || status.kind === "ready" || status.kind === "submitting";
  const hasEnvironment = environment.name !== null || environment.address !== null;

  return (
    <AuthSurfaceShell
      footer={
        <>
          Treat pairing links like passwords. You can remove this browser later in{" "}
          <span className="text-foreground/80">Settings &gt; Connections</span>.
        </>
      }
    >
      <AuthSurfaceSection className="pt-6 pb-5">
        <div
          aria-hidden
          className={cn(
            "flex size-10 items-center justify-center rounded-xl",
            TONE_TILE_CLASS[tone],
          )}
        >
          <AppIcon icon={icon} className="size-5" />
        </div>
        <h1 className="mt-4 text-xl font-semibold tracking-tight text-balance">{title}</h1>
        <p
          className="mt-1.5 flex items-center gap-2 text-sm leading-relaxed text-muted-foreground"
          role={tone === "danger" ? "alert" : undefined}
        >
          {status.kind === "checking" ? <Spinner className="size-3.5 shrink-0" /> : null}
          <span className="min-w-0 break-words">{description}</span>
        </p>
      </AuthSurfaceSection>

      {hasEnvironment ? (
        <AuthSurfaceSection>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 text-sm">
            {environment.name ? (
              <>
                <dt className="text-muted-foreground">Environment</dt>
                <dd className="truncate text-right font-medium">{environment.name}</dd>
              </>
            ) : null}
            {environment.address ? (
              <>
                <dt className="text-muted-foreground">Address</dt>
                <dd className="truncate text-right font-mono text-[13px] text-foreground/80">
                  {environment.address}
                </dd>
              </>
            ) : null}
          </dl>
        </AuthSurfaceSection>
      ) : null}

      {showGrants ? (
        <AuthSurfaceSection>
          <p className="text-xs font-medium text-muted-foreground">Pairing lets this browser</p>
          <ul className="mt-3 space-y-2.5">
            {PAIRING_GRANTS.map((grant) => (
              <li key={grant.label} className="flex items-center gap-3 text-sm">
                <AppIcon icon={grant.icon} className="size-4 shrink-0 text-muted-foreground" />
                <span>{grant.label}</span>
              </li>
            ))}
          </ul>
        </AuthSurfaceSection>
      ) : null}

      {status.kind === "rejected" ? (
        <AuthSurfaceSection>
          <p className="text-xs font-medium text-muted-foreground">Get a new link</p>
          <ol className="mt-3 space-y-2.5 text-sm">
            <li>
              On the server, run{" "}
              <code className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[13px]">
                {NEW_LINK_COMMAND}
              </code>
            </li>
            <li>Or, on a paired device, open Settings &gt; Connections and select Create link.</li>
          </ol>
        </AuthSurfaceSection>
      ) : null}

      {children ? <AuthSurfaceSection className="pb-5">{children}</AuthSurfaceSection> : null}
    </AuthSurfaceShell>
  );
}
