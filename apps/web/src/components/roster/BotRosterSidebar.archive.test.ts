import { describe, expect, it } from "vite-plus/test";

import { focusTargetAfterRosterArchive, runCreateBotOnce } from "./BotRosterSidebar";

describe("focusTargetAfterRosterArchive", () => {
  const rows = ["bot:one", "group:team", "bot:two"];

  it("hands focus to the row that takes the archived one's place", () => {
    expect(focusTargetAfterRosterArchive(rows, "bot:one")).toBe("group:team");
    expect(focusTargetAfterRosterArchive(rows, "group:team")).toBe("bot:two");
  });

  it("falls back to the row above when the archived one was last", () => {
    expect(focusTargetAfterRosterArchive(rows, "bot:two")).toBe("group:team");
  });

  it("gives up on the roster region when no row survives", () => {
    expect(focusTargetAfterRosterArchive(["bot:one"], "bot:one")).toBe(null);
    expect(focusTargetAfterRosterArchive([], "bot:one")).toBe(null);
  });

  it("starts at the top when the archived row is already gone from the list", () => {
    expect(focusTargetAfterRosterArchive(rows, "bot:missing")).toBe("bot:one");
  });
});

describe("runCreateBotOnce", () => {
  /** A create command that stays pending until the test releases it. */
  function pendingCreate() {
    const releases: Array<() => void> = [];
    let calls = 0;
    const create = () => {
      calls += 1;
      return new Promise<void>((resolve) => releases.push(resolve));
    };
    return {
      create,
      get calls() {
        return calls;
      },
      releaseAll: () => {
        for (const release of releases) release();
      },
    };
  }

  it("ignores a second submit while the first create is still in flight", async () => {
    const inFlight = { current: false };
    const command = pendingCreate();

    const first = runCreateBotOnce(inFlight, command.create);
    const second = runCreateBotOnce(inFlight, command.create);

    expect(command.calls).toBe(1);

    command.releaseAll();
    await Promise.all([first, second]);

    expect(command.calls).toBe(1);
  });

  it("accepts the next submit once the create settles", async () => {
    const inFlight = { current: false };
    const command = pendingCreate();

    const first = runCreateBotOnce(inFlight, command.create);
    command.releaseAll();
    await first;

    const second = runCreateBotOnce(inFlight, command.create);
    expect(command.calls).toBe(2);

    command.releaseAll();
    await second;
    expect(inFlight.current).toBe(false);
  });

  it("reopens the latch when the create throws", async () => {
    const inFlight = { current: false };
    let calls = 0;
    const create = () => {
      calls += 1;
      return Promise.reject(new Error("environment rejected the change"));
    };

    await expect(runCreateBotOnce(inFlight, create)).rejects.toThrow(
      "environment rejected the change",
    );
    expect(inFlight.current).toBe(false);

    await expect(runCreateBotOnce(inFlight, create)).rejects.toThrow(
      "environment rejected the change",
    );
    expect(calls).toBe(2);
  });
});
