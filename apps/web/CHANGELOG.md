## @akeru/web@0.0.41

## 0.2.0

### Minor Changes

- [#322](https://github.com/opencoredev/akeru-bot/pull/322) [`630de12`](https://github.com/opencoredev/akeru-bot/commit/630de12aeb4fe350ec957af323566a31aa85ebad) Thanks [@leoisadev1](https://github.com/leoisadev1)! - Archive a bot from its roster menu and restore it from Archived. An empty roster now shows a Create bot prompt.

- [#322](https://github.com/opencoredev/akeru-bot/pull/322) [`630de12`](https://github.com/opencoredev/akeru-bot/commit/630de12aeb4fe350ec957af323566a31aa85ebad) Thanks [@leoisadev1](https://github.com/leoisadev1)! - While a bot works, the chat shows a small pixel meter with the current step and elapsed time. You can change a bot's model from the composer, and routine runs appear as notes in the bot's chat.

- [#322](https://github.com/opencoredev/akeru-bot/pull/322) [`630de12`](https://github.com/opencoredev/akeru-bot/commit/630de12aeb4fe350ec957af323566a31aa85ebad) Thanks [@leoisadev1](https://github.com/leoisadev1)! - Type `@` in the composer to mention the preview browser or another chat. A chat mention gives the bot a short excerpt of that chat's recent turns, and `@browser` asks the bot to use the preview browser when bot browser access is on. Bots that share a name both appear in the menu, and picking one routes the message to that bot.

- [#322](https://github.com/opencoredev/akeru-bot/pull/322) [`630de12`](https://github.com/opencoredev/akeru-bot/commit/630de12aeb4fe350ec957af323566a31aa85ebad) Thanks [@leoisadev1](https://github.com/leoisadev1)! - Hold the microphone in an empty chat composer to dictate a message on web, desktop, and mobile. Akeru transcribes through the environment's voice provider and inserts the text at the cursor without sending it.

- [#322](https://github.com/opencoredev/akeru-bot/pull/322) [`630de12`](https://github.com/opencoredev/akeru-bot/commit/630de12aeb4fe350ec957af323566a31aa85ebad) Thanks [@leoisadev1](https://github.com/leoisadev1)! - Memory now lists durable facts by chat, bot, or project scope, with their source, approval state, and replaced value, on desktop, web, and mobile. Durable facts can be exported per scope, and importing them asks you to choose a version for each conflict before anything changes.

- [#322](https://github.com/opencoredev/akeru-bot/pull/322) [`630de12`](https://github.com/opencoredev/akeru-bot/commit/630de12aeb4fe350ec957af323566a31aa85ebad) Thanks [@leoisadev1](https://github.com/leoisadev1)! - Add Image generation settings with separate ChatGPT and Grok rows, honest health tests, a default provider and fallback order, and a per-bot image provider choice. Mobile shows the saved setup.

- [#296](https://github.com/opencoredev/akeru-bot/pull/296) [`268ea1a`](https://github.com/opencoredev/akeru-bot/commit/268ea1a3feb0f6713b3dfde8e6b4e72242e77877) Thanks [@leoisadev1](https://github.com/leoisadev1)! - Bot avatars are now flat shapes in a brighter palette, with slanted eyes cut out of the body. Bots on an older preset color move to the matching new one. A working bot sways, glances down at its work, and turns its face around its body now and then. Pointing at a bot widens its eyes and makes them follow the pointer. Resting bots stay still apart from an occasional blink or glance, and all motion respects your reduced-motion setting. Dithered avatars are gone: the picker no longer offers generated identicons or a dither filter, and bots that had one now show a shape.

- [#322](https://github.com/opencoredev/akeru-bot/pull/322) [`630de12`](https://github.com/opencoredev/akeru-bot/commit/630de12aeb4fe350ec957af323566a31aa85ebad) Thanks [@leoisadev1](https://github.com/leoisadev1)! - Desktop setup now asks what you want your bot to help with and shows a short plan based on your answer. The last step drafts your first message from that plan. After you send it, setup waits until your bot has started, plays a short one-time celebration, and opens the chat with your message already there. With reduced motion turned on, the plan appears right away and the celebration is skipped.

- [#322](https://github.com/opencoredev/akeru-bot/pull/322) [`630de12`](https://github.com/opencoredev/akeru-bot/commit/630de12aeb4fe350ec957af323566a31aa85ebad) Thanks [@leoisadev1](https://github.com/leoisadev1)! - Settings > Providers now says which subscription or key unlocks each provider, whether that subscription includes API access, the limits each provider publishes, what this environment has saved, and one next step. A provider shows Ready only after a request to it succeeds. Mobile Settings shows the same information, in English and Simplified Chinese.

- [#322](https://github.com/opencoredev/akeru-bot/pull/322) [`630de12`](https://github.com/opencoredev/akeru-bot/commit/630de12aeb4fe350ec957af323566a31aa85ebad) Thanks [@leoisadev1](https://github.com/leoisadev1)! - Routines open into a detail view with their schedule, latest run, instructions, and workspace. A bot's shared browser capture expands with Open and collapses with Esc.

- [#322](https://github.com/opencoredev/akeru-bot/pull/322) [`630de12`](https://github.com/opencoredev/akeru-bot/commit/630de12aeb4fe350ec957af323566a31aa85ebad) Thanks [@leoisadev1](https://github.com/leoisadev1)! - The `$` skill menu shows each skill's own emoji, falling back to the glyph for where the skill came from. Selected skills appear as a larger tinted chip with the same emoji, in the composer and in sent messages, and still send as `$name`. The mobile command menu shows the emoji too.

### Patch Changes

- [#322](https://github.com/opencoredev/akeru-bot/pull/322) [`630de12`](https://github.com/opencoredev/akeru-bot/commit/630de12aeb4fe350ec957af323566a31aa85ebad) Thanks [@leoisadev1](https://github.com/leoisadev1)! - Keep group chat send available when a configured member can reply.

- [#291](https://github.com/opencoredev/akeru-bot/pull/291) [`5ff172b`](https://github.com/opencoredev/akeru-bot/commit/5ff172b8d6ed1c67d4d75988860e122a58289282) Thanks [@leoisadev1](https://github.com/leoisadev1)! - Keep independent chats responsive during provider setup and workspace refreshes, and avoid repeated work during streaming updates.

- [#322](https://github.com/opencoredev/akeru-bot/pull/322) [`630de12`](https://github.com/opencoredev/akeru-bot/commit/630de12aeb4fe350ec957af323566a31aa85ebad) Thanks [@leoisadev1](https://github.com/leoisadev1)! - Checklists with two or more tasks in chat now show a static progress summary, such as "2 of 3 done".

- [#322](https://github.com/opencoredev/akeru-bot/pull/322) [`630de12`](https://github.com/opencoredev/akeru-bot/commit/630de12aeb4fe350ec957af323566a31aa85ebad) Thanks [@leoisadev1](https://github.com/leoisadev1)! - Diff and patch code blocks in chat now render as change cards with added and removed lines tinted and a count of changed lines.

- [#322](https://github.com/opencoredev/akeru-bot/pull/322) [`630de12`](https://github.com/opencoredev/akeru-bot/commit/630de12aeb4fe350ec957af323566a31aa85ebad) Thanks [@leoisadev1](https://github.com/leoisadev1)! - Streaming answers in chat no longer flash a half-typed code fence, table, list marker, or heading underline. The partial line appears once it can render the way the finished message will.

- [#322](https://github.com/opencoredev/akeru-bot/pull/322) [`630de12`](https://github.com/opencoredev/akeru-bot/commit/630de12aeb4fe350ec957af323566a31aa85ebad) Thanks [@leoisadev1](https://github.com/leoisadev1)! - Show the voice connection settings labels in English and Chinese without a missing-translation error.

- [#322](https://github.com/opencoredev/akeru-bot/pull/322) [`630de12`](https://github.com/opencoredev/akeru-bot/commit/630de12aeb4fe350ec957af323566a31aa85ebad) Thanks [@leoisadev1](https://github.com/leoisadev1)! - Allow specialist mentions without a boss and exclude disabled providers from group send availability.

- [#322](https://github.com/opencoredev/akeru-bot/pull/322) [`630de12`](https://github.com/opencoredev/akeru-bot/commit/630de12aeb4fe350ec957af323566a31aa85ebad) Thanks [@leoisadev1](https://github.com/leoisadev1)! - The command palette lists bots first and keeps chats and projects above commands when you search, so a matching chat is no longer buried under commands.

- [#322](https://github.com/opencoredev/akeru-bot/pull/322) [`630de12`](https://github.com/opencoredev/akeru-bot/commit/630de12aeb4fe350ec957af323566a31aa85ebad) Thanks [@leoisadev1](https://github.com/leoisadev1)! - Show mobile remote health controls in English and Chinese without missing labels.

- [#322](https://github.com/opencoredev/akeru-bot/pull/322) [`630de12`](https://github.com/opencoredev/akeru-bot/commit/630de12aeb4fe350ec957af323566a31aa85ebad) Thanks [@leoisadev1](https://github.com/leoisadev1)! - Keep file locations and their explanations visible in bot failure messages.

- [#322](https://github.com/opencoredev/akeru-bot/pull/322) [`630de12`](https://github.com/opencoredev/akeru-bot/commit/630de12aeb4fe350ec957af323566a31aa85ebad) Thanks [@leoisadev1](https://github.com/leoisadev1)! - Keep routine notes current in an open chat and show the speaker after each note.

- [#322](https://github.com/opencoredev/akeru-bot/pull/322) [`630de12`](https://github.com/opencoredev/akeru-bot/commit/630de12aeb4fe350ec957af323566a31aa85ebad) Thanks [@leoisadev1](https://github.com/leoisadev1)! - Queue group chat follow-ups while the first message is being accepted, preserving one conversation.

- [#322](https://github.com/opencoredev/akeru-bot/pull/322) [`630de12`](https://github.com/opencoredev/akeru-bot/commit/630de12aeb4fe350ec957af323566a31aa85ebad) Thanks [@leoisadev1](https://github.com/leoisadev1)! - The Plugins directory shows listed integrations while verification is pending, with their connection status visible.

- [#322](https://github.com/opencoredev/akeru-bot/pull/322) [`630de12`](https://github.com/opencoredev/akeru-bot/commit/630de12aeb4fe350ec957af323566a31aa85ebad) Thanks [@leoisadev1](https://github.com/leoisadev1)! - In a group chat, an @mention of a name that two bots share no longer picks one of them at random. The composer explains the clash and holds the message until one bot is renamed.

- [#322](https://github.com/opencoredev/akeru-bot/pull/322) [`630de12`](https://github.com/opencoredev/akeru-bot/commit/630de12aeb4fe350ec957af323566a31aa85ebad) Thanks [@leoisadev1](https://github.com/leoisadev1)! - The group sidebar now reads a removal hint only on the remove buttons it explains, suggests creating a bot when every bot is already in the group, and shows that state as a note under Add bot instead of in the picker.

- [#322](https://github.com/opencoredev/akeru-bot/pull/322) [`630de12`](https://github.com/opencoredev/akeru-bot/commit/630de12aeb4fe350ec957af323566a31aa85ebad) Thanks [@leoisadev1](https://github.com/leoisadev1)! - Hosted pairing links only pair when the token is in the link's fragment. A link that sends the token in the query string is refused.

- [#322](https://github.com/opencoredev/akeru-bot/pull/322) [`630de12`](https://github.com/opencoredev/akeru-bot/commit/630de12aeb4fe350ec957af323566a31aa85ebad) Thanks [@leoisadev1](https://github.com/leoisadev1)! - A hosted pairing link that names the address serving the page now signs in to that address, so **Open app** opens the app instead of asking to pair again.

- [#322](https://github.com/opencoredev/akeru-bot/pull/322) [`630de12`](https://github.com/opencoredev/akeru-bot/commit/630de12aeb4fe350ec957af323566a31aa85ebad) Thanks [@leoisadev1](https://github.com/leoisadev1)! - The hosted pairing page reads the link again when the complete link is opened in the same tab, instead of still saying it is incomplete.

- [#322](https://github.com/opencoredev/akeru-bot/pull/322) [`630de12`](https://github.com/opencoredev/akeru-bot/commit/630de12aeb4fe350ec957af323566a31aa85ebad) Thanks [@leoisadev1](https://github.com/leoisadev1)! - Image generation settings now show loading and unavailable states with a retry instead of an empty history, and Connect opens the right provider sign-in for the same environment. Mobile shows the same provider details as desktop, and the bot editor marks image providers that are off or not connected.

- [#322](https://github.com/opencoredev/akeru-bot/pull/322) [`630de12`](https://github.com/opencoredev/akeru-bot/commit/630de12aeb4fe350ec957af323566a31aa85ebad) Thanks [@leoisadev1](https://github.com/leoisadev1)! - Keep a newly created bot's pending chat until it appears in the environment roster.

- [#322](https://github.com/opencoredev/akeru-bot/pull/322) [`630de12`](https://github.com/opencoredev/akeru-bot/commit/630de12aeb4fe350ec957af323566a31aa85ebad) Thanks [@leoisadev1](https://github.com/leoisadev1)! - Keep delegated child work from replacing a bot or group's latest chat.

- [#322](https://github.com/opencoredev/akeru-bot/pull/322) [`630de12`](https://github.com/opencoredev/akeru-bot/commit/630de12aeb4fe350ec957af323566a31aa85ebad) Thanks [@leoisadev1](https://github.com/leoisadev1)! - Refresh open chat date and time labels after the device timezone changes.

- [#322](https://github.com/opencoredev/akeru-bot/pull/322) [`630de12`](https://github.com/opencoredev/akeru-bot/commit/630de12aeb4fe350ec957af323566a31aa85ebad) Thanks [@leoisadev1](https://github.com/leoisadev1)! - Report terminal paint latency for the latest unkeyed arrival when earlier output was overwritten.

- [#322](https://github.com/opencoredev/akeru-bot/pull/322) [`630de12`](https://github.com/opencoredev/akeru-bot/commit/630de12aeb4fe350ec957af323566a31aa85ebad) Thanks [@leoisadev1](https://github.com/leoisadev1)! - Allow group chats to use a configured bot or project provider when the app default is empty.

- [#322](https://github.com/opencoredev/akeru-bot/pull/322) [`630de12`](https://github.com/opencoredev/akeru-bot/commit/630de12aeb4fe350ec957af323566a31aa85ebad) Thanks [@leoisadev1](https://github.com/leoisadev1)! - The command palette finds each group's current chat in one pass, so opening it stays fast with a long group chat history.

- [#322](https://github.com/opencoredev/akeru-bot/pull/322) [`630de12`](https://github.com/opencoredev/akeru-bot/commit/630de12aeb4fe350ec957af323566a31aa85ebad) Thanks [@leoisadev1](https://github.com/leoisadev1)! - Command palette chat search lists chats you can open before chats from another environment, so those never push an openable chat out of the results.

- [#322](https://github.com/opencoredev/akeru-bot/pull/322) [`630de12`](https://github.com/opencoredev/akeru-bot/commit/630de12aeb4fe350ec957af323566a31aa85ebad) Thanks [@leoisadev1](https://github.com/leoisadev1)! - The command palette's search box now says it searches commands and chats.

- [#322](https://github.com/opencoredev/akeru-bot/pull/322) [`630de12`](https://github.com/opencoredev/akeru-bot/commit/630de12aeb4fe350ec957af323566a31aa85ebad) Thanks [@leoisadev1](https://github.com/leoisadev1)! - Command palette chat results from another environment show their bot or group name, read from that environment's roster.

- [#322](https://github.com/opencoredev/akeru-bot/pull/322) [`630de12`](https://github.com/opencoredev/akeru-bot/commit/630de12aeb4fe350ec957af323566a31aa85ebad) Thanks [@leoisadev1](https://github.com/leoisadev1)! - Command palette results always match what you typed, so pressing Enter right after typing no longer runs a result from the previous search.

- [#300](https://github.com/opencoredev/akeru-bot/pull/300) [`72865f7`](https://github.com/opencoredev/akeru-bot/commit/72865f7b06c8737ad32e52e215bcac5a6a3a8d43) Thanks [@leoisadev1](https://github.com/leoisadev1)! - Smoother streaming in chats: bot replies update the conversation once per batch instead of once per token, and typing a message no longer re-renders the whole chat.

- [#299](https://github.com/opencoredev/akeru-bot/pull/299) [`5ae2952`](https://github.com/opencoredev/akeru-bot/commit/5ae2952e4ee70f753863dda1f8fb0783a978f20b) Thanks [@leoisadev1](https://github.com/leoisadev1)! - Smoother web chats: long conversations stop re-rendering on every update, and working-bot animations use far less GPU.

- [#322](https://github.com/opencoredev/akeru-bot/pull/322) [`630de12`](https://github.com/opencoredev/akeru-bot/commit/630de12aeb4fe350ec957af323566a31aa85ebad) Thanks [@leoisadev1](https://github.com/leoisadev1)! - Keep a bot's saved provider selection unavailable instead of showing a different provider as selected.

- [#322](https://github.com/opencoredev/akeru-bot/pull/322) [`630de12`](https://github.com/opencoredev/akeru-bot/commit/630de12aeb4fe350ec957af323566a31aa85ebad) Thanks [@leoisadev1](https://github.com/leoisadev1)! - Clickable controls now show the pointer cursor everywhere in the app, including checkboxes, radios, labels, tabs, menu items, and file inputs. Disabled controls keep the default cursor.

- [#292](https://github.com/opencoredev/akeru-bot/pull/292) [`0693f24`](https://github.com/opencoredev/akeru-bot/commit/0693f24f28145a5fc7cfe32563c5b9a11f8467a7) Thanks [@leoisadev1](https://github.com/leoisadev1)! - Reposition Akeru Bot's public messaging as an open-source, self-hosted Grok Bot alternative.

- [#322](https://github.com/opencoredev/akeru-bot/pull/322) [`630de12`](https://github.com/opencoredev/akeru-bot/commit/630de12aeb4fe350ec957af323566a31aa85ebad) Thanks [@leoisadev1](https://github.com/leoisadev1)! - Settings > Providers, chat table and code controls, file links, notifications, and the sidebar now translate to Simplified Chinese.

- [#322](https://github.com/opencoredev/akeru-bot/pull/322) [`630de12`](https://github.com/opencoredev/akeru-bot/commit/630de12aeb4fe350ec957af323566a31aa85ebad) Thanks [@leoisadev1](https://github.com/leoisadev1)! - Keep routine creation and run notes in bot chats after the routine is deleted.

- [#322](https://github.com/opencoredev/akeru-bot/pull/322) [`630de12`](https://github.com/opencoredev/akeru-bot/commit/630de12aeb4fe350ec957af323566a31aa85ebad) Thanks [@leoisadev1](https://github.com/leoisadev1)! - Failed chat requests now show a short explanation and a next step instead of the raw error, with the technical details one click away. The mobile resume card shows the same summary.

- [#322](https://github.com/opencoredev/akeru-bot/pull/322) [`630de12`](https://github.com/opencoredev/akeru-bot/commit/630de12aeb4fe350ec957af323566a31aa85ebad) Thanks [@leoisadev1](https://github.com/leoisadev1)! - Keep a bot's saved unavailable provider visible in the composer so users can choose a working model.

- [#322](https://github.com/opencoredev/akeru-bot/pull/322) [`630de12`](https://github.com/opencoredev/akeru-bot/commit/630de12aeb4fe350ec957af323566a31aa85ebad) Thanks [@leoisadev1](https://github.com/leoisadev1)! - Show deleted routine history as read-only chat notes instead of opening an unrelated Routines panel.

- [#322](https://github.com/opencoredev/akeru-bot/pull/322) [`630de12`](https://github.com/opencoredev/akeru-bot/commit/630de12aeb4fe350ec957af323566a31aa85ebad) Thanks [@leoisadev1](https://github.com/leoisadev1)! - The roster task chip keeps its own shape on a hovered or selected bot row instead of blending into the row background.

- [#322](https://github.com/opencoredev/akeru-bot/pull/322) [`630de12`](https://github.com/opencoredev/akeru-bot/commit/630de12aeb4fe350ec957af323566a31aa85ebad) Thanks [@leoisadev1](https://github.com/leoisadev1)! - Roster previews now read chat markdown the way the chat renders it, so code samples, URLs, and odd characters in a message stay intact in the preview line.

- [#322](https://github.com/opencoredev/akeru-bot/pull/322) [`630de12`](https://github.com/opencoredev/akeru-bot/commit/630de12aeb4fe350ec957af323566a31aa85ebad) Thanks [@leoisadev1](https://github.com/leoisadev1)! - The bot roster now shows the bot's current chat title as a task chip between its name and the timestamp.

- [#322](https://github.com/opencoredev/akeru-bot/pull/322) [`630de12`](https://github.com/opencoredev/akeru-bot/commit/630de12aeb4fe350ec957af323566a31aa85ebad) Thanks [@leoisadev1](https://github.com/leoisadev1)! - The bot roster stays blank until its first snapshot arrives, instead of briefly saying "No bots yet" right after pairing.

- [#322](https://github.com/opencoredev/akeru-bot/pull/322) [`630de12`](https://github.com/opencoredev/akeru-bot/commit/630de12aeb4fe350ec957af323566a31aa85ebad) Thanks [@leoisadev1](https://github.com/leoisadev1)! - Keep literal image examples inside code spans in long chat previews.

- [#322](https://github.com/opencoredev/akeru-bot/pull/322) [`630de12`](https://github.com/opencoredev/akeru-bot/commit/630de12aeb4fe350ec957af323566a31aa85ebad) Thanks [@leoisadev1](https://github.com/leoisadev1)! - Screen readers no longer hear a doubled period before "Open Routines" on routine receipts.

- [#322](https://github.com/opencoredev/akeru-bot/pull/322) [`630de12`](https://github.com/opencoredev/akeru-bot/commit/630de12aeb4fe350ec957af323566a31aa85ebad) Thanks [@leoisadev1](https://github.com/leoisadev1)! - Dialog backdrops are more opaque and no longer blur the whole window, and selected and disabled states share one color across the app.

- [#322](https://github.com/opencoredev/akeru-bot/pull/322) [`630de12`](https://github.com/opencoredev/akeru-bot/commit/630de12aeb4fe350ec957af323566a31aa85ebad) Thanks [@leoisadev1](https://github.com/leoisadev1)! - Settings chips in chat can now open Bot channels, Browser, Plugins, Sandbox, and Privacy. On mobile, in-app links no longer reach the system browser, and chips without a matching mobile screen open Settings.

- [#322](https://github.com/opencoredev/akeru-bot/pull/322) [`630de12`](https://github.com/opencoredev/akeru-bot/commit/630de12aeb4fe350ec957af323566a31aa85ebad) Thanks [@leoisadev1](https://github.com/leoisadev1)! - Settings groups its sections by task and shows a loading skeleton, the sidebar footer labels its links, Featured plugins show what they do, and the usage table scrolls on narrow windows.

- [#322](https://github.com/opencoredev/akeru-bot/pull/322) [`630de12`](https://github.com/opencoredev/akeru-bot/commit/630de12aeb4fe350ec957af323566a31aa85ebad) Thanks [@leoisadev1](https://github.com/leoisadev1)! - Ignore archived group members when checking provider availability and give a clear mention hint when the boss cannot reply.

- [#322](https://github.com/opencoredev/akeru-bot/pull/322) [`630de12`](https://github.com/opencoredev/akeru-bot/commit/630de12aeb4fe350ec957af323566a31aa85ebad) Thanks [@leoisadev1](https://github.com/leoisadev1)! - Load recent routine notes first and fetch older notes on demand in bot chats.

- [#322](https://github.com/opencoredev/akeru-bot/pull/322) [`630de12`](https://github.com/opencoredev/akeru-bot/commit/630de12aeb4fe350ec957af323566a31aa85ebad) Thanks [@leoisadev1](https://github.com/leoisadev1)! - A Settings link in chat that Akeru does not recognize now shows as plain text instead of a link that could open outside the app.

- [#322](https://github.com/opencoredev/akeru-bot/pull/322) [`630de12`](https://github.com/opencoredev/akeru-bot/commit/630de12aeb4fe350ec957af323566a31aa85ebad) Thanks [@leoisadev1](https://github.com/leoisadev1)! - Show new chat, channel, pairing, and settings labels in English and Chinese.

- [#322](https://github.com/opencoredev/akeru-bot/pull/322) [`630de12`](https://github.com/opencoredev/akeru-bot/commit/630de12aeb4fe350ec957af323566a31aa85ebad) Thanks [@leoisadev1](https://github.com/leoisadev1)! - The sidebar update button now matches the other sidebar icons. Download progress draws inside the icon instead of around the whole button, the "update available" dot is gone, and the button uses the shared control radius.

- [#322](https://github.com/opencoredev/akeru-bot/pull/322) [`630de12`](https://github.com/opencoredev/akeru-bot/commit/630de12aeb4fe350ec957af323566a31aa85ebad) Thanks [@leoisadev1](https://github.com/leoisadev1)! - Explain when an archived new bot can no longer open its first chat, and clear the pending handoff.

- Updated dependencies [[`630de12`](https://github.com/opencoredev/akeru-bot/commit/630de12aeb4fe350ec957af323566a31aa85ebad), [`630de12`](https://github.com/opencoredev/akeru-bot/commit/630de12aeb4fe350ec957af323566a31aa85ebad), [`630de12`](https://github.com/opencoredev/akeru-bot/commit/630de12aeb4fe350ec957af323566a31aa85ebad), [`630de12`](https://github.com/opencoredev/akeru-bot/commit/630de12aeb4fe350ec957af323566a31aa85ebad), [`630de12`](https://github.com/opencoredev/akeru-bot/commit/630de12aeb4fe350ec957af323566a31aa85ebad)]:
  - @akeru/contracts@0.2.0
  - @akeru/client-runtime@0.0.3
  - @akeru/shared@0.0.3

## 0.1.1

### Patch Changes

- Updated dependencies []:
  - @akeru/contracts@0.1.1
  - @akeru/client-runtime@0.0.2
  - @akeru/shared@0.0.2

## 0.1.0

### Patch Changes

- Updated dependencies []:
  - @akeru/contracts@0.1.0
  - @akeru/client-runtime@0.0.1
  - @akeru/shared@0.0.1

### Changes

- [#193](https://github.com/opencoredev/akeru-bot/pull/193) fix(marketing): connect Grok discovery pages to setup
- [#194](https://github.com/opencoredev/akeru-bot/pull/194) feat(web): add Read aloud for stored bot replies
- [#196](https://github.com/opencoredev/akeru-bot/pull/196) fix(marketing): recover downloads from stalled release requests
- [#197](https://github.com/opencoredev/akeru-bot/pull/197) perf(server): yield between filtered workspace search pages
- [#198](https://github.com/opencoredev/akeru-bot/pull/198) perf(protocol): make raw event retention opt-in
- [#201](https://github.com/opencoredev/akeru-bot/pull/201) perf(server): acquire browser attachments only for consuming connectors
- [#199](https://github.com/opencoredev/akeru-bot/pull/199) perf(server): index projected thread lookups
- [#204](https://github.com/opencoredev/akeru-bot/pull/204) fix(server): prefer origin for project repository identity
- [#205](https://github.com/opencoredev/akeru-bot/pull/205) fix(server): bound OpenCode CLI probes and serialize inventory
- [#207](https://github.com/opencoredev/akeru-bot/pull/207) fix(server): stop Windows terminal processes when closing
- [#211](https://github.com/opencoredev/akeru-bot/pull/211) fix(server): stop Windows terminal polling from spiking CPU
- [#219](https://github.com/opencoredev/akeru-bot/pull/219) fix(web): stop highlighter freezes by using Oniguruma WASM
- [#234](https://github.com/opencoredev/akeru-bot/pull/234) fix(mcp): allow text-only preview snapshots
- [#236](https://github.com/opencoredev/akeru-bot/pull/236) fix(server): bound session listing and keep a full idle window after turns
- [#238](https://github.com/opencoredev/akeru-bot/pull/238) fix(web): show bot and group message actions on touch
- [#249](https://github.com/opencoredev/akeru-bot/pull/249) fix(server): skip disabled provider instances for text generation fallback
- [#250](https://github.com/opencoredev/akeru-bot/pull/250) fix(server): preserve inline provider secrets on redacted saves
- [#231](https://github.com/opencoredev/akeru-bot/pull/231) fix(web): copy text over plain HTTP
- [#244](https://github.com/opencoredev/akeru-bot/pull/244) fix(server): stop overpricing cached Claude tokens
- [#246](https://github.com/opencoredev/akeru-bot/pull/246) perf(web): stop rendering hidden terminals
- [#233](https://github.com/opencoredev/akeru-bot/pull/233) fix(web): keep settings inputs focused during IME composition
- [#206](https://github.com/opencoredev/akeru-bot/pull/206) perf(server): bound terminal history incrementally
- [#255](https://github.com/opencoredev/akeru-bot/pull/255) perf(web): keep chat markdown mounted while text streams
- [#230](https://github.com/opencoredev/akeru-bot/pull/230) perf(server): skip full thread loads on projection and ingestion
- [#209](https://github.com/opencoredev/akeru-bot/pull/209) fix(codex): keep app-server protocol decode current
- [#226](https://github.com/opencoredev/akeru-bot/pull/226) feat(server): report image dimensions with signed asset URLs
- [#208](https://github.com/opencoredev/akeru-bot/pull/208) fix(server): isolate remote web session cookies
- [#227](https://github.com/opencoredev/akeru-bot/pull/227) perf(client): keep latestTurn and checkpoint refs stable while streaming
- [#164](https://github.com/opencoredev/akeru-bot/pull/164) feat(plugins): add local Executor MCP support
- [#200](https://github.com/opencoredev/akeru-bot/pull/200) perf(server): share concurrent usage reads and pricing refreshes
- [#202](https://github.com/opencoredev/akeru-bot/pull/202) fix(web): keep reply playback hooks stable during chat hydration
- [#203](https://github.com/opencoredev/akeru-bot/pull/203) perf(logging): drain bounded asynchronous writes before desktop exit
- [#210](https://github.com/opencoredev/akeru-bot/pull/210) fix(server): stop OpenCode child sessions and route their approvals
- [#256](https://github.com/opencoredev/akeru-bot/pull/256) fix(web): make desktop onboarding resilient
- [#257](https://github.com/opencoredev/akeru-bot/pull/257) fix(providers): hide disconnected providers
- [#252](https://github.com/opencoredev/akeru-bot/pull/252) fix(server): auto-reply full-access OpenCode permission asks
- [#212](https://github.com/opencoredev/akeru-bot/pull/212) fix(opencode): revert from the first removed assistant message
- [#258](https://github.com/opencoredev/akeru-bot/pull/258) feat(web): add custom bot avatar colors
- [#213](https://github.com/opencoredev/akeru-bot/pull/213) fix(mobile): preserve drafts after storage read failures
- [#214](https://github.com/opencoredev/akeru-bot/pull/214) fix(grok): probe health with initialize and allow in-session model changes
- [#224](https://github.com/opencoredev/akeru-bot/pull/224) fix(grok): encode session/cancel as a real notification and interrupt steers
- [#228](https://github.com/opencoredev/akeru-bot/pull/228) fix(grok): map Always allow to allow_once when Grok omits allow_always
- [#225](https://github.com/opencoredev/akeru-bot/pull/225) fix(grok): discover skills with grok inspect and fail workspace probes loudly
- [#220](https://github.com/opencoredev/akeru-bot/pull/220) fix(server): capture complete turn checkpoints after edits finish
- [#229](https://github.com/opencoredev/akeru-bot/pull/229) fix(server): keep attachments until commit and allow first-send retry
- [#215](https://github.com/opencoredev/akeru-bot/pull/215) fix(ssh): keep managed remote server ownership through stop
- [#216](https://github.com/opencoredev/akeru-bot/pull/216) perf(server): bound orchestration replay and slow-client live buffers
- [#217](https://github.com/opencoredev/akeru-bot/pull/217) fix(desktop): separate LAN and Tailscale pairing endpoints
- [#218](https://github.com/opencoredev/akeru-bot/pull/218) feat(web): complete live roster drag for bots and groups
- [#221](https://github.com/opencoredev/akeru-bot/pull/221) fix(editors): open remote projects in Zed
- [#222](https://github.com/opencoredev/akeru-bot/pull/222) feat(desktop): complete quit shortcut confirmation modes
- [#223](https://github.com/opencoredev/akeru-bot/pull/223) fix(desktop): pin preview CDP debugger across webview teardown
- [#232](https://github.com/opencoredev/akeru-bot/pull/232) fix(desktop): isolate preview shortcuts from the host
- [#235](https://github.com/opencoredev/akeru-bot/pull/235) fix(desktop): enable context menus in the in-app browser
- [#237](https://github.com/opencoredev/akeru-bot/pull/237) fix(claude): derive usage and name login or limit errors
- [#239](https://github.com/opencoredev/akeru-bot/pull/239) perf(server): stream static files and cache hashed build assets
- [#240](https://github.com/opencoredev/akeru-bot/pull/240) perf(server): drop transient native events from provider logs
- [#241](https://github.com/opencoredev/akeru-bot/pull/241) fix(threads): keep completed questions closed across clients
- [#242](https://github.com/opencoredev/akeru-bot/pull/242) perf(client): stop replaying terminal buffers on rollover
- [#243](https://github.com/opencoredev/akeru-bot/pull/243) feat(web): add provider model bulk visibility toggle
- [#245](https://github.com/opencoredev/akeru-bot/pull/245) fix: stop favicon requests for private chat-link hosts
- [#247](https://github.com/opencoredev/akeru-bot/pull/247) fix(server): disable executable tools in Claude metadata generation
- [#248](https://github.com/opencoredev/akeru-bot/pull/248) perf(web): avoid repeated terminal metadata scans
- [#251](https://github.com/opencoredev/akeru-bot/pull/251) perf(server): index OpenCode text by message and drop unused tool parts
- [#253](https://github.com/opencoredev/akeru-bot/pull/253) feat(shared): map text generation models by provider identity
- [#254](https://github.com/opencoredev/akeru-bot/pull/254) fix(claude): run composer-picked skills as slash commands

## @akeru/web@0.0.40

### Changes

- [#176](https://github.com/opencoredev/akeru-bot/pull/176) feat(providers): add API key connections with custom endpoints
- [#178](https://github.com/opencoredev/akeru-bot/pull/178) fix(server): keep libsql native loader external to the CLI bundle
- [#182](https://github.com/opencoredev/akeru-bot/pull/182) fix(desktop): own dev and smoke Electron processes instead of pkill
- [#180](https://github.com/opencoredev/akeru-bot/pull/180) feat(scripts): add dev status, worktree setup, UI fixtures, and pairing helpers
- [#183](https://github.com/opencoredev/akeru-bot/pull/183) docs(agents): add verification policy and rewrite testing skills
- [#184](https://github.com/opencoredev/akeru-bot/pull/184) fix(desktop): stop claiming legacy t3code:// protocol schemes
- [#185](https://github.com/opencoredev/akeru-bot/pull/185) fix(release): recover version PR updates from Tegami's boxed errors
- [#188](https://github.com/opencoredev/akeru-bot/pull/188) fix(feedback): send product feedback to the deployed Worker
- [#191](https://github.com/opencoredev/akeru-bot/pull/191) feat(web): add Akeru Noir and flatten shared controls
- [#189](https://github.com/opencoredev/akeru-bot/pull/189) feat(install): add release-pinned installer scripts
- [#192](https://github.com/opencoredev/akeru-bot/pull/192) fix(plugins): renew stale Hoplite OAuth registrations
- [#190](https://github.com/opencoredev/akeru-bot/pull/190) feat(channels): connect external conversations to bots

## @akeru/web@0.0.39

### Changes

- [#141](https://github.com/opencoredev/akeru-bot/pull/141) fix(web): mute routine notices and update actions
- [#151](https://github.com/opencoredev/akeru-bot/pull/151) feat(marketing): add feedback.md, versioned metadata API, rate-limit headers
- [#153](https://github.com/opencoredev/akeru-bot/pull/153) fix(desktop): recover failed update installs
- [#154](https://github.com/opencoredev/akeru-bot/pull/154) fix(release): require signed macOS builds
- [#155](https://github.com/opencoredev/akeru-bot/pull/155) fix(desktop): package lazy server dependencies
- [#156](https://github.com/opencoredev/akeru-bot/pull/156) fix(mcp): open OAuth authorization requests
- [#149](https://github.com/opencoredev/akeru-bot/pull/149) feat(marketing): report page requests to Notra GEO
- [#158](https://github.com/opencoredev/akeru-bot/pull/158) ci: migrate Depot workflows to Tenki
- [#150](https://github.com/opencoredev/akeru-bot/pull/150) fix(settings): remove obsolete thread controls
- [#159](https://github.com/opencoredev/akeru-bot/pull/159) fix(chat): improve bot conversation usability
- [#157](https://github.com/opencoredev/akeru-bot/pull/157) feat(plugins): add Composio integrations
- [#162](https://github.com/opencoredev/akeru-bot/pull/162) fix(plugins): complete OAuth connections
- [#163](https://github.com/opencoredev/akeru-bot/pull/163) feat(marketing): add Grok search pages

## @akeru/web@0.0.38

### Changes

- [#126](https://github.com/opencoredev/akeru-bot/pull/126) fix(web): replace sidebar footer labels with icons
- [#109](https://github.com/opencoredev/akeru-bot/pull/109) docs: update user guides for subscription runtimes
- [#127](https://github.com/opencoredev/akeru-bot/pull/127) feat(web): switch bots with number shortcuts
- [#129](https://github.com/opencoredev/akeru-bot/pull/129) fix(web): show Grok models during limited probes
- [#135](https://github.com/opencoredev/akeru-bot/pull/135) docs: align agent guidance with Akeru Bot
- [#138](https://github.com/opencoredev/akeru-bot/pull/138) ci: validate merge queue candidates with Depot
- [#139](https://github.com/opencoredev/akeru-bot/pull/139) feat(bots): move model controls to sidebar
- [#136](https://github.com/opencoredev/akeru-bot/pull/136) fix(channels): restore settings and delivery
- [#140](https://github.com/opencoredev/akeru-bot/pull/140) feat(bots): personalize Akeru prompts
- [#144](https://github.com/opencoredev/akeru-bot/pull/144) ci: run Depot checks on pull requests
- [#146](https://github.com/opencoredev/akeru-bot/pull/146) ci: migrate workflows to tenki
- [#142](https://github.com/opencoredev/akeru-bot/pull/142) feat(plugins): add Hoplite MCP integration
- [#147](https://github.com/opencoredev/akeru-bot/pull/147) fix(brand): use the Akeru icon in development
- [#143](https://github.com/opencoredev/akeru-bot/pull/143) perf(server): reduce streaming and tool update overhead
- [#148](https://github.com/opencoredev/akeru-bot/pull/148) perf(ui): replace class merging with cn
- [#137](https://github.com/opencoredev/akeru-bot/pull/137) feat(providers): add OpenCode Go support
- [#145](https://github.com/opencoredev/akeru-bot/pull/145) feat(web): add first-install bot onboarding
- [#123](https://github.com/opencoredev/akeru-bot/pull/123) fix(macos): install unsigned Mac builds from a checksummed GitHub DMG
- [#133](https://github.com/opencoredev/akeru-bot/pull/133) feat(approvals): add auto review and bot prompts

## @akeru/web@0.0.37

### Changes

- [#124](https://github.com/opencoredev/akeru-bot/pull/124) fix(web): prevent duplicate bot panes

## @akeru/web@0.0.36

### Changes

- [#114](https://github.com/opencoredev/akeru-bot/pull/114) fix(release): ship desktop apps without CLI
- [#115](https://github.com/opencoredev/akeru-bot/pull/115) fix(legal): preserve licenses and correct fork attribution
- [#116](https://github.com/opencoredev/akeru-bot/pull/116) feat(marketing): explain unsigned macOS downloads
- [#117](https://github.com/opencoredev/akeru-bot/pull/117) fix(release): launch packaged desktop apps before publishing

## @akeru/web@0.0.35

### Changes

- [#11](https://github.com/opencoredev/akeru-bot/pull/11) feat(voice): add local desktop bot calls
- [#14](https://github.com/opencoredev/akeru-bot/pull/14) feat(brand): add lowercase Akeru icon
- [#15](https://github.com/opencoredev/akeru-bot/pull/15) fix(usage): stabilize provider logos and labels
- [#13](https://github.com/opencoredev/akeru-bot/pull/13) ci: run Akeru checks on Depot
- [#12](https://github.com/opencoredev/akeru-bot/pull/12) fix(voice): make local calls realtime
- [#16](https://github.com/opencoredev/akeru-bot/pull/16) perf(runtime): adopt provider-neutral upstream fixes
- [#18](https://github.com/opencoredev/akeru-bot/pull/18) feat(feedback): add the product feedback workflow
- [#17](https://github.com/opencoredev/akeru-bot/pull/17) feat(bots): add connector health and error inbox
- [#19](https://github.com/opencoredev/akeru-bot/pull/19) feat(plugins): load declarative catalog entries
- [#20](https://github.com/opencoredev/akeru-bot/pull/20) feat(plugins): ship the curated plugin directory
- [#28](https://github.com/opencoredev/akeru-bot/pull/28) test(mobile): cover bot inbox empty and error states
- [#21](https://github.com/opencoredev/akeru-bot/pull/21) fix(server): persist Kimi device identity
- [#23](https://github.com/opencoredev/akeru-bot/pull/23) feat(settings): add bot workspace and browser sharing
- [#22](https://github.com/opencoredev/akeru-bot/pull/22) feat(contracts): define Akeru memory and usage records
- [#25](https://github.com/opencoredev/akeru-bot/pull/25) fix(server): redact browser snapshot data
- [#24](https://github.com/opencoredev/akeru-bot/pull/24) feat(server): add durable bot memory storage
- [#27](https://github.com/opencoredev/akeru-bot/pull/27) feat(contracts): define approved Akeru workspace tools
- [#32](https://github.com/opencoredev/akeru-bot/pull/32) feat(server): add sandbox browser runtime
- [#29](https://github.com/opencoredev/akeru-bot/pull/29) feat(providers): add Kimi For Coding runtime
- [#31](https://github.com/opencoredev/akeru-bot/pull/31) feat(server): add bot inbox controls
- [#33](https://github.com/opencoredev/akeru-bot/pull/33) feat(web): resolve bot inbox incidents
- [#38](https://github.com/opencoredev/akeru-bot/pull/38) feat(mobile): resolve bot inbox incidents
- [#36](https://github.com/opencoredev/akeru-bot/pull/36) feat(server): isolate and pool bot workspaces
- [#37](https://github.com/opencoredev/akeru-bot/pull/37) fix(memory): preserve storage correctness
- [#39](https://github.com/opencoredev/akeru-bot/pull/39) feat(server): run approved Akeru tools
- [#41](https://github.com/opencoredev/akeru-bot/pull/41) feat(server): add governed memory tool handlers
- [#40](https://github.com/opencoredev/akeru-bot/pull/40) feat(server): record human handoff incidents
- [#35](https://github.com/opencoredev/akeru-bot/pull/35) feat(server): enforce per-bot token usage caps
- [#44](https://github.com/opencoredev/akeru-bot/pull/44) fix(memory): preserve pending update governance
- [#45](https://github.com/opencoredev/akeru-bot/pull/45) feat(memory): add RPC and shared client state
- [#48](https://github.com/opencoredev/akeru-bot/pull/48) feat(server): expose per-bot usage over RPC
- [#50](https://github.com/opencoredev/akeru-bot/pull/50) feat(web): show per-bot usage
- [#53](https://github.com/opencoredev/akeru-bot/pull/53) feat(portability): restore archives across environments
- [#52](https://github.com/opencoredev/akeru-bot/pull/52) feat(memory): wire governed memory tools into Mastra
- [#46](https://github.com/opencoredev/akeru-bot/pull/46) feat(web): manage bot memory
- [#55](https://github.com/opencoredev/akeru-bot/pull/55) feat(bots): reply before tools with status beats
- [#49](https://github.com/opencoredev/akeru-bot/pull/49) feat(memory): observe new thread messages
- [#57](https://github.com/opencoredev/akeru-bot/pull/57) chore(contributing): verify plugin proposal policy
- [#61](https://github.com/opencoredev/akeru-bot/pull/61) test(server): prove saved provider routing
- [#54](https://github.com/opencoredev/akeru-bot/pull/54) feat(app): ask before local agent commands
- [#62](https://github.com/opencoredev/akeru-bot/pull/62) fix(server): redact screenshot tool results
- [#59](https://github.com/opencoredev/akeru-bot/pull/59) feat(server): track MCP connector health
- [#58](https://github.com/opencoredev/akeru-bot/pull/58) fix(plugins): align directory with connector lifecycle
- [#60](https://github.com/opencoredev/akeru-bot/pull/60) feat(analytics): send anonymous usage summaries
- [#64](https://github.com/opencoredev/akeru-bot/pull/64) feat(server): delegate work between bots
- [#67](https://github.com/opencoredev/akeru-bot/pull/67) feat(marketing): rebuild the landing page from the Paper design
- [#65](https://github.com/opencoredev/akeru-bot/pull/65) feat(providers): finish native Kimi support
- [#66](https://github.com/opencoredev/akeru-bot/pull/66) fix(server): preserve rewritten Mastra replies
- [#63](https://github.com/opencoredev/akeru-bot/pull/63) feat(server): add durable remote sandboxes
- [#74](https://github.com/opencoredev/akeru-bot/pull/74) feat(server): let bot bosses manage channels
- [#69](https://github.com/opencoredev/akeru-bot/pull/69) feat(server): run browsers in remote sandboxes
- [#80](https://github.com/opencoredev/akeru-bot/pull/80) feat(server): let bots message the current thread
- [#71](https://github.com/opencoredev/akeru-bot/pull/71) fix(web): keep group avatars during search
- [#72](https://github.com/opencoredev/akeru-bot/pull/72) fix(web): widen rich bot output
- [#73](https://github.com/opencoredev/akeru-bot/pull/73) fix(analytics): report opt-out deletion failures
- [#75](https://github.com/opencoredev/akeru-bot/pull/75) feat(server): manage MCP connections from bots
- [#76](https://github.com/opencoredev/akeru-bot/pull/76) feat(bots): show sensitive approval cards
- [#82](https://github.com/opencoredev/akeru-bot/pull/82) feat(server): let bots install URL plugins
- [#56](https://github.com/opencoredev/akeru-bot/pull/56) feat(akeru): finish sandbox and memory reliability
- [#68](https://github.com/opencoredev/akeru-bot/pull/68) feat(plugins): add local Codex computer use
- [#85](https://github.com/opencoredev/akeru-bot/pull/85) feat(marketing): add PostHog web analytics
- [#84](https://github.com/opencoredev/akeru-bot/pull/84) fix(memory): bind legacy workspace access to original project
- [#87](https://github.com/opencoredev/akeru-bot/pull/87) feat(server): let bots update their own profiles
- [#77](https://github.com/opencoredev/akeru-bot/pull/77) feat(server): enforce bounded bot delegation
- [#91](https://github.com/opencoredev/akeru-bot/pull/91) fix(marketing): improve agent readiness
- [#78](https://github.com/opencoredev/akeru-bot/pull/78) feat(web): show and control bot delegations
- [#93](https://github.com/opencoredev/akeru-bot/pull/93) fix(marketing): finish agent readiness gaps
- [#88](https://github.com/opencoredev/akeru-bot/pull/88) feat(server): add bot plugin controls
- [#90](https://github.com/opencoredev/akeru-bot/pull/90) feat(server): add durable bot management tools
- [#83](https://github.com/opencoredev/akeru-bot/pull/83) feat(trust): ship privacy and control milestone
- [#86](https://github.com/opencoredev/akeru-bot/pull/86) feat(server): add MCP health controls
- [#92](https://github.com/opencoredev/akeru-bot/pull/92) feat(release): ship stable direct downloads
- [#89](https://github.com/opencoredev/akeru-bot/pull/89) feat(bots): react to visible messages
- [#81](https://github.com/opencoredev/akeru-bot/pull/81) feat(settings): connect remote sandbox providers
