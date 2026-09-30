# Watch and control a bot's computer

A bot that works in a Daytona sandbox has its own desktop with a browser. You can watch that screen
live, take control to click and type for the bot, then hand control back.

## Open the computer

Open the computer from either place. Both show the same screen.

- In a bot chat, open the bot panel and select **Open computer**.
- When a bot asks you a question, select **Open _bot name_'s computer** under the question. This
  helps when the bot needs you to sign in, solve a check, or confirm something on a page.

The computer window shows who is in control: the bot, you, someone else, or no one.

## Take control and hand it back

1. Select **Take control**. The bot finishes its current browser step, then waits.
2. Click, type, paste, and scroll on the picture. Most keyboard shortcuts, such as Ctrl+C, go to the
   bot's computer while the picture has focus.
3. Select **Return to _bot name_** when you are done. The bot continues its work.

Only one person controls the computer at a time. If someone else already has control, **Take
control** stays unavailable until they return it.

Control lasts up to one minute and cannot be extended. When the minute runs out, the computer stops
so that no one keeps typing into a screen the bot also drives. Select **Resume** to start it again,
then take control again if you still need it.

## Stop the computer

Select **Stop** to stop the computer immediately, whoever is in control. The bot cannot use its
browser until you select **Resume**.

## When control ends on its own

Your control ends, and the computer stops, when:

- your minute of control runs out
- your connection to the environment drops
- the bot's sandbox pauses or the bot's work ends

When you close the computer window, switch to another page, or hide the app, the picture stops and
control returns to the bot. The computer keeps running. When control ends, the window says why and
offers **Resume** when that applies.

## Supported computers

| Bot setup                                               | Computer                                                  |
| ------------------------------------------------------- | --------------------------------------------------------- |
| Daytona sandbox with a Codex or Kimi For Coding engine  | Watch and control                                         |
| Daytona sandbox with a Claude, Grok, or OpenCode engine | Not available yet                                         |
| Local workspace                                         | Not available. A local workspace has no separate desktop. |
| E2B, Vercel Sandbox, or Upstash Box                     | Not available. These sandboxes have no graphical desktop. |

The computer starts when the bot begins work in its Daytona sandbox. If the window says the computer
has not started, send the bot a message and open the computer again. To set up Daytona, see
[Configure sandboxes](./sandboxes.md).

The desktop app and the web client can watch and control the computer. The mobile app shows when a
bot's computer is running and asks you to open Akeru Bot on a desktop or in a web browser.

## Privacy

- The picture streams only while the computer window is open and visible.
- Pictures, your clicks, and the text you type are not saved to the chat, chat history, routines,
  or usage analytics.
- Commands the bot runs in its terminal can still reach the desktop while you are in control. Stop
  the computer if you need the bot to pause everything.

## Recover from problems

| What you see                          | What to do                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------- |
| "Your minute of control ran out"      | Select **Resume**, then **Take control** again.                                       |
| "The connection dropped"              | Wait for the environment to reconnect, then select **Resume**.                        |
| "Someone else took control first"     | Wait for them to return control, or ask them to.                                      |
| "The computer did not accept that"    | Control has returned to the bot. Select **Take control** to try again.                |
| "The computer is no longer available" | The bot's work ended or its sandbox paused. Send the bot a message to start it again. |
