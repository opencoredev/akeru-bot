# Provider connections

Akeru Bot connects to provider subscriptions and API keys from **Settings → Providers**. Credentials stay in the environment that owns the connection.

## Subscription login health

After a login or API key save completes, the environment server sends one request that costs nothing, to confirm the account can reach its models or usage endpoint. The check runs on the server, so closing the app or losing the connection right after login does not stop it. While it runs, the provider row shows **Checking health…**. It then changes to **Connected** when the request succeeds or **Failed** when it does not. A failed check does not undo a successful login. Repair the provider account, then use **Reconnect** or **Check OAuth**.

The check covers ChatGPT/Codex, Claude, Grok, and Kimi For Coding logins, and OpenCode Go API keys. OpenCode Go has no device login.

## Device codes

For providers that use a device code, Akeru Bot shows the code beside the sign-in link, in Settings, in desktop onboarding, and on mobile. Choose **Copy sign-in code** (or **Copy code** on mobile) to copy it. **Code copied** confirms a successful copy. If the browser, desktop shell, or phone denies clipboard access, Akeru Bot says so. Select the code, copy it manually, and continue on the provider's sign-in page.
