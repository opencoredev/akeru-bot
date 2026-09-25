# When a bot goes quiet

Sometimes a provider stops sending anything while a bot is still working. After 90 seconds with no output, the chat stops showing the working indicator and says "No response from" the provider, for example "No response from Claude". The timer next to it counts from the last time the provider sent something.

The bot also gets one item in the inbox, labeled "Bot stopped responding". Akeru does not stop the turn for you.

- If the provider starts responding again, the notice goes away and the inbox item resolves on its own.
- If you would rather not wait, stop the turn from the composer and send your message again.
- If the same turn goes quiet more than once, the same inbox item comes back instead of a new one.
- When the turn finishes or you stop it, the inbox item resolves.

Time the bot spends waiting for your approval or your answer to a question does not count as silence.

A quiet stretch is not always a problem. Long builds, test runs, and large file reads can keep a provider busy without output. If providers go quiet often, check your connection to the environment and the provider's status page.
