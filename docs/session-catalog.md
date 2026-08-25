# Topic conversations / Session Catalog

Status: **Implemented**. This is the M7B host-owned multi-session lifecycle. It sits on the #88 Runtime Context. Folders, search, AI titles, and cross-device sync are **not** Implemented.

```text
Bound Runtime Context
└── Session Catalog
    ├── Session A
    ├── Session B
    └── Session C
```

#88 delivered one durable current session. This slice adds a versioned catalog so a user can create, switch, rename, archive, restore, and confirm-delete topic conversations inside the same Home / Profile / Workspace.

## Authority

| Concept | Owner |
| --- | --- |
| Session ID | Host runtime (validated; never a title or path) |
| Conversation title | Human through WUI/API |
| Event history | DSH JSONL persistence |
| Catalog metadata | `$SESSION_PERSISTENCE_DIR/.tars-ng-catalog.json` |
| Current route | Host catalog + `product.json` `runtime.sessionId` |

The browser renders catalog DTOs. It does not invent IDs, storage paths, or continuity.

## Lifecycle

Trusted `POST /api/conversations` actions: `create`, `switch`, `rename`, `archive`, `restore`, `delete`.

- Switch/archive/delete journal the previous catalog, then commit the route. A failed step restores the previous catalog and live session. History is unlinked only after the replacement route is live.
- Conversation posts require the expected Session ID. Catalog mutations require Session ID and revision; omitted tokens are rejected. Create consumes the current revision, so a replay is stale.
- A running Agent turn returns `busy`; the originating session stays current until it is idle.
- Approval origins are written once and kept as tombstones after delete. Projection never falls back to the current Session ID.
- Delete requires `confirm: true`. The last active conversation cannot be archived or deleted.
- Safe Mode can inspect and switch; create/rename/archive/restore/delete are frozen. Recovery still inspects the official bound catalog, not the ephemeral recovery session store.
- A #88 Home with only `main` is migrated to one catalog entry titled `Conversation` without rewriting the Session ID.
- `currentSessionId` must exist and be active. Missing timestamps, non-integer revisions, or a missing current session fail closed.

`tars-ng status` / `doctor` report catalog health and counts. They do not dump transcripts.
