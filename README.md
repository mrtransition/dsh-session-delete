# Delete conversation — a DeepSeek Harness plugin

Adds a **Delete conversation…** action to the conversation (session) row menu in
the DeepSeek Harness Web GUI and permanently deletes that conversation's stored
session log, after a confirmation dialog.

DeepSeek Harness has no session-deletion API — its persistence layer treats
pruning as out-of-band maintenance — so this bundle implements the whole
operation: guards, registry cleanup, and file removal.

Verified against DeepSeek Harness `0.2.2-rc.5` (Desktop profile, Web GUI).

## Requirements

- DeepSeek Harness with the Web GUI and the standard profile services
  (`session`, `sessionPersistence`, `workspaceRegistry`, `connection`).
- No dependencies and no build step: the package ships plain ESM/CommonJS-style
  sources plus a hand-written browser bundle.

## Install

1. Clone or download this repository to a local folder.
2. Open **Settings → Plugins** and use **Add plugin** to pick that folder (the
   plugin manager links the directory into the active profile).
3. The bundle **Delete conversation** appears and is enabled on installation.
4. Reload the page once if the session menu does not show the new entry yet.

To stop using it, disable the bundle in **Settings → Plugins**. The route and the
menu entry are withdrawn together, and no session log is touched.

## Usage

Open the conversation list in the sidebar, open a row's **⋯** menu (or
right-click the row), and choose **Delete conversation…** in the menu footer,
next to **Archive session**. Confirm in the dialog; the row disappears because the
browser asks the Host for the authoritative list again.

The entry is hidden for a blank New-Session row, for a running conversation, and
for subagent rows. The action is user-only on purpose: no agent tool can delete
the user's conversations.

## What deletion removes

For exactly one session id:

1. every stored log generation in that session's directory
   (`session.jsonl[.zstd]`, `session.vN.jsonl[.zstd]`, the lease file), and the
   now-empty session directory itself;
2. its **workspace membership** (`detachSession`) on every Workspace that lists it;
3. its entries in the **pinned** and **archived** sets;
4. nothing else — attachment blobs are content-addressed and shared with other
   sessions, projection-cache checkpoints are inert once the log is gone, and the
   SQLite search index drops rows for missing logs when it next reconciles.

## Refusals

Deletion is refused, non-destructively, with a message instead of an error when:

| Situation | Reason |
|---|---|
| The conversation is loaded in the running Harness (its agent was resumed or prompted in this run) | the in-memory Session would re-materialize the log; restart DeepSeek Harness and delete it then |
| Its turn is running | stop it first |
| It is a subagent conversation | its parent's catalog entry cannot be pruned |
| It still owns stored subagent conversations | they would be orphaned |
| An active scheduled task still delivers into it | remove the task under **Settings → Scheduled tasks** first |
| Nothing is stored for it yet | there is no log to delete |

## Host contract

The browser half calls the authenticated route registered on the Host
connection:

```
POST /api/session-delete
content-type: application/json

{ "sessionId": "session-…" }
```

Success: `{ "ok": true, "deleted": true, "removed": <file count>, "leftover": [] }`.

Refusal or failure: HTTP 4xx/5xx with
`{ "ok": false, "code": "<code>", "message": "<english>" }`, where `code` is one
of `session_running`, `session_live`, `session_subagent`, `session_has_children`,
`session_scheduled`, `session_not_stored`, `session_path_unknown`,
`session_delete_failed`, `invalid_request`, `method_not_allowed`, `internal`.
The browser half maps these codes to localized copy (`en`, `zh`).

## Layout

| Path | Role |
|---|---|
| `package.json` | bundle manifest: `dsh.bundle.patch` plus the `dsh.client` declaration |
| `cordis.patch.yml` | inserts the `session-delete` plugin row |
| `index.js` | Host half: the `POST /api/session-delete` route, guards, registry cleanup, log removal |
| `client.js` | browser half: dictionary, session menu entry, confirmation overlay, list refresh |
| `locale/en.json`, `locale/zh.json` | plugin metadata (title and description shown by the plugin manager) |
| `icon.svg` | 36×36 trash glyph |
| `tests/session-delete.test.mjs` | deterministic checks, no DSH or network needed |

## Development

Run the checks with any Node.js 24+:

```sh
node tests/session-delete.test.mjs
```

The test drives the real Host half against a stub Cordis context and a temporary
session directory (success, refusals, file and registry cleanup), then drives the
real browser half through a stub module loader and a minimal React stand-in
(dictionary parity, menu entry, hiding rules, dialog structure, request body,
success and failure paths). It needs no DeepSeek Harness instance and no network.

There is no build step: `client.js` registers itself through
`window.__ModuleLoader__.load(...)` and may `require('react')`; `index.js` is an
ordinary Cordis plugin with `export const inject` and `export function apply`.

## Known limitations

- A conversation whose agent is live in the current Harness run cannot be deleted
  until the Harness restarts (the in-memory Session would recreate the log).
- Subagent conversations, and parents that still own stored subagent
  conversations, are refused.
- Deleting is final: the plugin has no undo or trash.
- Deleting the conversation currently on screen (when it is not live) leaves that
  view open until another conversation is opened.
- The projection-cache checkpoint file for a deleted session is left in place; it
  is inert, and no API exists to remove it.
- No license file is included yet; add one before redistributing.
