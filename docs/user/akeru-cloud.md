# Akeru Cloud

Akeru Cloud is an optional hosted service. You can link your environment to an account from Settings on web, desktop, or mobile. This release provides the connection and relay foundation. Hosted bots and Slack setup are not available yet. The app works fully without an account.

Your chats, bot profiles, provider keys, and files stay on the machine that runs your environment. Akeru Cloud never runs your bots and never gets model access.

## What Akeru Cloud sees

When you connect, the environment sends Akeru Cloud its name and app version. Akeru Cloud knows the email address of the account that approved the environment.

While connected, the environment keeps one outbound connection open to Akeru Cloud. Nothing on your machine has to accept incoming connections.

For hosted channels, Akeru Cloud receives each event the channel provider sends, such as a Slack message, and passes it to your environment in transit. It does not store message content or plaintext channel secrets. Approval results can be held encrypted briefly while delivery is retried; they expire within ten minutes. Your environment checks each event's signature itself.

The credential that identifies your environment to Akeru Cloud stays in the environment's secret store. Clients never receive it.

## Connect

1. Open **Settings > Akeru Cloud**. On mobile, open **Settings** and select **Akeru Cloud**.
2. Select **Connect Akeru Cloud**. Akeru shows a short code.
3. Select **Open Akeru Cloud**. The page opens on the device you are using, even when the environment runs on another machine.
4. Sign in, check that the code matches, and approve the environment.

The settings screen changes to show your account email and a connection status. If the code expires or you decline, the screen returns to **Connect Akeru Cloud** and you can start again. Select **Cancel** to stop waiting.

You can also run **Connect Akeru Cloud** from the command palette.

Connecting and disconnecting require an owner session, such as the desktop app or the startup pairing link. A device paired with standard access can see the status but cannot change it.

## Connection status

- **Connected:** Akeru Cloud can reach this environment.
- **Connecting:** the environment is opening its connection.
- **Offline:** the connection dropped. The environment retries on its own, waiting longer between attempts up to about a minute.

Slack events that arrive while the environment is offline are not delivered later.

## Disconnect

Select **Disconnect** under **Settings > Akeru Cloud** and confirm, or run **Disconnect Akeru Cloud** from the command palette. After Akeru Cloud confirms revocation, the environment forgets its credential and closes the connection.

If the cloud cannot confirm disconnection, Akeru keeps the link and shows an error. Reconnect and try again, or revoke the environment from your account page on Akeru Cloud.

If you revoke an environment from the account page first, the environment forgets its credential and shows **This environment was disconnected from Akeru Cloud.** Select **Connect again** to link it again.
