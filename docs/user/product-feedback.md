# Product feedback

Open **Feedback** from the sidebar or command palette. You can also select **Send feedback** in **Settings → About**. Desktop builds include **Help → Send Feedback**.

Write the feedback and select **Send**. Select **Choose an element** to attach a privacy-safe reference to part of the Akeru Bot interface. The picker does not collect form values, page HTML, screenshots, files, workspace paths, or full URLs.

A submission contains:

- Feedback text, up to 4,000 characters.
- An optional interface element descriptor.

It does not contain screenshots, raw DOM, input values, credentials, tool results, a thread, or a full conversation. No account is required. A failed send keeps the draft. A confirmed send clears it.

Akeru Bot keeps accepted feedback for 90 days. Turn off **Product feedback** in **Settings → Privacy** to disable sending. Self-hosted environments can set an HTTPS endpoint in **Settings → About**. Loopback HTTP endpoints are allowed for local testing.

Codex-backed Akeru bots can propose feedback text. A proposal can only add bounded text to the same editable draft after one-time approval. The bot cannot send it. You must select **Send** for each submission. Review agent proposals on web or desktop. Mobile can cancel them but cannot open the draft in this version.
