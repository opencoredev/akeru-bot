# Provider connections

Akeru Bot connects to provider subscriptions and API keys from **Settings → Providers**. Credentials stay in the environment that owns the connection.

ChatGPT, Claude, Grok, Kimi For Coding, and OpenCode Go run through Akeru's built-in runtime.
You do not need their command-line tools installed or signed in to create a bot, chat, or generate
chat titles and branch names with ChatGPT, Claude, or Grok. After connecting an account in Akeru,
choose its models in onboarding or the bot's settings. If the account is disconnected, reconnect
it in **Settings → Providers**.

Model lists update on their own. The environment server checks models.dev for new provider models
about once an hour, and open clients pick them up within a few minutes, with no reload or app
update. Older models move to the picker's legacy section when a newer one in the same line ships.

An instance configured with its own credentials uses those credentials rather than the shared
connection. A custom configuration directory alone does not connect an account to Akeru's runtime.

## Subscription login health

After a login or API key save completes, the environment server sends one request that costs nothing, to confirm the account can reach its models or usage endpoint. The check runs on the server, so closing the app or losing the connection right after login does not stop it. While it runs, the provider row shows **Checking health…**. It then changes to **Connected** when the request succeeds or **Failed** when it does not. A failed check does not undo a successful login. Repair the provider account, then use **Reconnect** or **Check OAuth**.

The check covers ChatGPT/Codex, Claude, Grok, and Kimi For Coding logins, and OpenCode Go API keys. OpenCode Go has no device login.

## Device codes

For providers that use a device code, Akeru Bot shows the code beside the sign-in link, in Settings, in desktop onboarding, and on mobile. Choose **Copy sign-in code** (or **Copy code** on mobile) to copy it. **Code copied** confirms a successful copy. If the browser, desktop shell, or phone denies clipboard access, Akeru Bot says so. Select the code, copy it manually, and continue on the provider's sign-in page.
