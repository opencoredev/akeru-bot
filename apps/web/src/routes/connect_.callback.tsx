import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/connect_/callback")({
  beforeLoad: () => {
    throw redirect({ to: "/", replace: true });
  },
});
