import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as RcMap from "effect/RcMap";
import { HttpBody, HttpClient, HttpClientResponse } from "effect/unstable/http";
import { chromium } from "playwright-core";
import type { ServerSettingsService } from "../serverSettings.ts";

export const DEFAULT_VIEWPORT = { width: 1280, height: 800 } as const;

export class BrowserConfigurationError extends Schema.TaggedErrorClass<BrowserConfigurationError>()(
  "BrowserConfigurationError",
  { message: Schema.String },
) {}

const BrowserbaseSession = Schema.Struct({
  connectUrl: Schema.NonEmptyString.check(
    Schema.makeFilter((value) => {
      try {
        return ["https:", "http:", "wss:", "ws:"].includes(new URL(value).protocol);
      } catch {
        return false;
      }
    }),
  ),
});
const decodeSession = Schema.decodeUnknownEffect(BrowserbaseSession);
export const decodeBrowserbaseSession = (value: unknown) =>
  decodeSession(value).pipe(
    Effect.mapError(
      () =>
        new BrowserConfigurationError({
          message: "Browserbase returned an invalid browser connection URL.",
        }),
    ),
  );

export const requireBrowserbaseApiKey = (settingsService: ServerSettingsService["Service"]) =>
  Effect.gen(function* () {
    const settings = yield* settingsService.getSettings;
    if (!settings.browserProvider.enabled) {
      return yield* Effect.fail(
        new BrowserConfigurationError({
          message: "Browserbase is disabled. Enable it in Settings > Browser.",
        }),
      );
    }
    const apiKey = settings.browserProvider.browserbaseApiKey || process.env.BROWSERBASE_API_KEY;
    if (!apiKey)
      return yield* Effect.fail(
        new BrowserConfigurationError({ message: "Browserbase is not configured." }),
      );
    return apiKey;
  });

export const makeBrowserbaseContexts = (
  httpClient: HttpClient.HttpClient,
  settingsService: ServerSettingsService["Service"],
) =>
  Effect.gen(function* () {
    const requireApiKey = requireBrowserbaseApiKey(settingsService);

    return yield* RcMap.make({
      lookup: (_key: string) =>
        Effect.acquireRelease(
          requireApiKey.pipe(
            Effect.flatMap((apiKey) =>
              httpClient
                .post("https://api.browserbase.com/v1/sessions", {
                  headers: {
                    "Content-Type": "application/json",
                    "X-BB-API-Key": apiKey,
                  },
                  body: HttpBody.jsonUnsafe({
                    browserSettings: { viewport: DEFAULT_VIEWPORT, recordSession: true },
                  }),
                })
                .pipe(
                  Effect.flatMap(HttpClientResponse.filterStatusOk),
                  Effect.flatMap((response) => response.json),
                  Effect.flatMap(decodeBrowserbaseSession),
                ),
            ),
            Effect.flatMap((session) =>
              Effect.tryPromise(() => chromium.connectOverCDP(session.connectUrl)),
            ),
            Effect.flatMap((browser) => {
              const context = browser.contexts()[0];
              return context
                ? Effect.succeed({ browser, context })
                : Effect.tryPromise(() => browser.close()).pipe(
                    Effect.andThen(
                      Effect.fail(
                        new BrowserConfigurationError({
                          message: "Browserbase returned no browser context.",
                        }),
                      ),
                    ),
                  );
            }),
          ),
          ({ browser }) => Effect.promise(() => browser.close()).pipe(Effect.orDie),
        ),
    });
  });
