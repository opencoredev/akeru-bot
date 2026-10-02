import { type OrchestrationLatestTurn } from "@akeru/contracts";
import type { Thread } from "../types";

type LatestTurnTiming = Pick<OrchestrationLatestTurn, "turnId" | "startedAt" | "completedAt">;

type SessionActivityState = Pick<NonNullable<Thread["session"]>, "status" | "activeTurnId">;

export function isLatestTurnSettled(
  latestTurn: LatestTurnTiming | null,
  session: SessionActivityState | null,
): boolean {
  if (!latestTurn?.startedAt) return false;

  if (!latestTurn.completedAt) return false;

  if (!session) return true;

  if (session.status === "running") return false;

  return true;
}

export function deriveActiveWorkStartedAt(
  latestTurn: LatestTurnTiming | null,
  session: SessionActivityState | null,
  sendStartedAt: string | null,
  latestUserMessageAt: string | null = null,
): string | null {
  const runningTurnId = session?.status === "running" ? session.activeTurnId : null;

  if (runningTurnId !== null) {
    if (latestTurn?.turnId === runningTurnId) {
      return latestTurn.startedAt ?? sendStartedAt ?? latestUserMessageAt;
    }

    return sendStartedAt ?? latestUserMessageAt;
  }

  if (!isLatestTurnSettled(latestTurn, session)) {
    return latestTurn?.startedAt ?? sendStartedAt;
  }

  return sendStartedAt;
}
