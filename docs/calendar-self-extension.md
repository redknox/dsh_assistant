# Second Self-Extension vertical slice: Calendar

Status: **Verified** by `test/calendar-google-e2e.test.ts`. This is the second governed lifecycle: a **credentialed external capability** using exact host-owned Broker operations from the isolated runtime.

**AI may produce the candidate. A human must approve the exact digest/diff before it becomes active.**

```text
Obsidian proved: generated code + local filesystem boundary
Calendar proves: generated code + external API + credentials + action-level authority
```

```text
"I need Google Calendar"
        ↓
Capability Registry                 generic calendar.read already owned
        ↓
Capability Resolution Review        Google-specific capability is distinct
        ↓
Generated Google Calendar logic     isolated, no Cordis/transport/credential access
        ↓
Restricted offline validation       fixture transport, no live token
        ↓
Exact read-only approval            events.read + freebusy.read
        ↓
Write expansion                     events.create invalidates the prior approval
        ↓
Proposal ≠ execution                propose is side-effect free
        ↓
host.google-calendar.read           bounded read/freeBusy transport
host.google-calendar.mutate         action-policy confirmation + create
        ↓
Reconciled create                   deterministic event id recovers timeout-after-success
        ↓
Restart / rollback / Safe Mode      committed authority only
```

## Why the Google capability is separate

`calendar.read` / `calendar.propose` / `calendar.execute` remain generic host-managed capabilities. Reviewing generic `calendar.read` still returns **`reuse`**. Generated code, however, cannot replace a host Cordis provider or service from its isolated process. A request for the explicitly Google-shaped capability therefore resolves to a separate governed user capability and tools.

The generated owner is `generated/google-calendar`. It registers `google_calendar_*` proxy tools and calls only `ctx.broker.request(...)`. It cannot access `ctx.integrations`, `process.env`, `fetch`, services, or providers. Generic `calendar_*` tools remain owned by the host integration and are restored unchanged after rollback.

Candidate code maps between tool inputs and Google Calendar v3 resource shapes (`summary`, `start.dateTime` / `start.date`, `attendees[].email`). It does **not** call `fetch` or receive a generic HTTP client. The host Broker alone reaches `ctx.integrations.googleCalendarTransport` and:

- only accepts `https://www.googleapis.com` + `/calendar/v3/...`;
- injects `Authorization` at that boundary;
- never returns the token to candidate/model output.

Offline tests substitute `createFakeGoogleCalendarTransport()`, which speaks the same v3 contract. Set `DSH_ASSISTANT_GOOGLE_CALENDAR_MODE=live` to use `createLiveGoogleCalendarTransport()`. Construction of the live transport does not require a fixture and does not throw merely because a token is absent.

## Action-level authority

| Capability | Permission | Effect |
| --- | --- | --- |
| `google.calendar.events.list` / `google.calendar.event.read` | `host.google-calendar.read` | bounded GET |
| `google.calendar.freebusy.read` | `host.google-calendar.read` | exact freeBusy POST |
| `google.calendar.events.create` | `host.google-calendar.mutate` | action-policy confirmation, then create |

A read-only approval does not authorize create. Adding create is a new exact-candidate approval.

## Credentials and network

- Secret **identifier** `google.calendar.oauth` may appear in the manifest / approval summary.
- Secret **values** are never stored in candidate files, Registry, diagnostics, backups, or tool output.
- Validation and offline tests never call Google. They inject a v3-shaped fake transport. `MODE=fixture` is accepted; the default host wiring is also fake unless `MODE=live`.
- Approved network effect is only `https://www.googleapis.com/calendar/v3`.
- Provider errors redact Bearer tokens, `ya29.*`, `access_token`, `refresh_token`, and `client_secret`.

Runtime injection, when used, is host-supplied `DSH_ASSISTANT_GOOGLE_CALENDAR_ACCESS_TOKEN` at the transport boundary. The candidate does not read, mint, or persist the value.

## Idempotency / uncertain success

Google Calendar does not treat an application `idempotencyKey` as a first-class header. This slice derives a deterministic Google event `id` from the approved operation identity (`sha256` hex, valid base32hex) and sends that id on insert.

```text
create with derived id
→ Google may have created the event
→ caller AbortSignal / timeout fires before seeing success
→ GET calendars/{id}/events/{derivedId} uses a fresh reconciliation budget
→ retry insert is 409 conflict or GET-before-insert; still one logical event
```

The reconciliation GET must not reuse the already-aborted create signal. If the GET finds nothing, the operation stays failed and no second POST is issued. The in-memory fake store is only a Google v3 double; it is not the idempotency strategy.

## Control plane

The Calendar candidate cannot mint `TrustedAuthorityCredential`, rewrite LKG, exit Safe Mode, or touch Git/GitHub development credentials.
