import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/connect")({
  beforeLoad: () => {
    throw redirect({ to: "/", replace: true });
  },
});
