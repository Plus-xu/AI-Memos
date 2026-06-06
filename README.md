# AI Memos - Create Options Branch

This branch adds optional Memos creation controls to the Chrome extension popup.

## What Changed

- Adds a pinned checkbox for new memos.
- Adds an optional local datetime input for `createTime`.
- Persists create option choices in Chrome sync storage.
- Sends `pinned` and `createTime` only when the related options are enabled.
- Keeps the original memo creation body unchanged when both options are disabled.
- Adds localized labels, tooltips, validation messages, and compact popup styling.

## Key Files

- `popup.html` - adds the create option controls under the memo editor.
- `js/oper.js` - loads, saves, validates, and applies create options.
- `css/main.css` - styles the create option row.
- `js/i18n.js` - initializes create option labels and tooltip text.
- `js/theme-lang.js` - keeps labels updated when switching language/theme.
- `_locales/*/messages.json` - adds localized create option messages.

## Verification

Run these checks from the repository root:

```powershell
git diff --check main..codex/memos-create-options
node --check js/oper.js
node --check js/theme-lang.js
node --check js/i18n.js
node -e "const fs=require('fs'); ['manifest.json','_locales/en/messages.json','_locales/ja/messages.json','_locales/zh_CN/messages.json'].forEach(f=>JSON.parse(fs.readFileSync(f,'utf8')));"
rg "<<<<<<<|=======|>>>>>>>"
```

## Manual Test Notes

1. Create a memo with both options disabled and confirm the normal create flow still works.
2. Enable pinned and confirm the created memo is pinned.
3. Enable memo time, choose a datetime, and confirm `createTime` is sent as an ISO timestamp.
4. Confirm the datetime input is disabled until its checkbox is enabled.
5. Confirm saved option values are restored when reopening the popup.

## Merge Notes

This branch touches popup UI, storage defaults, and the create memo payload in `js/oper.js`. When combining it with other feature branches, keep the create option helpers and ensure `sendText` still includes content, visibility, attachments, and the optional create fields.
