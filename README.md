# AI Memos - Shortcuts Panel Branch

This branch adds a Memos shortcuts panel to the Chrome extension popup.

## What Changed

- Adds a shortcuts tool in the popup toolbar.
- Fetches Memos shortcuts through the Memos API adapter.
- Resolves the current Memos user before loading shortcuts.
- Runs shortcut filters through the memo list API.
- Renders shortcut result memos with the existing memo preview UI.
- Adds localized messages and compact shortcut styling.

## Key Files

- `js/memos-api.js` - adds shortcut API access.
- `js/oper.js` - loads shortcuts, renders shortcut buttons, and lists filtered memos.
- `popup.html` - adds the shortcuts button and shortcut list container.
- `css/main.css` - adds shortcut list styling.
- `_locales/*/messages.json` - adds shortcut-related UI messages.
- `js/theme-lang.js` - wires shortcut text into theme/language switching.

## Verification

Run these checks from the repository root:

```powershell
git diff --check main..codex/memos-shortcuts-panel
node --check js/memos-api.js
node --check js/oper.js
node --check js/theme-lang.js
node -e "const fs=require('fs'); ['manifest.json','_locales/en/messages.json','_locales/ja/messages.json','_locales/zh_CN/messages.json'].forEach(f=>JSON.parse(fs.readFileSync(f,'utf8')));"
rg "<<<<<<<|=======|>>>>>>>"
```

## Manual Test Notes

1. Configure a valid Memos server URL and token in the extension.
2. Open the popup and click the shortcuts tool.
3. Confirm shortcuts are listed.
4. Click a shortcut and confirm matching memos are rendered.
5. Confirm empty shortcuts or empty results show a localized message instead of failing silently.

## Merge Notes

This branch touches shared popup UI files and `js/oper.js`. When combining it with other Memos feature branches, keep the shortcuts helpers and click handlers alongside the other feature-specific helpers.
