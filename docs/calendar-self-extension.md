# Second Self-Extension vertical slice: Calendar

Status: **Verified** by `test/calendar-google-e2e.test.ts`. This is the second governed lifecycle: a **credentialed external capability** mounted behind the existing Calendar seam.

**AI may produce the candidate. A human must approve the exact digest/diff before it becomes active.**

```text
Obsidian proved: generated code + local filesystem boundary
Calendar proves: generated code + external API + credentials + action-level authority
```

```text
"I need Google Calendar"
        ↓
Capability Registry                 calendar.read already owned
        ↓
Capability Resolution Review        implement-provider on integrations.calendar
        ↓
Generated Google Calendar adapter   replaceCalendar, no second calendar domain
        ↓
Restricted offline validation       fixture transport, no live token
        ↓
Exact read-only approval            events.read + freebusy.read
        ↓
Write expansion                     events.create invalidates the prior approval
        ↓
Proposal ≠ execution                propose is side-effect free
        ↓
Idempotent create                   same key does not duplicate
        ↓
Restart / rollback / Safe Mode      committed authority only
```

## Why not a new Calendar plugin

`calendar.read` / `calendar.propose` / `calendar.execute` already exist on `managed/integrations` behind `integrations.calendar`. Reviewing `calendar.read` with a known Google provider therefore returns **`implement-provider`**, not `new-plugin`.

The generated owner is `generated/google-calendar`. It does **not** register a second `calendar_list_events` tool. It calls `IntegrationHub.replaceCalendar()` so the existing model-facing tools (`calendar_list_events`, `calendar_get_event`, `calendar_freebusy`, `calendar_propose_event`, `calendar_create_event`) keep their provider-neutral shapes.

Google HTTP objects stay in the adapter. Model-facing events are `{ id, title, start, end, timeZone, calendarId, attendees, allDay, description }`.

## Action-level authority

| Capability | Permission | Effect |
| --- | --- | --- |
| `calendar.events.list` / `calendar.event.read` | `google.calendar.events.read` | list / get |
| `calendar.freebusy.read` | `google.calendar.freebusy.read` | busy windows |
| `calendar.events.create` | `google.calendar.events.create` | create after confirmation |

A read-only approval does not authorize create. Adding create is a new exact-candidate approval.

## Credentials and network

- Secret **identifier** `google.calendar.oauth` may appear in the manifest / approval summary.
- Secret **values** are never stored in candidate files, Registry, diagnostics, backups, or tool output.
- Validation and offline tests use `DSH_ASSISTANT_GOOGLE_CALENDAR_MODE=fixture` and never call Google.
- Approved network effect is only `https://www.googleapis.com/calendar/v3`.
- Provider errors redact Bearer tokens, `ya29.*`, `access_token`, `refresh_token`, and `client_secret`.

Runtime injection, when used, is host-supplied `DSH_ASSISTANT_GOOGLE_CALENDAR_ACCESS_TOKEN`. The candidate does not mint or persist it.

## Idempotency

`createEvent` accepts `idempotencyKey`. The fixture transport returns the first created event for a repeated key. If a live Google call times out after remote success, retry with the same key; the adapter treats a matching key as the same operation rather than a second create.

## Control plane

The Calendar candidate cannot mint `TrustedAuthorityCredential`, rewrite LKG, exit Safe Mode, or touch Git/GitHub development credentials.
