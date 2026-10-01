import type { BotBrowser } from "../browser/BotBrowserTypes.ts";
import type { AkeruSessionResourcesOptions, BrowserAttribution } from "./AkeruSessionResourceTypes.ts";

export class SharedBotBrowsers {
 private readonly options: Pick<AkeruSessionResourcesOptions, "onBrowserFailure" | "onBrowserReady">;
 constructor(options: Pick<AkeruSessionResourcesOptions, "onBrowserFailure" | "onBrowserReady">) { this.options = options; }
readonly threadBrowsers = new Map<string, BotBrowser>();

readonly browserResourceKeys = new Map<string, string>();

readonly resourceBrowsers = new Map<string, BotBrowser>();

readonly browserReferences = new Map<string, number>();

readonly browserDestroyRequests = new Set<string>();

readonly browserReconnects = new Map<string, Promise<void>>();

readonly browserAttributions = new Map<string, Map<string, BrowserAttribution>>();

readonly browserFailures = new Map<string, string>();

readonly browserThreadBots = new Map<string, string>();

async invalidateBrowser(resourceKey: string, browser: BotBrowser): Promise<void> {
    if (this.resourceBrowsers.get(resourceKey) !== browser) return;
    this.resourceBrowsers.delete(resourceKey);
    this.browserReferences.delete(resourceKey);
    this.browserDestroyRequests.delete(resourceKey);
    this.browserAttributions.delete(resourceKey);
    for (const [threadId, key] of this.browserResourceKeys) {
      if (key !== resourceKey) continue;
      this.browserResourceKeys.delete(threadId);
      this.threadBrowsers.delete(threadId);
      this.browserThreadBots.delete(threadId);
    }
    await browser.close().catch(() => undefined);
  }

reportBrowserFailure(resourceKey: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    this.browserFailures.set(resourceKey, detail);
    for (const attribution of this.browserAttributions.get(resourceKey)?.values() ?? []) {
      this.options.onBrowserFailure?.({ ...attribution, resourceKey, detail });
    }
  }

resolveBrowserFailures(resourceKey: string): void {
    this.browserFailures.delete(resourceKey);
    for (const attribution of this.browserAttributions.get(resourceKey)?.values() ?? []) {
      this.options.onBrowserReady?.(attribution.botId, resourceKey);
    }
  }
}
