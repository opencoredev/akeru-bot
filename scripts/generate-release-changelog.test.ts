import { describe, expect, it } from "vite-plus/test";

import { parseReleaseChanges, renderReleaseChangelog } from "./generate-release-changelog.ts";

describe("stable release changelog", () => {
  it("lists each merged pull request once and ignores non-PR commits", () => {
    const changes = parseReleaseChanges(
      [
        "feat(server): add durable bots (#81)",
        "t3 checkpoint ref=hidden",
        "fix(release): verify assets (#92)",
        "fix(release): duplicate merge record (#92)",
      ].join("\n"),
    );

    expect(changes).toEqual([
      {
        number: 81,
        title: "feat(server): add durable bots",
      },
      {
        number: 92,
        title: "fix(release): verify assets",
      },
    ]);

    const changelog = renderReleaseChangelog(changes);
    expect(changelog.match(/pull\/81/g)).toHaveLength(1);
    expect(changelog.match(/pull\/92/g)).toHaveLength(1);
    expect(changelog).not.toContain("checkpoint");
    expect(changelog).toContain("group:akeru:");
  });

  it("uses one stable patch bump for the Akeru release group", () => {
    const changelog = renderReleaseChangelog([{ number: 81, title: "feat: add durable bots" }]);

    expect(changelog).toContain("packages:\n  group:akeru:\n    type: patch");
    expect(changelog).toContain("[#81](https://github.com/opencoredev/akeru-bot/pull/81)");
  });
});
