import { BotId, EnvironmentId, type OrchestrationBot } from "@akeru/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { makeMobileBot } from "../lib/mobile-fixtures.test-support";
import { environmentBotsAtom } from "./bots";
import { useThreadEngineBot } from "./use-thread-engine-bot";

const state = vi.hoisted(() => ({ bots: [] as ReadonlyArray<OrchestrationBot> }));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.bots }));

vi.mock("react", () => ({ useMemo: <T>(factory: () => T) => factory() }));

vi.mock("./bots", () => ({ environmentBotsAtom: vi.fn(() => ({})) }));

beforeEach(() => {
  state.bots = [];
  vi.clearAllMocks();
});

describe("composer engine bot lookup", () => {
  it("loads and renders without a selected environment", () => {
    expect(useThreadEngineBot(undefined, undefined)).toBeNull();
    expect(environmentBotsAtom).not.toHaveBeenCalled();
  });

  it("looks up the direct chat bot in the selected environment", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const bot = makeMobileBot({ id: BotId.make("scout"), archivedAt: null });
    state.bots = [bot];

    expect(useThreadEngineBot(environmentId, { botId: bot.id, groupId: null })).toBe(bot);
    expect(environmentBotsAtom).toHaveBeenCalledWith(environmentId);
  });
});
