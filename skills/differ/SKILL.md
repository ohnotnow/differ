---
name: differ
description: Read reviewer comments created by the Differ macOS diff viewer. Use when working in a repository that may have Differ reviewer comments, when the user asks to check review comments from Differ, or when an agent needs to discover actionable feedback without copy/paste from the diff UI.
---

# Differ Reviewer Comments

Use this skill to read review feedback that a human left in Differ.

## Locate The Comments File

Run this command from inside the target Git repository:

```bash
git rev-parse --path-format=absolute --git-path differ/comments.json
```

Read the returned path. If the file does not exist, there are no Differ reviewer comments.

The file is intentionally under Git-private storage, usually `.git/differ/comments.json`. It should not appear in `git status`, and it should not be committed.

## Interpret The JSON

Expect a materialized JSON document:

```json
{
  "schemaVersion": 1,
  "repositoryPath": "/path/to/repo",
  "updatedAt": "2026-06-19T13:04:50Z",
  "comments": []
}
```

Each comment has these important fields:

- `id`: stable identifier for follow-up discussion.
- `revision`: increments when the comment body or lifecycle state changes.
- `state`: `open` needs attention; `resolved` is retained history.
- `body`: the human review comment.
- `reference`: human-readable file and line reference.
- `selection`: structured file, old file, side, and line range.
- `snippet`: optional fenced diff snippet captured when the comment was created.
- `placement`: optional current render status.

Placement statuses:

- `mapped`: Differ can currently anchor the comment to visible parsed diff lines.
- `unmapped`: the related file is still in the working-tree changes, but the selected lines are not currently anchorable. The comment still needs attention if it is `open`.
- `stale`: the selected file is no longer in the current working-tree changes. Treat open stale comments as review feedback that may have been addressed or displaced; verify before ignoring them.

`placement.reason` gives a compact machine-readable reason such as `selected-lines-not-in-current-diff`, `diff-not-rendered`, `file-hidden-from-all-changes`, or `file-not-in-current-changes`.

## Agent Workflow

1. Locate and parse the comments file.
2. Focus first on comments where `state` is `open`.
3. Use `reference`, `selection`, and `snippet` to find the relevant code.
4. Do not discard open comments just because `placement.status` is `unmapped` or `stale`.
5. Treat `resolved` comments as historical unless the user explicitly asks to review them.
6. Do not edit `comments.json` unless the user asks you to manage Differ comments directly.

Useful inspection command:

```bash
jq '.comments[] | select(.state == "open") | {id, reference, body, placement, snippet}' "$(git rev-parse --path-format=absolute --git-path differ/comments.json)"
```
