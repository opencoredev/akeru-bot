import { CLOUD_PROTOCOL_VERSION } from "@akeru/contracts";

import type { CloudHono } from "../../deps.ts";

export function registerHealth(app: CloudHono) {
  app.get("/v1/health", (c) => c.json({ ok: true, protocolVersion: CLOUD_PROTOCOL_VERSION }));
}
