# AI Memos - Beta Test Branch

This branch is the integration branch for testing the Memos feature work together.

## Included Branches

- `codex/memos-shortcuts-panel` - adds a popup shortcuts panel backed by Memos shortcuts and memo filters.
- `codex/memos-link-metadata` - enhances current tab link insertion with Memos link metadata and fallback Markdown.
- `codex/memos-create-options` - adds optional `pinned` and `createTime` fields for memo creation.
- `codex/memos-feature-roadmap` - documents the feature branch matrix and follow-up recommendations.

## What Changed

- Combines shortcut browsing, link metadata insertion, and create memo options in one branch.
- Keeps Memos API access centralized in `js/memos-api.js`.
- Keeps shared popup behavior in `js/oper.js` while preserving visibility, upload, random/search, and archive flows.
- Includes the roadmap document at `docs/memos-feature-roadmap.md`.

## Key Files

- `js/memos-api.js` - combined Memos API helpers for shortcuts, link metadata, memo create, attachments, and memo lookup.
- `js/oper.js` - integrated popup behavior for shortcuts, link metadata, create options, and existing memo actions.
- `popup.html` - combined popup controls for shortcuts and create options.
- `css/main.css` - combined styling for shortcuts and create options.
- `_locales/*/messages.json`, `js/i18n.js`, and `js/theme-lang.js` - localized labels and dynamic text updates.
- `docs/memos-feature-roadmap.md` - roadmap and branch matrix.

## Verification

Run these checks from the repository root:

```powershell
git status --short --branch
git diff --check main..codex/memos-beta-test
node --check js/memos-api.js
node --check js/oper.js
node --check js/theme-lang.js
node --check js/i18n.js
node -e "const fs=require('fs'); ['manifest.json','_locales/en/messages.json','_locales/ja/messages.json','_locales/zh_CN/messages.json'].forEach(f=>JSON.parse(fs.readFileSync(f,'utf8')));"
git merge-base --is-ancestor codex/memos-shortcuts-panel codex/memos-beta-test
git merge-base --is-ancestor codex/memos-link-metadata codex/memos-beta-test
git merge-base --is-ancestor codex/memos-create-options codex/memos-beta-test
git merge-base --is-ancestor codex/memos-feature-roadmap codex/memos-beta-test
rg "<<<<<<<|=======|>>>>>>>"
```

## Manual Test Notes

1. Configure a valid Memos server URL and token in the extension.
2. Confirm shortcut loading and shortcut-filtered memo listing work.
3. Confirm current tab link insertion uses metadata when available and falls back to the basic Markdown link when unavailable.
4. Confirm new memos can still be created with default behavior when create options are disabled.
5. Confirm pinned and create time options are persisted and applied only when enabled.
6. Confirm existing memo search, random memo, tag insertion, visibility, upload, and archive flows still work.

## Merge Notes

This branch manually resolved the `js/oper.js` overlap between the shortcuts and link metadata branches. Keep the shortcut helpers, link metadata helpers, and create option helpers together if this branch is rebased or merged again.
