import { describe, expect, it } from "vite-plus/test";

import { describeCommandApproval } from "./commandApprovalDetails";

describe("describeCommandApproval", () => {
  it("reports no details for a short safe command so the row hides its expander", () => {
    const details = describeCommandApproval("pwd", { command: "pwd" });

    expect(details.hasDetails).toBe(false);
    expect(details.programs).toEqual(["pwd"]);
    expect(details.signals).toEqual([]);
    expect(details.workingDirectory).toBeNull();
    expect(details.reason).toBeNull();
  });

  it("reads the folder and reason the provider sent", () => {
    const details = describeCommandApproval("ls", {
      command: "ls",
      cwd: "/tmp/work",
      justification: "List the build output",
    });

    expect(details.workingDirectory).toBe("/tmp/work");
    expect(details.reason).toBe("List the build output");
    expect(details.hasDetails).toBe(true);
  });

  it("names every program in a chained command", () => {
    const details = describeCommandApproval(
      "cd apps/web && NODE_ENV=test bun run build | tee log",
      {
        command: "x",
      },
    );

    expect(details.programs).toEqual(["cd", "bun", "tee"]);
    expect(details.hasDetails).toBe(true);
  });

  it("flags the effects that change a review decision", () => {
    expect(describeCommandApproval("sudo rm -rf build", {}).signals).toEqual([
      "Runs as root",
      "Deletes files",
    ]);
    expect(describeCommandApproval("curl https://example.com > out.txt", {}).signals).toEqual([
      "Network access",
      "Writes files",
    ]);
    expect(describeCommandApproval("git push origin main", {}).signals).toEqual(["Publishes"]);
    expect(describeCommandApproval("chmod +x run.sh", {}).signals).toEqual(["Changes permissions"]);
  });

  it("treats a multi-line or long command as worth expanding", () => {
    expect(describeCommandApproval("echo one\necho two", {}).hasDetails).toBe(true);
    expect(describeCommandApproval(`echo ${"x".repeat(80)}`, {}).hasDetails).toBe(true);
  });
});
