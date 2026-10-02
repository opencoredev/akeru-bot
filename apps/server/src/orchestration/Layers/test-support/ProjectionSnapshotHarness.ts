import {
  AkeruDelegationRecord,
  CheckpointRef,
  EventId,
  MessageId,
  ProjectId,
  TurnId,
} from "@akeru/contracts";
import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../../project/RepositoryIdentityResolver.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../../ThreadPlanProgress.ts";

export const asProjectId = (value: string): ProjectId => ProjectId.make(value);

export const asTurnId = (value: string): TurnId => TurnId.make(value);

export const asMessageId = (value: string): MessageId => MessageId.make(value);

export const asEventId = (value: string): EventId => EventId.make(value);

export const asCheckpointRef = (value: string): CheckpointRef => CheckpointRef.make(value);

export const decodeDelegationRecord = Schema.decodeUnknownEffect(AkeruDelegationRecord);

export const encodeDelegationRecordJson = Schema.encodeEffect(
  Schema.fromJsonString(AkeruDelegationRecord),
);

export const projectionSnapshotLayer = it.layer(
  OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  ),
);
