# Provider access

Each provider in **Settings > Providers** says what unlocks it, what the current environment has saved, and the one thing to do next. This page explains those lines and what each subscription does and does not include.

## What each provider needs

| Provider        | Unlocks with                                    | Other credential                                           | API access from the subscription                                                                      |
| --------------- | ----------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| ChatGPT (Codex) | ChatGPT Plus, Pro, Business, Enterprise, or Edu | OpenAI API key, billed separately by OpenAI                | No. A ChatGPT subscription does not include OpenAI API access.                                        |
| Claude          | Claude Pro or Max                               | Anthropic API key, billed separately in the Claude Console | No. Pro and Max do not include Anthropic API access.                                                  |
| Grok            | SuperGrok or X Premium+ on your xAI account     | xAI API key, billed separately by xAI                      | No. SuperGrok and X Premium+ do not include xAI API credits.                                          |
| Kimi For Coding | Kimi For Coding membership                      | Kimi For Coding API key from the Kimi Code console         | No. The membership works only in coding tools and does not include Moonshot Open Platform API credit. |
| OpenCode Go     | OpenCode Go subscription API key                | None                                                       | The key is API access, but only to OpenCode Go models through OpenCode.                               |

Akeru cannot see which xAI plan an account has. Sign in with the account that has SuperGrok or X Premium+.

Cursor is not a provider in Akeru.

## Usage limits

Providers set their own limits. Akeru shows what each provider publishes and does not show numbers that change without notice.

- **ChatGPT (Codex):** limits per 5-hour window and per week. The allowance depends on the plan.
- **Claude:** limits per 5-hour session and per week. Max allows more use than Pro.
- **Grok:** xAI does not publish Grok limits that Akeru can show.
- **Kimi For Coding:** limits depend on the membership tier. The Kimi Code console shows them.
- **OpenCode Go:** limits per 5-hour window, per week, and per month.

To see how much of a limit you have used, open [Usage](./usage.md).

## Access states

A saved login or key does not make a provider ready. Access is **Ready** only after the environment sends a request to the provider and it succeeds.

| State            | Meaning                                                    | Next step                                                                            |
| ---------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Not connected    | This environment has no login or key for the provider.     | Choose **Connect**.                                                                  |
| Checking access  | The environment is sending a health request.               | Wait for it to finish.                                                               |
| Not verified yet | A login or key is saved, but no request has succeeded yet. | Choose **Check OAuth** or **Check key**.                                             |
| Ready            | A provider request succeeded.                              | None.                                                                                |
| Login expired    | The provider rejected an expired login or key.             | Choose **Reconnect** or **Reconnect key**.                                           |
| Access revoked   | The provider revoked the login or key.                     | Choose **Reconnect** or **Reconnect key**.                                           |
| Check failed     | The last health request failed.                            | Check that the subscription is active or that the key has billing, then check again. |

## Where to find it

On desktop and web, each provider row shows its state and next step. Choose **Access details** to see what unlocks the provider, which models the environment offers, whether the subscription includes API access, the published limits, and what this environment has saved.

On mobile, open **Settings > Provider connections**. Each provider shows the same state and next step, and **Access details** shows the rest.

Connections belong to one environment. A provider that is ready on one Akeru server can still be missing on another.
