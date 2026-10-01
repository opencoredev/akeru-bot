import type { OrchestrationSessionStatus } from "@akeru/contracts";

export function settledTurnStateForSessionStatus(
  status: OrchestrationSessionStatus,
): "completed" | "interrupted" | "error" | null {
  switch (status) {
    case "idle":
    case "ready":
      return "completed";
    case "error":
      return "error";
    case "interrupted":
    case "stopped":
      return "interrupted";
    case "starting":
    case "running":
      return null;
  }
}
