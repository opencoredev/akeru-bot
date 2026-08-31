import { createFileRoute } from "@tanstack/react-router";

/** Let the parent Settings route handle legacy nested deep links. */
export const Route = createFileRoute("/settings/$")({});
