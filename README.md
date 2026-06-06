# AI Memos - Memos Feature Roadmap Branch

This branch documents the Memos API feature ideas that were split into separate implementation branches.

## What Changed

- Adds a roadmap document for the Memos feature branches.
- Summarizes which feature branch owns each proposed capability.
- Records the relevant Memos API surfaces used by the feature branches.
- Lists rollout order, merge notes, and follow-up recommendations.

## Key Files

- `docs/memos-feature-roadmap.md` - the main feature matrix and rollout notes.

## Related Branches

- `codex/memos-shortcuts-panel` - popup shortcuts panel backed by Memos shortcuts and filters.
- `codex/memos-link-metadata` - metadata-aware current tab link insertion.
- `codex/memos-create-options` - optional `pinned` and `createTime` fields for memo creation.
- `codex/memos-beta-test` - integration branch that merges the feature branches for combined testing.

## Verification

Run these checks from the repository root:

```powershell
git diff --check main..codex/memos-feature-roadmap
Test-Path docs/memos-feature-roadmap.md
Select-String -Path docs/memos-feature-roadmap.md -Pattern "Shortcuts","Link metadata","pinned","createTime"
rg "<<<<<<<|=======|>>>>>>>"
```

## Manual Review Notes

1. Open `docs/memos-feature-roadmap.md`.
2. Confirm every implementation branch is represented.
3. Confirm each feature has a short purpose, changed files, and merge/testing notes.
4. Use the roadmap as the index before reviewing or merging the implementation branches.

## Merge Notes

This branch is documentation-only. It should be safe to merge after the implementation branches or alongside the beta integration branch.
