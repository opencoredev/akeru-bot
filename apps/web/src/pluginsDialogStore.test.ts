import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  closePlugins,
  isLegacyPluginsPath,
  openPlugins,
  usePluginsDialogStore,
} from "./pluginsDialogStore";

afterEach(closePlugins);

describe("plugins dialog store", () => {
  it("opens and closes independently from settings", () => {
    expect(usePluginsDialogStore.getState().open).toBe(false);
    openPlugins();
    expect(usePluginsDialogStore.getState().open).toBe(true);
    closePlugins();
    expect(usePluginsDialogStore.getState().open).toBe(false);
  });

  it("opens with a search from an inline recommendation", () => {
    openPlugins("Gmail");

    expect(usePluginsDialogStore.getState()).toMatchObject({
      open: true,
      requestedQuery: "Gmail",
    });
  });

  it("recognizes the old Settings plugins path", () => {
    expect(isLegacyPluginsPath("/settings/plugins")).toBe(true);
    expect(isLegacyPluginsPath("/settings/providers")).toBe(false);
  });
});
