import { runCli } from "tegami/cli";
import { tegami } from "tegami";
import { github } from "tegami/plugins/github";

export const releasePackageNames = [
  "akeru-bot",
  "@t3tools/contracts",
  "@t3tools/desktop",
  "@t3tools/web",
] as const;

export const release = tegami({
  groups: {
    akeru: {
      syncBump: true,
      syncGitTag: true,
    },
  },
  packages: {
    "akeru-bot": { group: "akeru" },
    "@t3tools/contracts": { group: "akeru" },
    "@t3tools/desktop": { group: "akeru" },
    "@t3tools/web": { group: "akeru" },
  },
  plugins: [
    github({
      repo: "opencoredev/akeru-bot",
      release: false,
      createTags: false,
      versionPr: {
        base: "main",
        branch: "tegami/version-packages",
      },
    }),
  ],
});

if (import.meta.main) {
  await runCli(release);
}
