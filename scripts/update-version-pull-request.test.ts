import { describe, expect, it } from "vite-plus/test";

import {
  isRecoverableVersionRequestFailure,
  nextPatchVersion,
  renderVersionPullRequestBody,
} from "./update-version-pull-request.ts";

describe("version pull request automation", () => {
  it("renders every merged pull request in the next patch release", () => {
    const body = renderVersionPullRequestBody("0.0.38", [
      { number: 141, title: "fix(web): mute routine notices" },
      { number: 163, title: "feat(marketing): add Grok search pages" },
    ]);

    expect(body).toContain("Prepare Akeru Bot v0.0.39.");
    expect(body).toContain("[#141](https://github.com/opencoredev/akeru-bot/pull/141)");
    expect(body).toContain("[#163](https://github.com/opencoredev/akeru-bot/pull/163)");
    expect(body).toContain("`akeru-bot`: `0.0.38` → `0.0.39`");
  });

  it("increments only stable patch versions", () => {
    expect(nextPatchVersion("1.2.9")).toBe("1.2.10");
    expect(() => nextPatchVersion("1.2.3-beta.1")).toThrow("Stable release version is invalid");
  });

  it("recovers only from version pull request creation conflicts", () => {
    expect(
      isRecoverableVersionRequestFailure(
        'Plugin "github:version-request" failed:\nA pull request already exists',
      ),
    ).toBe(true);
    expect(
      isRecoverableVersionRequestFailure(
        'Plugin "github:version-request" failed: GitHub Actions is not permitted to create or approve pull requests',
      ),
    ).toBe(true);
    expect(isRecoverableVersionRequestFailure("Tegami failed to push the version branch")).toBe(
      false,
    );
  });
});
