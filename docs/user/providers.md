# Provider connections

Akeru Bot connects to provider subscriptions and API keys from **Settings → Providers**. Credentials stay in the environment that owns the connection.

ChatGPT, Claude, Grok, Kimi For Coding, and OpenCode Go run through Akeru's built-in runtime.
You do not need their command-line tools installed or signed in to create a bot, chat, or generate
chat titles and branch names with ChatGPT, Claude, or Grok. After connecting an account in Akeru,
choose its models in onboarding or the bot's settings. If the account is disconnected, reconnect
it in **Settings → Providers**.

An instance configured with its own credentials uses those credentials rather than the shared
connection. A custom configuration directory alone does not connect an account to Akeru's runtime.

## Custom API endpoints

**Settings > Providers > Custom API** connects Akeru Bot to any OpenAI-compatible HTTP endpoint: a
hosted service, a gateway, or a server you run yourself. There is no account to connect and no
sign-in flow.

When you add a Custom API instance, pick what you are connecting to. OpenRouter, Groq, Together AI,
DeepSeek, Mistral, Fireworks, LM Studio, Ollama, and vLLM fill in their base URL and a name for you.
Choose **Other** to type the URL of anything else. Local servers such as LM Studio and Ollama resolve
on the machine running the environment, not on the device you are using.

Paste the service's key into **API key**. Hosted services need one; local servers usually do not, and
a base URL alone is enough for them. The key is stored outside the settings file, never sent back to
a client, and sent to the configured endpoint as a bearer token. On a saved instance the field shows
that a key is stored. Type a new key to replace it, or use **Remove key**. A key belongs to its
service: changing the base URL to a different host, or from HTTPS to HTTP, removes the stored key,
so paste the new service's key afterwards. If the endpoint turns the key down, the instance shows
**Not connected** with the reason until a later check succeeds.

The model list comes from the endpoint's `/models` response. Models you add by hand are kept alongside
it, and a model disappears from the picker once the endpoint stops listing it. If Akeru cannot read the
endpoint, the last successful list stays and the provider row explains what went wrong.

Use **Add instance** on the Custom API page to keep several endpoints side by side, such as a local
server and a hosted gateway.

The environment sends requests to the URL you configure. Point it only at an endpoint you trust, and
prefer HTTPS for anything outside your machine.

## Subscription login health

After a login or API key save completes, the environment server sends one request that costs nothing, to confirm the account can reach its models or usage endpoint. The check runs on the server, so closing the app or losing the connection right after login does not stop it. While it runs, the provider row shows **Checking health…**. It then changes to **Connected** when the request succeeds or **Failed** when it does not. A failed check does not undo a successful login. Repair the provider account, then use **Reconnect** or **Check OAuth**.

The check covers ChatGPT/Codex, Claude, Grok, and Kimi For Coding logins, and OpenCode Go API keys. OpenCode Go has no device login.

## Device codes

For providers that use a device code, Akeru Bot shows the code beside the sign-in link, in Settings, in desktop onboarding, and on mobile. Choose **Copy sign-in code** (or **Copy code** on mobile) to copy it. **Code copied** confirms a successful copy. If the browser, desktop shell, or phone denies clipboard access, Akeru Bot says so. Select the code, copy it manually, and continue on the provider's sign-in page.
