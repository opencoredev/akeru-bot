# Image generation settings

Image creation is not available in chats yet. **Settings > Image generation** lets you
connect a ChatGPT or Grok subscription, check its health, and choose which provider
a bot will use when image creation becomes available. These choices do not change
the bot's chat model.

You can also find the page by searching Settings for "image" or choosing
**Image generation settings** in the command palette.

## Providers

The page has a row for ChatGPT and a row for Grok. Each row shows whether its
subscription is connected and enabled, its health, supported operations, the last
health test, and any reported failure. The last image field stays empty until
image creation is available.

A row without a connected subscription says only that, next to **Connect**.

While the rows load, they read **Checking**. If Akeru cannot reach the
environment, they read **Unavailable** and the page offers **Retry**.

A provider needs a connected subscription before you can turn it on. Health
reads **Not tested** until a real test request succeeds. Select **Test** to check
the connection. If the request fails, the row shows the failure and a suggested
next step.

Select **Connect** or **Reconnect** to open that provider's sign-in under
**Settings > Providers** for the same environment. **Disconnect** signs the
subscription out of the environment, including chats that use it; Akeru asks
before disconnecting. To keep chatting with the subscription while disabling
it for future image creation, turn the image provider off instead.

## Default and fallback

Under **Routing**, choose the **Default provider** for bots without their own
choice. When both providers are enabled, **Fallback order** sets the order
Akeru will use if the first provider cannot fulfill an image request once image
creation is available. Turning a provider off removes it from that order.

## Per-bot choice

Open a bot's settings. Under **Workspace**, **Image generation** selects a
provider or **Use global default**. The default option shows the current
provider. A provider that is off or disconnected is marked **(off)** or
**(not connected)**. **Image settings** opens the global settings page. The
bot's chat model remains the one selected under **Model**.

Image settings are not in the chat composer.

## Images in chat

Codex and Kimi For Coding bots can create an image when you ask for one in
chat. The bot asks for your approval first, then uses its own image provider,
the default, or the fallback order. Only providers that are turned on are
tried. If every provider fails, the bot reports each failure. Finished images
are saved on the environment, and the bot replies with where it saved them.

## Mobile

Mobile shows the saved setup under **Settings > Image generation**, including
connection health, supported operations, the last test, failures, and suggested
next steps. A provider without a subscription shows that it is not connected.
If the status cannot load, select **Try again**. Change image settings from
the desktop or web app.
