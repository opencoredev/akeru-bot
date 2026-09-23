# Image generation

Bots can create images with the ChatGPT or Grok subscription you already
connected to the environment. Image generation is set up in its own place,
**Settings > Image generation**. It never changes which model a bot chats
with. A Claude bot can create images with ChatGPT, for example.

You can also reach the page by searching Settings for "image", or by choosing
**Image generation settings** in the command palette.

## Providers

The page has one row for ChatGPT and one for Grok. Each row shows:

- whether a subscription is connected
- its health
- what it supports
- when it last created an image
- when the last health test ran and whether it passed
- the last failure and what to do about it
- whether it is turned on

While the rows load, they read **Checking**. If Akeru cannot reach the
environment, they read **Unavailable** and the page offers **Retry**.

You can turn on either provider, both, or neither. A provider needs a
connected subscription before you can turn it on.

Health reads **Not tested** until a real test request succeeds. Select
**Test** to send one. When a request fails, the row shows what happened, for
example **Expired**, **Revoked**, or **First request failed**, along with the
message the provider returned.

When access has expired or been revoked, select **Reconnect**. Without a
subscription, select **Connect**. Both open that provider's sign-in under
**Settings > Providers** for the same environment.

**Disconnect** signs the subscription out of the environment. Chats that use
the same subscription are signed out too, so Akeru asks before it disconnects.
To stop using a provider for images but keep chatting with it, turn the
provider off instead.

## Default and fallback

Under **Routing**, choose the **Default provider**. Bots without their own
choice use it.

When both providers are on, **Fallback order** decides which one tries
first. If the first provider fails, the other one tries the same request.
Turning a provider off removes it from the order and moves the default to the
provider that is still on.

## Per-bot choice

Open a bot's settings. Under **Workspace**, **Image generation** picks the
provider this bot uses to create images, or **Use global default**. The
default option shows which provider that currently means. A provider that is
turned off or has no connected subscription is marked **(off)** or
**(not connected)**. **Image settings** next to the picker opens
**Settings > Image generation**. The bot's chat model stays the one set under
**Model**.

Image settings are not in the chat composer.

## Mobile

The mobile app shows the saved setup under **Settings > Image generation**,
with the same provider details as the desktop page: health, supported
operations, the last image, the last health test, the last failure, and the
next step. If the status cannot load, select **Try again**. Change image
generation from the desktop app or the web app.
