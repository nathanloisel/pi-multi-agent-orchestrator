# Structured plan consumer contract (`orchestrator.plan`)

The main orchestrator publishes a structured, durable plan for the **current
Pi session branch** before it delegates work. This document is the contract a
read-only consumer (e.g. `pi-session-desk`) can build against today — no new
tool, no new cross-repo dependency, no filesystem state store.

Canonical source of truth (both persisted, both branch-scoped):

1. `orchestrator.plan` — one immutable custom entry per plan revision, written
   with `pi.appendEntry("orchestrator.plan", snapshot)`.
2. The current branch from `ctx.sessionManager.getBranch()`.

There is **no** cached cross-session plan state: a consumer reads a branch and
a second session in the same cwd never inherits another branch's plan. Live
job state still lives only in the `JobRecord` store under
`~/.pi/orchestrator/jobs/**`; the plan snapshot carries intent, not a copy of
execution state.

## 1. Entry shape

```jsonc
{
  "type": "custom",
  "customType": "orchestrator.plan",
  "data": {
    "version": 1,
    "planId": "plan",            // stable per branch; 1..80 chars
    "revision": 2,               // branch-local, contiguous, starts at 1
    "steps": [
      {
        "id": "parse-j1",        // stable id; 1..80 chars; unique in the plan
        "title": "Add YAML parser to core/config.ts", // 1..120 chars
        "agent": "coder",        // OPTIONAL, absent when not supplied
        "dependsOn": [],         // step ids; default []
        "jobIds": ["parse-j1"],  // jobs this step links to; default []
        "status": "running"      // see enum below; default "planned"
      }
    ]
  }
}
```

`status` is one of:
`planned | running | completed | failed | blocked | cancelled | superseded`.

Rules the producer guarantees:

- Each entry is a **complete snapshot** (never a patch). The latest valid
  entry on the branch is the entire plan.
- `revision` increments by exactly 1 per `jobs action=plan` call. Steps are
  branch-local; navigation to another branch shows that branch's plan.
- A revision that supplies a step with an existing `id` replaces it in place;
  new `id`s append; **omitted steps are retained verbatim**. A step never
  silently disappears.
- Rejected input (duplicate ids, unknown/cyclic `dependsOn`, over-long
  title/id, >64 steps, invalid status, `planId` change) writes **no entry** and
  does not advance the revision (atomic validate-before-append).
- Malformed historical entries are tolerated and skipped on read; the latest
  valid entry still wins.

## 2. Binding a plan step to a job

A persisted `JobRecord` has **no alias/label field** — its `jobId` is the
alias, and the desk's `DeskJob.label` is derived from the first line of the
job's `objective`, so a label does **not** preserve the delegate alias. To make
the step↔job link stable, the producer records it explicitly:

Prefer, in order:

1. **Membership binding (authoritative).** The existing
   `orchestrator.progress-jobs` entry is extended additively:

   ```jsonc
   {
     "type": "custom",
     "customType": "orchestrator.progress-jobs",
     "data": {
       "jobIds": ["tests-j2"],
       "bindings": [                       // OPTIONAL, additive
         { "jobId": "tests-j2", "stepId": "tests-j2" }
       ]
     }
   }
   ```

   Readers that only understand `data.jobIds` are unaffected. A binding is
   recorded when a job is created/referenced whose id equals a plan step id
   (the intended alias convention), and also when a plan revision is published
   whose step id or `jobIds` already matches an existing job.

2. **Explicit `step.jobIds`** in the plan snapshot — use this for jobs that
   already existed when the plan was published.

3. **Alias convention** — `step.id === job.jobId`. The orchestrator prompt
   requires the planner to reuse the delegate alias as the step id, so this is
   the common case.

Consumers should therefore resolve a job↔step association by, in order:
membership `bindings` → `step.jobIds` → `step.id === job.jobId`. Do **not**
match on `DeskJob.label` (objective-derived, mutable, not an alias).

Effective live state = the plan step's declared `status` joined with the
linked job's persisted `status`/`result.json`. Declared status is intent;
live job state is execution truth. A step must not be shown `completed` until
its linked job reports a validated success.

## 3. Read API (pure, no I/O)

Exported from `core/types.ts`:

```ts
import {
  PLAN_ENTRY_TYPE,               // "orchestrator.plan"
  PLAN_SCHEMA_VERSION,           // 1
  PLAN_STEP_STATUSES,            // readonly enum
  normalizePlanSnapshot,         // (raw) => PlanSnapshot | null
  readLatestPlan,                // (branch) => PlanSnapshot | null
  buildPlanSnapshot,             // producer-only: (input) => { ok, snapshot|errors }
  renderPlanSummary,             // producer-only: compact tool text
  type PlanSnapshot,
  type PlanStep,
  type PlanJobBinding,
} from "./core/types.ts";

// consumer:
const plan = readLatestPlan(ctx.sessionManager.getBranch());
```

Exported from `core/progress.ts` (membership entry, unchanged reader path):

```ts
import { collectMembershipJobIds, collectMembershipBindings, PROGRESS_MEMBERSHIP_ENTRY_TYPE } from "./core/progress.ts";
```

`readLatestPlan` and `normalizePlanSnapshot` never throw; malformed entries
return `null` and are skipped. `collectMembershipJobIds` keeps its exact
previous behavior; `collectMembershipBindings` is new and additive.

## 4. Producer surface

`jobs` gains one action (still only the two tools `delegate` and `jobs`):

```
jobs action=plan planId?="plan" steps=[
  { id, title, agent?, dependsOn?, jobIds?, status? }, ...
]
```

Returns a compact summary; the persisted snapshot is the source of truth.

## 5. Tests

- `tests/plan.test.ts` — pure schema: first revision, retention/replacement,
  revision increments, atomic validation failures (duplicate id, unknown ref,
  cycle, bounds, planId mismatch), branch-scoped `readLatestPlan` with
  malformed entries skipped, and membership binding collection.
- `tests/extension-smoke.test.ts` — real extension: `plan` action registered,
  entry appended, invalid plan appends nothing, revision 2 retains omitted
  steps, reload from branch continues the revision, delegate alias binds into
  the membership entry.
- `tests/orchestrator-prompt.test.ts` — prompt requires `jobs action=plan`
  before delegates, clear titles, stable ids, and revision updates.
- `tests/plan-contract.integration.test.ts` + `tests/fixtures/desk-plan-consumer.ts`
  — frozen pi-workspace consumer mirror: the real extension publishes a plan,
  delegates a fixture job, and the persisted branch custom-entry shape +
  `job.json` are validated by a local copy of the sibling consumer's link
  precedence/state aggregation. No cross-repo dependency, no provider calls;
  also asserts default jobs-root parity and that a reload does not re-append an
  already-persisted membership binding.
