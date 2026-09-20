import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { T3_PROJECT_FILE_SCHEMA_URL, T3ProjectFile } from "./t3ProjectFile.ts";

const decode = Schema.decodeUnknownSync(T3ProjectFile);

describe("T3ProjectFile", () => {
  it("decodes a full project file", () => {
    const decoded = decode({
      $schema: T3_PROJECT_FILE_SCHEMA_URL,
      iconPath: "assets/logo.svg",
      scripts: [
        {
          name: "Dev",
          command: "pnpm dev",
          icon: "play",
          runOnWorktreeCreate: false,
          previewUrl: "http://localhost:3000",
          autoOpenPreview: true,
        },
        { name: "Test", command: "pnpm test" },
      ],
    });

    expect(decoded.iconPath).toBe("assets/logo.svg");
    expect(decoded.scripts).toHaveLength(2);
    expect(decoded.scripts?.[1]).toEqual({ name: "Test", command: "pnpm test" });
  });

  it("treats $schema as informational and still decodes the legacy t3.codes URL", () => {
    expect(T3_PROJECT_FILE_SCHEMA_URL).toBe("https://www.akeru-bot.com/v1/schema/t3.json");
    expect(decode({ $schema: T3_PROJECT_FILE_SCHEMA_URL }).$schema).toBe(T3_PROJECT_FILE_SCHEMA_URL);
    expect(decode({ $schema: "https://t3.codes/schema/t3.json" }).$schema).toBe(
      "https://t3.codes/schema/t3.json",
    );
  });

  it("decodes an empty object and ignores unknown fields", () => {
    expect(decode({})).toEqual({});
    expect(decode({ futureField: true })).toEqual({});
  });

  it("trims icon paths and script fields", () => {
    const decoded = decode({
      iconPath: " assets/logo.svg ",
      scripts: [{ name: " Dev ", command: " pnpm dev " }],
    });

    expect(decoded.iconPath).toBe("assets/logo.svg");
    expect(decoded.scripts?.[0]).toEqual({ name: "Dev", command: "pnpm dev" });
  });

  it("rejects scripts without a command", () => {
    expect(() => decode({ scripts: [{ name: "Dev" }] })).toThrow();
  });

  it("rejects unknown script icons", () => {
    expect(() =>
      decode({ scripts: [{ name: "Dev", command: "pnpm dev", icon: "rocket" }] }),
    ).toThrow();
  });

  it("decodes defaultThreadEnvMode and rejects unknown modes", () => {
    expect(decode({ defaultThreadEnvMode: "worktree" }).defaultThreadEnvMode).toBe("worktree");
    expect(decode({ defaultThreadEnvMode: "local" }).defaultThreadEnvMode).toBe("local");
    expect(() => decode({ defaultThreadEnvMode: "remote" })).toThrow();
  });
});
