# Memos latest API feature branches

This document records the feature branches created from the latest Memos API review on 2026-06-06.

## Branches created

| Branch | Scope | Main files |
| --- | --- | --- |
| `codex/memos-shortcuts-panel` | Adds a popup Shortcuts panel backed by Memos shortcuts and memo filters. | `js/memos-api.js`, `js/oper.js`, `popup.html`, `css/main.css`, `_locales/*/messages.json`, `js/theme-lang.js` |
| `codex/memos-link-metadata` | Enhances the existing link insertion action with Memos link metadata, with fallback to the original Markdown link. | `js/memos-api.js`, `js/oper.js` |
| `codex/memos-create-options` | Adds memo creation options for `pinned` and `createTime`, preserving the default create body when options are disabled. | `popup.html`, `js/oper.js`, `css/main.css`, `js/i18n.js`, `js/theme-lang.js`, `_locales/*/messages.json` |

## Official API basis

- Memos latest API reference is under `https://usememos.com/docs/api/latest`.
- Shortcuts branch uses `ShortcutService.ListShortcuts` and `MemoService.ListMemos` filter queries.
- Link metadata branch uses `MemoService.GetLinkMetadata`.
- Create options branch uses `MemoService.CreateMemo` fields from the latest API schema, especially `pinned` and `createTime`.

## Verification run

Each feature branch was checked with the relevant subset of:

```powershell
git diff --check
node --check js\memos-api.js
node --check js\oper.js
node --check js\theme-lang.js
node --check js\i18n.js
Get-Content -Raw '_locales\zh_CN\messages.json' | ConvertFrom-Json | Out-Null
Get-Content -Raw '_locales\en\messages.json' | ConvertFrom-Json | Out-Null
Get-Content -Raw '_locales\ja\messages.json' | ConvertFrom-Json | Out-Null
```

## Next candidates

These are good follow-up branches after reviewing and merging the first three:

- `codex/memos-comments`: add a reply/comment action from search or random review results.
- `codex/memos-share-links`: add one-click memo share creation and copy/open behavior.
- `codex/memos-stats-notifications`: add a lightweight status panel for user stats and notifications.
- `codex/memos-ai-transcribe`: add audio upload/transcribe flow for Memos instances with AI service configured.
- `codex/memos-relations`: add source/reference relationship controls when creating from a page or another memo.

## Notes from this run

- Multiple subagents initially shared one checkout, so early mixed changes were stashed as `mixed subagent memos feature work` and then manually split into clean branches.
- Keep future parallel agents in separate worktrees or use thread worktree forks to avoid mixed working-tree state.
- Prefer narrow API helpers in `js/memos-api.js` and keep popup behavior backward compatible.
