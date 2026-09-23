# Review usage

Open **Usage** from the sidebar to review subscription limits and recent model activity across your
connected environments. Usage opens as a workspace page, so it has its own URL and works with normal
back and forward navigation.

## Plan limits

The **Limits** tab opens by default and shows available limits for ChatGPT, Claude, Cursor, Grok,
Kimi For Coding, and OpenCode Go.
Disconnected accounts and limits that a provider does not report stay hidden.

Each meter shows the percentage used or left and the next reset time. Provider plans expose different
windows, such as five-hour, weekly, or plan-wide limits.

## Cost and tokens

Use the **Cost** and **Tokens** tabs to review activity Akeru recorded through providers connected in
**Settings > Providers**. Choose the past 24 hours, 7 days, 30 days, or 90 days. The page shows
provider totals, an hourly or daily chart, processed token totals, estimated cost, and breakdowns by
model or time.

Akeru never imports machine-wide Claude, Codex, or other CLI history. Each environment reports only
its own Akeru provider activity, and disconnected providers stay hidden. A notice identifies
environments that are still loading, stale, or unavailable.

Web and desktop charts stay still when idle. Hover over a chart to inspect a value.

## Per-bot usage

On mobile, **Settings > General > Usage** lists the bots in each connected environment below the plan
limits. Open a bot to see its input, output, Observer, and Reflector tokens, its cap, an estimated
cost, subscription pool use, and reserved tokens.

A measurement a provider did not report reads **Unavailable** rather than zero, and a measurement
that is only partly reported shows a trailing `+` so the number reads as a floor. A notice names the
snapshot as incomplete when any provider measurement is missing.

Estimated cost comes from the model rate table. It is not subscription spend and not an amount
billed. Subscription pool use is provider-reported; when a provider reports no meter, the row reads
Unavailable.

The cap is read-only here. Change a bot's cap in a chat with that bot, under chat settings.

Per-bot usage reads when you open it, when the app returns to the foreground, and when you pull to
refresh. It does not poll in the background.

## Refresh usage

Akeru refreshes usage every five minutes by default. Select the refresh button to reload it now. The
page remembers the last tab and time range you selected.

Change **Usage refresh** in **Settings > General** to a value from 1 to 60 minutes. Mobile also shows
Usage under General settings and supports pull-to-refresh.
