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

- Switch flushes the outgoing DSH session before changing the route. A failed switch leaves the previous current session.
- Conversation posts carry the expected Session ID; a stale tab cannot append to a newly selected topic.
- Catalog mutations carry an expected revision.
- Delete requires `confirm: true`. The last active conversation cannot be archived or deleted.
- Safe Mode can inspect and switch; create/rename/archive/restore/delete are frozen.
- A #88 Home with only `main` is migrated to one catalog entry titled `Conversation` without rewriting the Session ID.

`tars-ng status` / `doctor` report catalog health and counts. They do not dump transcripts.
