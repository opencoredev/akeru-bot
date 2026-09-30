---
"akeru-bot": minor
---

Remove the remaining coding-agent features inherited from T3 Code. The user terminal, the mobile files, Git, and Add Project screens, the GitHub, GitLab, Azure DevOps, and Bitbucket integrations, the `t3.json` project file, project icons, the local/worktree choice for new chats, and plan mode are gone. New chats start in the project checkout, and worktree branch names use the default text generation model. Chats and settings saved by older versions still load: plan-mode chats continue in default mode, and old pairing links and tokens that carry the terminal scope keep working without it.
