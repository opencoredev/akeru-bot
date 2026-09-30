---
"@akeru/contracts": minor
---

Provider skills now carry an optional per-skill icon. Codex reports the icon paths from its skill interface metadata, Claude reads an `icon` key from SKILL.md frontmatter, and Grok forwards the icon from `grok inspect`. OpenCode reports no icon field and Kimi For Coding has no skill-loading mechanism, so those catalogs stay icon-less by design. Clients fall back to the existing source-kind badge when a skill has no icon.
