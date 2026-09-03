---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-08-31T02:24:46Z"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-08-30T20:32:11Z"
  docs/phases/phase-03-videos/library-refs.md: "2026-08-31T02:38:18Z"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-08-26T03:15:09Z"
issues:
  - id: IC-1
    status: resolved
    summary: "TD-04 and TD-16 disagree on where upload JWT verification is enforced"
    resolved_by: phase-03-videos/TD-04
  - id: IC-2
    status: resolved
    summary: "TD-17 reaper runs in worker but needs the tus Server that TD-16 mounts in the API"
    resolved_by: phase-03-videos/TD-17
  - id: AMB-1
    status: resolved
    summary: "Draft row contents at pre-registration undefined (title nullable? from filename?)"
    resolved_by: phase-03-videos/TD-05
  - id: AMB-2
    status: resolved
    summary: "'metadados' unenumerated — which ffprobe fields are persisted"
    resolved_by: phase-03-videos/TD-09
  - id: ICC-1
    status: resolved
    summary: "TD-12/TD-13 browser-to-storage egress conflicts with inherited strict-BFF"
    resolved_by: next-frontend-config-base/TD-03
  - id: ICC-2
    status: resolved
    summary: "TD-03 tus ingest path unresolved against inherited strict-BFF same-origin rule"
    resolved_by: phase-03-videos/TD-03
advisories: []
---

# phase-03-videos — Validation

## Findings

_First revision whose verdict is fully derivable from `context.md` alone: the five `**Revisions:**` blocks are now present in `## Decisions Detail` and the five `└─ Last revision` annotation rows in `## Decisions Index`, so the resolutions are visible to this stage's read scope rather than living only in the decisions doc._

### Inconsistencies

_None._

_17 decided TDs; no capability bullet contradicted by a decided TD; every `Capability:` field cites a bullet present in `## Scope`. Scope-Subsection orphan check passes — 12 `Backend` + 5 `Cross-layer`, zero `Scope: Frontend`, so the absent `## UI Inventory` orphans nothing. The TD-04 ↔ TD-16 contradiction is gone: TD-04's Revision moves JWT to `JwtAuthGuard` and leaves `Upload-Length`/metadata/content-type in the hooks, which is what TD-16 asserts. TD-17's Revision resolves the reaper's process placement against TD-08 and TD-16._

### Ambiguities

_None._

_The draft payload is fixed by TD-05's Revision (`title` NOT NULL, seeded from the sanitised upload filename) and the persisted metadata set by TD-09's Revision (typed `duration`/`width`/`height` + full ffprobe JSON in `jsonb`). Both are now concrete enough to decompose into SIs, and TD-05's choice satisfies TD-13's download-filename dependency without a null branch._

### Missing Decisions

_None._

_All 9 bullets in `## Capability Coverage` map to ≥1 decided TD, no `—` rows. Error-response format inherited from `phase-02-auth/TD-07`. Decisão #29 (shared-types contract sync) does not fire — it requires `ui_in_scope ∈ {true, logic-only}` and this slice is `ui_in_scope: false`._

### Dependency Gaps

_None._

_Within-phase ordering is documented by explicit TD cross-references (TD-03→TD-01/TD-02, TD-11→TD-07, TD-10→TD-02, TD-16→TD-04, TD-17→TD-05/TD-07/TD-08/TD-16). Prior-phase prerequisites (`JwtAuthGuard`, `channels` table) were delivered in phases 01–02._

### Inherited Constraint Conflicts

_None._

_Both strict-BFF conflicts are resolved: the rule was scoped to API traffic via a cross-doc Revision on `next-frontend-config-base/TD-03` (signed media URLs excluded), and the upload ingest path was fixed to a same-origin reverse proxy via a Revision on `phase-03-videos/TD-03`. The current-scope TDs raise no new contradiction against the six inherited phase-01 config conventions — TD-16's `bodyParser: false` bootstrap change re-applies JSON parsing to non-tus routes, so `phase-02-auth/TD-06`'s global `ValidationPipe` contract is preserved._

### Unresolved Open Questions

_None._

_All 17 TDs carry `Status: decided`; no pending TD. No `## UI Inventory`, so no inventory-originated open questions._

### UI Coverage Gaps

_None._

_`## UI Inventory` is absent (backend-only phase, no UI signal in any capability bullet), so Check 7 is skipped entirely._

## Resolved Issues

- **IC-1** _(resolved_by phase-03-videos/TD-04)_ — TD-04 and TD-16 disagreed on where upload JWT verification runs. Resolved as an **Append revision** on TD-04 (Option A unchanged): JWT moves to the ordinary `JwtAuthGuard`, since mounting tus as a Nest controller route per TD-16 keeps the guard pipeline active; `Upload-Length`, metadata and content-type checks stay in the tus hooks, where a guard cannot see them.

- **IC-2** _(resolved_by phase-03-videos/TD-17)_ — The abandoned-upload reaper was placed in `video-worker` but called `cleanUpExpiredUploads()` on a tus `Server` that lives in the API process. Resolved as an **Append revision** on TD-17 (Option A unchanged): the worker constructs its own `S3Store` + tus `Server` with no route mounted, purely for cleanup.

- **AMB-1** _(resolved_by phase-03-videos/TD-05)_ — The draft row's contents at pre-registration were undefined. Resolved as an **Append revision** on TD-05 (Option A unchanged): `title` is NOT NULL, seeded from the sanitised upload filename, satisfying TD-13's download-filename dependency without a null branch.

- **AMB-2** _(resolved_by phase-03-videos/TD-09)_ — "metadados" was unenumerated. Resolved as an **Append revision** on TD-09 (Option A unchanged): `duration`, `width`, `height` become typed columns; full `ffprobe` output retained in `jsonb`, removing the backfill hazard.

- **ICC-1** _(resolved_by next-frontend-config-base/TD-03)_ — TD-12/TD-13's browser-to-storage egress conflicted with the inherited strict-BFF rule. Resolved as a **cross-doc Append revision** on `next-frontend-config-base/TD-03` (Option A unchanged): strict BFF governs API traffic, not opaque signed media URLs.

- **ICC-2** _(resolved_by phase-03-videos/TD-03)_ — TD-03's same-origin justification was unreconciled with its own flagged consequence about proxying a 10GB stream through Next. Resolved as an **Append revision** on TD-03 (Option A unchanged): upload reaches the API through a same-origin reverse proxy that bypasses the Next runtime.
