# AI Memos - Link Metadata Branch

This branch enhances the existing "get current tab link" action with Memos link metadata.

## What Changed

- Adds a Memos API helper for link metadata lookup.
- Uses the active browser tab URL as the metadata target.
- Inserts a richer Markdown link when Memos returns title or description metadata.
- Falls back to the original Markdown link when the extension is not configured or the metadata API fails.
- Escapes Markdown-sensitive title and description characters before insertion.

## Key Files

- `js/memos-api.js` - adds `getLinkMetadata`.
- `js/oper.js` - builds metadata-aware Markdown and updates the `#getlink` click handler.

## Verification

Run these checks from the repository root:

```powershell
git diff --check main..codex/memos-link-metadata
node --check js/memos-api.js
node --check js/oper.js
rg "<<<<<<<|=======|>>>>>>>"
```

## Manual Test Notes

1. Configure a valid Memos server URL and token.
2. Open a normal web page in the active tab.
3. Click the link insertion tool.
4. Confirm the inserted Markdown uses metadata when available.
5. Disable or break the Memos configuration and confirm the tool still inserts a basic `[title](url)` link.

## Merge Notes

This branch inserts helper functions near other popup helpers in `js/oper.js`. When merging with UI-heavy branches, keep `buildLinkMarkdown`, `getMetadataValue`, and the enhanced `#getlink` handler.
