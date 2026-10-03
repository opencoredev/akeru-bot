import { ProviderInstanceId } from "@akeru/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  addAccountWizardSteps,
  deriveInstanceId,
  isSubmitEnter,
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

  it("skips a number whose name another account already shows", () => {
    // "ChatGPT 2" was typed by hand, so its id is codex_chatgpt_2, not codex_2.
    const nameTaken = (index: number) => index === 2;
    const existing = new Set(["codex", "codex_chatgpt_2"]);

    expect(nextAccountNumber("codex", existing, nameTaken)).toBe(3);
    expect(deriveInstanceId("codex", "", existing, nameTaken)).toBe("codex_3");
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

  it("keeps long names valid even after many collisions", () => {
    const label = "x".repeat(200);
    const first = deriveInstanceId("customOpenai", label, new Set());
    const taken = new Set([first, ...Array.from({ length: 98 }, (_, i) => `${first}_${i + 2}`)]);
    const id = deriveInstanceId("customOpenai", label, taken);

    expect(id).toBe(`${first}_100`);
    expect(ProviderInstanceId.make(id)).toBe(id);
  });
});

describe("isSubmitEnter", () => {
  it("submits on a plain Enter", () => {
    expect(isSubmitEnter({ key: "Enter", keyCode: 13, isComposing: false })).toBe(true);
  });

  it("ignores Enter that confirms an IME candidate", () => {
    expect(isSubmitEnter({ key: "Enter", keyCode: 13, isComposing: true })).toBe(false);
    expect(isSubmitEnter({ key: "Process", keyCode: 229, isComposing: false })).toBe(false);
  });

  it("ignores other keys", () => {
    expect(isSubmitEnter({ key: "a", keyCode: 65, isComposing: false })).toBe(false);
  });
});
