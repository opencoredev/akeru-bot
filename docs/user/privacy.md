# Privacy and outbound data

Akeru Bot stores threads, settings, secrets, and logs on your device under `~/.akeru`. It does not
require a hosted Akeru account.

Some features send data to services outside your device:

- Provider runs send prompts, selected files, tool results, screenshots, computer frames, and
  conversation context to the provider CLI or service you choose. The provider controls its own
  processing and retention.
- Product feedback goes to `feedback.akeru.bot`. The service may keep submissions for up to 90
  days.
- Voice calls send microphone audio and session data to the ChatGPT Realtime service while a call
  is active.
- Provider update checks contact the release sources for your configured providers. Signed desktop
  builds contact the configured release host for Akeru Bot updates.
- Anonymous analytics use PostHog only when you turn analytics on and the distributor configures a
  PostHog key. Events include the app version, platform, architecture, client type, feature use,
  and a random installation identifier. They do not use a provider account identifier.

Open Settings, then Privacy, to control analytics, product feedback, voice calls, and provider
update checks. Analytics starts off. Mobile shows the same controls in the Privacy section for the
connected environment.

The published Terms of Use and Privacy Policy pages are drafts. Akeru Bot must not ship a signed
release until qualified legal counsel approves them.
