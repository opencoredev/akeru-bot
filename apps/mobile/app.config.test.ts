import * as NodeChildProcess from "node:child_process";
import { expect, it } from "vite-plus/test";

const configUrl = new URL("./app.config.ts", import.meta.url).href;

it.each([
  ["development", "Akeru Bot Dev", ["akeru-dev", "akeru"], "dev.leodoes.akeru.dev"],
  ["production", "Akeru Bot", ["akeru"], "dev.leodoes.akeru"],
  ["", "Akeru Bot", ["akeru"], "dev.leodoes.akeru"],
  ["preview", "Akeru Bot", ["akeru"], "dev.leodoes.akeru"],
  [" development ", "Akeru Bot", ["akeru"], "dev.leodoes.akeru"],
])(
  "resolves APP_VARIANT=%j without changing app identity",
  (appVariant, name, scheme, identifier) => {
    const output = NodeChildProcess.execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import config from ${JSON.stringify(configUrl)};
process.stdout.write(JSON.stringify({
  name: config.name,
  scheme: config.scheme,
  iosBundleIdentifier: config.ios.bundleIdentifier,
  androidPackage: config.android.package,
  appVariant: config.extra.appVariant,
}));`,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          APP_VARIANT: appVariant,
          T3CODE_IOS_PERSONAL_TEAM: "",
          T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID: "",
          AKERU_APPLE_TEAM_ID: "",
          AKERU_EXPO_PROJECT_ID: "",
          AKERU_EXPO_OWNER: "",
        },
      },
    );

    expect(output).toBe(
      JSON.stringify({
        name,
        scheme,
        iosBundleIdentifier: identifier,
        androidPackage: identifier,
        appVariant: appVariant === "development" ? "development" : "production",
      }),
    );
  },
);
