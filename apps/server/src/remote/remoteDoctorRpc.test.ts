// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { RemoteDoctorStatus } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { getRemoteDoctorStatus, repairRemoteDoctor } from "./remoteDoctorRpc.ts";

const withContainerHome = <A, E>(use: (baseDir: string) => Effect.Effect<A, E>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const prior = process.env.AKERU_REMOTE_CONTAINER;
      process.env.AKERU_REMOTE_CONTAINER = "1";
      const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-doctor-rpc-"));
      NodeFS.mkdirSync(NodePath.join(baseDir, "userdata"), { recursive: true });
      return { baseDir, prior };
    }),
    ({ baseDir }) => use(baseDir),
    ({ baseDir, prior }) =>
      Effect.sync(() => {
        if (prior === undefined) delete process.env.AKERU_REMOTE_CONTAINER;
        else process.env.AKERU_REMOTE_CONTAINER = prior;
        NodeFS.rmSync(baseDir, { recursive: true, force: true });
      }),
  );

it.effect("reports a local environment as not applicable without running checks", () =>
  Effect.gen(function* () {
    const status = yield* getRemoteDoctorStatus({ baseDir: "/nonexistent", remote: false });
    assert.deepEqual(status, { applicable: false, report: null });
  }),
);

it.effect("serializes a remote doctor report over the wire schema", () =>
  withContainerHome((baseDir) =>
    Effect.gen(function* () {
      const status = yield* getRemoteDoctorStatus({ baseDir, remote: true });
      assert.isTrue(status.applicable);
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(RemoteDoctorStatus))(status);
      const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(RemoteDoctorStatus))(
        encoded,
      );
      assert.deepEqual(decoded.report?.checks, status.report?.checks);
      assert.equal(typeof JSON.parse(encoded).report.generatedAt, "string");
    }),
  ),
);

it.effect("refuses repairs that are not offered", () =>
  withContainerHome((baseDir) =>
    Effect.gen(function* () {
      const notRemote = yield* Effect.flip(
        repairRemoteDoctor({ baseDir, remote: false, request: { checkIds: ["logs"] } }),
      );
      assert.equal(notRemote.reason, "not-remote");
      const notOffered = yield* Effect.flip(
        repairRemoteDoctor({ baseDir, remote: true, request: { checkIds: ["database"] } }),
      );
      assert.equal(notOffered.reason, "not-repairable");
    }),
  ),
);

it.effect("repairs a check the doctor offered", () =>
  withContainerHome((baseDir) =>
    Effect.gen(function* () {
      const bindingPath = NodePath.join(baseDir, "userdata", "remote-directory.json");
      NodeFS.writeFileSync(bindingPath, JSON.stringify({ endpointKind: "custom-https" }), {
        mode: 0o644,
      });
      const repaired = yield* repairRemoteDoctor({
        baseDir,
        remote: true,
        request: { checkIds: ["binding-permissions"] },
      });
      assert.deepEqual(repaired.report?.repairsApplied, ["binding-permissions"]);
      assert.equal(NodeFS.statSync(bindingPath).mode & 0o077, 0);
    }),
  ),
);
