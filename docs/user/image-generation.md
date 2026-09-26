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

A row without a connected subscription says only that, next to **Connect**.

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

## Asking a bot for an image

Ask any bot for a picture in a direct chat or a group chat. The bot calls
Akeru's image tool, which sends the request to the bot's own image provider,
or to the default provider when the bot has no choice of its own. For Codex
and Kimi For Coding bots the tool asks for your approval first; Claude,
Grok, and OpenCode bots follow their own tool permission setting. You can
also name a provider in your request, for example "make it with Grok". A
named provider is used on its own, without fallback.

While the image is being made, the chat shows the tool call as running.
Stopping the turn cancels the image request too, and nothing is posted. Each
provider gets two and a half minutes. If it runs out of time, the request
moves to the other provider when both are on, and otherwise stops with a
timeout.

Finished images appear in the chat as a reply with the images attached. They
are saved on the environment with the chat, so they are still there after you
reload or restart. The bot gets a short summary of what was made, never the
image data itself.

A bot can make up to four images per request, in square, landscape, or
portrait shapes. ChatGPT supports 1:1, 3:2, and 2:3. Grok supports all of
those plus 16:9, 9:16, 4:3, and 3:4.

### Editing an image

To edit, attach an image to your message and ask for the change. The bot can
also edit an image that is already in the chat. ChatGPT accepts up to four
images for one edit. Grok accepts one and returns one edited image.

If the provider the bot tried first fails, Akeru does not quietly send your
image to the other provider. The bot tells you which provider it would use
instead, and only tries it after you agree.

### When a request fails

If the first provider is not connected, has expired, or fails, the request
moves to the other provider when both are on. A request the provider refuses,
for example because of its content rules, does not move to the other provider.
The bot tells you what happened.

## Opening and saving images

Select an image in a chat to open it large. From there you can:

- **Open image** in a new browser tab
- **Save image** as a file
- **Copy image** to the clipboard
- **Reveal in Finder**, **Reveal in File Explorer**, or **Reveal in Files**,
  which opens the file manager on the environment's machine at the saved
  image. It appears only when that machine can open a file manager, so it is
  usually missing on a remote environment.

## Usage and privacy

Image requests count toward the usage of the bot that made them, under
**Usage**. Prompts and images are not sent to analytics, bot memory, logs, or
product feedback. The usage record keeps only the provider, the model, and the
token counts the provider reports. Grok does not report tokens, so its requests
count with zero tokens.

## Mobile

The mobile app shows the saved setup under **Settings > Image generation**,
with the same provider details as the desktop page: health, supported
operations, the last image, the last health test, the last failure, and the
next step. A provider without a subscription shows only that it is not
connected. If the status cannot load, select **Try again**. Change image
generation from the desktop app or the web app.

Images a bot made appear in mobile chats like any other image attachment. Tap
one to see it full screen.
