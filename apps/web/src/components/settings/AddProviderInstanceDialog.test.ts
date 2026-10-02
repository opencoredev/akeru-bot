import { describe, expect, it } from "vite-plus/test";

import { addAccountWizardSteps, resolveWizardNavigation } from "./AddProviderInstanceDialog.logic";

describe("addAccountWizardSteps", () => {
  it("asks Custom API which service before naming it", () => {
    expect(addAccountWizardSteps({ choosesService: true, hasSettings: true })).toEqual([
      "Service",
      "Name",
      "Connect",
    ]);
  });

  it("never asks which provider", () => {
    expect(addAccountWizardSteps({ choosesService: false, hasSettings: true })).toEqual([
      "Name",
      "Settings",
    ]);
    expect(addAccountWizardSteps({ choosesService: false, hasSettings: false })).toEqual(["Name"]);
  });
});

describe("resolveWizardNavigation", () => {
  const invalidId = { instanceIdError: "Account ID is required." };
  const validId = { instanceIdError: null };
  const customApi = addAccountWizardSteps({ choosesService: true, hasSettings: true });
  const provider = addAccountWizardSteps({ choosesService: false, hasSettings: true });

  it("allows moving from Service to Name before the account id is valid", () => {
    expect(resolveWizardNavigation(0, 1, customApi, invalidId)).toEqual({
      kind: "navigate",
      step: 1,
    });
  });

  it("blocks Next from Name while the account id is invalid", () => {
    expect(resolveWizardNavigation(1, 2, customApi, invalidId)).toEqual({
      kind: "blocked",
      step: 1,
      error: "Account ID is required.",
    });
    expect(resolveWizardNavigation(0, 1, provider, invalidId)).toEqual({
      kind: "blocked",
      step: 0,
      error: "Account ID is required.",
    });
  });

  it("stops a direct Service-to-Connect skip at Name and surfaces its error", () => {
    expect(resolveWizardNavigation(0, 2, customApi, invalidId)).toEqual({
      kind: "blocked",
      step: 1,
      error: "Account ID is required.",
    });
  });

  it("allows advancing and skipping forward once the account id is valid", () => {
    expect(resolveWizardNavigation(1, 2, customApi, validId)).toEqual({
      kind: "navigate",
      step: 2,
    });
    expect(resolveWizardNavigation(0, 2, customApi, validId)).toEqual({
      kind: "navigate",
      step: 2,
    });
  });

  it("always preserves backward navigation", () => {
    expect(resolveWizardNavigation(2, 1, customApi, invalidId)).toEqual({
      kind: "navigate",
      step: 1,
    });
    expect(resolveWizardNavigation(2, 0, customApi, invalidId)).toEqual({
      kind: "navigate",
      step: 0,
    });
    expect(resolveWizardNavigation(1, 0, provider, invalidId)).toEqual({
      kind: "navigate",
      step: 0,
    });
  });

  it("clamps requested steps to the wizard bounds", () => {
    expect(resolveWizardNavigation(2, 8, customApi, validId)).toEqual({
      kind: "navigate",
      step: 2,
    });
    expect(resolveWizardNavigation(0, -1, customApi, invalidId)).toEqual({
      kind: "navigate",
      step: 0,
    });
  });
});
