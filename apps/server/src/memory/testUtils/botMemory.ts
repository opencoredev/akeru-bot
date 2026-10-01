// @effect-diagnostics nodeBuiltinImport:off globalDate:off preferSchemaOverJson:off

import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, assert } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import { vi } from "vite-plus/test";
import { BotId, GroupId } from "@akeru/contracts";
import { BotMemoryStore } from "../BotMemory.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), readFile: vi.fn(actual.readFile) };
});

const NodeFS = NodeFSP;

const directories: string[] = [];

// Replaces a held lock file with another owner's record, as a stale-lock
// recovery elsewhere would after deciding this owner was gone.
async function takeLockFromOwner(lockPath: string) {
  await NodeFS.unlink(lockPath);
  await NodeFS.writeFile(
    lockPath,
    JSON.stringify({
      pid: process.pid,
      token: "other-owner",
      heartbeatAtMs: DateTime.toEpochMillis(DateTime.nowUnsafe()),
    }),
    { mode: 0o600 },
  );
}

// Loses the next acquired memory lock to another owner right after it is created.
async function loseNextLock() {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(NodeFS.open).mockImplementationOnce(async (...args) => {
    const handle = await actual.open(...args);
    await takeLockFromOwner(String(args[0]));
    return handle;
  });
}

async function fixture() {
  const directory = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "akeru-bot-memory-"));
  directories.push(directory);
  return new BotMemoryStore(NodePath.join(directory, "userdata"));
}

const privateAccess = (bot = "bot-1") => ({
  botId: BotId.make(bot),
  groupId: null,
  groupMemberBotIds: [],
});

const groupAccess = (bot = "bot-1", group = "group-1") => ({
  botId: BotId.make(bot),
  groupId: GroupId.make(group),
  groupMemberBotIds: [BotId.make(bot)],
});

async function acceptPrompt(store: BotMemoryStore, botId: BotId, reviewed?: boolean) {
  const reservation = await store.reserveReviewCadence(botId);
  if (reviewed !== undefined) assert.equal(reservation.memoryReviewIncluded, reviewed);
  return store.settleReviewCadence(reservation, true);
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => NodeFS.rm(directory, { recursive: true })),
  );
});
export {
  NodeFS,
  directories,
  takeLockFromOwner,
  loseNextLock,
  fixture,
  privateAccess,
  groupAccess,
  acceptPrompt,
};
