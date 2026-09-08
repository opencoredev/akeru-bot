# Voice and spoken replies

Akeru can talk in two different ways. They are not the same feature.

## Live calls

A live call is a realtime conversation with a bot. Microphone audio and the
call transcript go to the ChatGPT subscription connected to the environment
while the call is active. Start a call from a bot that has Voice calls
enabled. Only one call can be live at a time.

Live calls bill through that ChatGPT subscription. They do not use a separate
speech key.

## Read a stored reply aloud

Read aloud speaks an existing bot reply on this device. It does not start a
call, and it does not send the reply back to a coding model for a new answer.

Open a completed bot reply and choose **Read aloud**. You can pause, resume,
stop, and retry. Switching replies, leaving the chat, editing or deleting the
reply, starting a live call, or disconnecting stops the current audio. Stale
audio from another chat never plays.

Code blocks and images are skipped. The control tells you when that happens.
Empty, code-only, or oversized replies cannot be read.

Stored-reply speech is not connected yet. Akeru will not pretend a live call
or a new model turn can stand in for it. When a speech service is connected,
that service may charge for the audio it generates. Keys stay on the
environment server.

## Automatic readout

Settings → Voice includes **Read new replies aloud**. It is off until you turn
it on, and it is saved only on this device.

When it is on, Akeru reads a newly completed reply in the chat you currently
have open. Reconnecting, loading history, or opening an older chat does not
replay old replies. Turn the setting off to stop automatic readout.

## Privacy

Read aloud sends the spoken form of the stored reply to the selected speech
service when that service is connected. Temporary audio lives only on this
device for the current playback and is released when playback stops. Akeru
does not keep reply audio in chat history or logs.
