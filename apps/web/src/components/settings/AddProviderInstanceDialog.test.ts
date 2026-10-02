import { describe, expect, it } from "vite-plus/test";

import {
  addAccountWizardSteps,
  deriveInstanceId,
  nextAccountNumber,
} from "./AddProviderInstanceDialog.logic";

describe("addAccountWizardSteps", () => {
  it("asks Custom API which service before naming it", () => {
    expect(addAccountWizardSteps({ choosesService: true })).toEqual(["Service", "Name", "Connect"]);
  });

  it("only names a subscription account", () => {
    expect(addAccountWizardSteps({ choosesService: false })).toEqual(["Name"]);
  });
});

describe("deriveInstanceId", () => {
  it("builds the id from the name", () => {
    expect(deriveInstanceId("codex", "Work Laptop!", new Set())).toBe("codex_work_laptop");
  });

  it("numbers an unnamed account", () => {
    expect(deriveInstanceId("codex", "  ", new Set(["codex"]))).toBe("codex_2");
    expect(deriveInstanceId("codex", "", new Set(["codex", "codex_2"]))).toBe("codex_3");
  });

  it("numbers the fallback name like the id", () => {
    expect(nextAccountNumber("claudeAgent", new Set(["claudeAgent_2"]))).toBe(3);
  });

  it("takes the first free suffix when the name is taken", () => {
    expect(
      deriveInstanceId(
        "customOpenai",
        "OpenRouter",
        new Set(["customOpenai_openrouter", "customOpenai_openrouter_2"]),
      ),
    ).toBe("customOpenai_openrouter_3");
  });

  it("keeps long names within the id length limit", () => {
    expect(deriveInstanceId("opencodeGo", "x".repeat(200), new Set()).length).toBeLessThanOrEqual(
      64,
    );
  });
});
