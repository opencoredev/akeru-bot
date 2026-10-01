import { describe, expect, it } from "vite-plus/test";
import { parseGitRemoteVerboseOutput } from "./GitOutput.ts";

describe("Git remote verbose output", () => {
  it("preserves distinct fetch/push URLs, multiple remotes, and the last entry", () => {
    expect([
      ...parseGitRemoteVerboseOutput(`
      origin\thttps://example.com/old.git (fetch)
      origin  https://example.com/read.git  (fetch)
      origin\tssh://example.com/write.git\t(push)
      upstream https://example.com/upstream.git (fetch)
      push-only ssh://example.com/push.git (push)
      malformed line
      origin missing-direction
    `),
    ]).toEqual([
      ["origin", { url: "https://example.com/read.git", pushUrl: "ssh://example.com/write.git" }],
      ["upstream", { url: "https://example.com/upstream.git" }],
      ["push-only", { pushUrl: "ssh://example.com/push.git" }],
    ]);
  });
  it("ignores empty and malformed output", () => {
    expect(parseGitRemoteVerboseOutput("\nnot a remote\nname url (unknown)\n").size).toBe(0);
  });
});
