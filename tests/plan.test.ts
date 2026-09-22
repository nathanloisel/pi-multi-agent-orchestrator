/**
 * Tests: structured plan publication (`orchestrator.plan`) — pure schema,
 * validation, retention/revision, branch-scoped read, and membership bindings.
 * No pi runtime, no filesystem.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildPlanSnapshot,
	deriveAutoPlanSteps,
	deriveAutoPlanTitle,
	MAX_PLAN_STEPS,
	MAX_PLAN_TITLE_CHARS,
	normalizePlanSnapshot,
	PLAN_ENTRY_TYPE,
	PLAN_STEP_STATUSES,
	readLatestPlan,
	renderPlanSummary,
	type PlanSnapshot,
} from "../core/types.ts";
import { collectMembershipBindings, collectMembershipJobIds, PROGRESS_MEMBERSHIP_ENTRY_TYPE } from "../core/progress.ts";

const entry = (customType: string, data: unknown) => ({ type: "custom", customType, data });

function buildOk(previous: PlanSnapshot | null, steps: unknown, planId?: unknown): PlanSnapshot {
	const result = buildPlanSnapshot({ previous, planId, steps });
	assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(!result.ok ? result.errors : null)}`);
	if (!result.ok) throw new Error("unreachable");
	return result.snapshot;
}

describe("buildPlanSnapshot — first revision and defaults", () => {
	it("builds revision 1 with default planId, empty arrays, absent agent, planned status", () => {
		const snap = buildOk(null, [{ id: "s1", title: "Add YAML parser" }]);
		assert.deepEqual(snap, {
			version: 1,
			planId: "plan",
			revision: 1,
			steps: [{ id: "s1", title: "Add YAML parser", dependsOn: [], jobIds: [], status: "planned" }],
		});
		assert.equal("agent" in snap.steps[0]!, false, "agent stays absent when omitted");
	});

	it("accepts an explicit planId and normalizes declared fields, bounded titles", () => {
		const snap = buildOk(null, [{ id: "s1", title: "  Line one\nLine two  ", agent: "coder", dependsOn: ["s2"], jobIds: ["j1"], status: "running" }, { id: "s2", title: "Second" }], "my-plan");
		assert.equal(snap.planId, "my-plan");
		assert.equal(snap.steps[0]!.title, "Line one Line two");
		assert.equal(snap.steps[0]!.agent, "coder");
		assert.equal(snap.steps[0]!.status, "running");
		assert.deepEqual(snap.steps[0]!.dependsOn, ["s2"]);
		assert.deepEqual(snap.steps[0]!.jobIds, ["j1"]);
	});

	it("accepts every declared status", () => {
		for (const status of PLAN_STEP_STATUSES) {
			const snap = buildOk(null, [{ id: "s1", title: "t", status }]);
			assert.equal(snap.steps[0]!.status, status);
		}
	});
});

describe("buildPlanSnapshot — retention and revision increments", () => {
	const rev1 = buildOk(null, [{ id: "s1", title: "One" }, { id: "s2", title: "Two" }]);

	it("replaces supplied steps in place and retains omitted previous steps", () => {
		const rev2 = buildOk(rev1, [{ id: "s2", title: "Two updated", status: "completed" }]);
		assert.equal(rev2.revision, 2);
		assert.deepEqual(rev2.steps.map((s) => s.id), ["s1", "s2"], "order and omitted step retained");
		assert.equal(rev2.steps[0]!.title, "One");
		assert.equal(rev2.steps[1]!.title, "Two updated");
		assert.equal(rev2.steps[1]!.status, "completed");
	});

	it("appends new ids and keeps the revision contiguous", () => {
		const rev2 = buildOk(rev1, [{ id: "s1", title: "One" }, { id: "s3", title: "Three" }]);
		const rev3 = buildOk(rev2, [{ id: "s4", title: "Four" }]);
		assert.deepEqual(rev3.steps.map((s) => s.id), ["s1", "s2", "s3", "s4"]);
		assert.equal(rev3.revision, 3);
	});

	it("rejects a planId change within a branch", () => {
		const result = buildPlanSnapshot({ previous: rev1, planId: "other", steps: [{ id: "s1", title: "One" }] });
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.errors.join("\n"), /planId cannot change/);
	});
});

describe("buildPlanSnapshot — atomic validation (no snapshot on error)", () => {
	const cases: { name: string; steps: unknown; planId?: unknown; match: RegExp }[] = [
		{ name: "empty steps", steps: [], match: /non-empty array/ },
		{ name: "non-array steps", steps: "nope", match: /non-empty array/ },
		{ name: "duplicate ids", steps: [{ id: "s1", title: "a" }, { id: "s1", title: "b" }], match: /duplicate step id/ },
		{ name: "empty id", steps: [{ id: "  ", title: "a" }], match: /id must not be empty/ },
		{ name: "empty title", steps: [{ id: "s1", title: "   " }], match: /title must not be empty/ },
		{ name: "title too long", steps: [{ id: "s1", title: "x".repeat(MAX_PLAN_TITLE_CHARS + 1) }], match: /title exceeds/ },
		{ name: "unknown dependency", steps: [{ id: "s1", title: "a", dependsOn: ["missing"] }], match: /unknown step missing/ },
		{ name: "self dependency cycle", steps: [{ id: "s1", title: "a", dependsOn: ["s1"] }], match: /dependency cycle/ },
		{ name: "two-step cycle", steps: [{ id: "s1", title: "a", dependsOn: ["s2"] }, { id: "s2", title: "b", dependsOn: ["s1"] }], match: /dependency cycle/ },
		{ name: "invalid status", steps: [{ id: "s1", title: "a", status: "done" }], match: /status must be one of/ },
		{ name: "non-string jobIds entry", steps: [{ id: "s1", title: "a", jobIds: [1] }], match: /jobIds entries must be strings/ },
		{ name: "duplicate jobIds", steps: [{ id: "s1", title: "a", jobIds: ["j", "j"] }], match: /jobIds contains duplicate/ },
		{ name: "bounded planId", steps: [{ id: "s1", title: "a" }], planId: "x".repeat(81), match: /planId exceeds/ },
	];
	for (const c of cases) {
		it(`rejects ${c.name}`, () => {
			const result = buildPlanSnapshot({ previous: null, planId: c.planId, steps: c.steps });
			assert.equal(result.ok, false, c.name);
			if (!result.ok) assert.match(result.errors.join("\n"), c.match);
		});
	}

	it(`rejects more than ${MAX_PLAN_STEPS} steps`, () => {
		const steps = Array.from({ length: MAX_PLAN_STEPS + 1 }, (_, i) => ({ id: `s${i}`, title: `t${i}` }));
		const result = buildPlanSnapshot({ previous: null, steps });
		assert.equal(result.ok, false);
	});

	it("rejects a retention merge that would exceed the step cap", () => {
		const steps = Array.from({ length: MAX_PLAN_STEPS }, (_, i) => ({ id: `s${i}`, title: `t${i}` }));
		const rev1 = buildOk(null, steps);
		const result = buildPlanSnapshot({ previous: rev1, steps: [{ id: "extra", title: "extra" }] });
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.errors.join("\n"), /exceeds .* steps after retention/);
	});
});

describe("normalizePlanSnapshot / readLatestPlan — tolerant branch read", () => {
	it("accepts a valid snapshot and rejects malformed shapes", () => {
		const valid = buildOk(null, [{ id: "s1", title: "One" }]);
		assert.ok(normalizePlanSnapshot(valid));
		assert.equal(normalizePlanSnapshot({ ...valid, version: 2 }), null);
		assert.equal(normalizePlanSnapshot({ ...valid, steps: [] }), null);
		assert.equal(normalizePlanSnapshot({ ...valid, steps: [{ id: "s1", title: "One", dependsOn: ["ghost"], jobIds: [], status: "planned" }] }), null);
		assert.equal(normalizePlanSnapshot({ ...valid, steps: [{ id: "s1", title: "One", dependsOn: ["s1"], jobIds: [], status: "planned" }] }), null);
		assert.equal(normalizePlanSnapshot("nope"), null);
	});

	it("returns the latest valid plan, skipping malformed historical entries and foreign entries", () => {
		const rev1 = buildOk(null, [{ id: "s1", title: "One" }]);
		const rev2 = buildOk(rev1, [{ id: "s2", title: "Two" }]);
		const branch = [
			entry(PLAN_ENTRY_TYPE, { oops: true }),
			entry("unrelated-plugin", { version: 1 }),
			entry(PLAN_ENTRY_TYPE, rev1),
			entry(PLAN_ENTRY_TYPE, { version: 1, planId: "plan", revision: "bad", steps: [] }),
			entry(PLAN_ENTRY_TYPE, rev2),
		];
		const latest = readLatestPlan(branch);
		assert.deepEqual(latest, rev2);
	});

	it("returns null when no plan exists on the branch", () => {
		assert.equal(readLatestPlan([]), null);
		assert.equal(readLatestPlan([entry(PROGRESS_MEMBERSHIP_ENTRY_TYPE, { jobIds: ["a"] })]), null);
	});

	it("renders a compact summary with live job states", () => {
		const snap = buildOk(null, [{ id: "s1", title: "One", jobIds: ["j1"] }, { id: "s2", title: "Two", status: "completed" }]);
		const text = renderPlanSummary(snap, { j1: "running" });
		assert.match(text, /plan "plan" revision 1: 2 steps \(1 planned, 1 completed\)/);
		assert.match(text, /- s1 planned — One · jobs: j1=running/);
		assert.match(text, /- s2 completed — Two/);
	});
});

describe("automatic plan fallback (deriveAutoPlanTitle / deriveAutoPlanSteps)", () => {
	it("cleans an explicit title and bounds it to the plan limit", () => {
		assert.equal(deriveAutoPlanTitle("  Add   YAML\nparser  ", "ignored"), "Add YAML parser");
		const longTitle = deriveAutoPlanTitle("x".repeat(MAX_PLAN_TITLE_CHARS + 20), "ignored");
		assert.equal(longTitle.length, MAX_PLAN_TITLE_CHARS);
		assert.ok(longTitle.endsWith("…"));
	});

	it("derives a cleaned first sentence from the objective when no title is given", () => {
		assert.equal(deriveAutoPlanTitle(undefined, "Implement the YAML parser. Then run the tests."), "Implement the YAML parser.");
		assert.equal(deriveAutoPlanTitle(undefined, "- # Step one\nmore detail"), "Step one");
		assert.equal(deriveAutoPlanTitle(undefined, "1) do the thing"), "do the thing");
		assert.equal(deriveAutoPlanTitle(undefined, "   "), "job");
	});

	it("derives missing steps with ids, agents, jobIds and intra-batch dependencies", () => {
		const result = deriveAutoPlanSteps({
			previous: null,
			jobs: [
				{ jobId: "a", agent: "coder", objective: "Parse config", dependsOn: [] },
				{ jobId: "b", agent: "tester", objective: "Test parser", dependsOn: ["a"] },
			],
		});
		assert.deepEqual(result.diagnostics, []);
		assert.deepEqual(
			result.steps.map((s) => [s.id, s.title, s.agent, s.dependsOn, s.jobIds]),
			[
				["a", "Parse config", "coder", [], ["a"]],
				["b", "Test parser", "tester", ["a"], ["b"]],
			],
		);
	});

	it("never replaces existing explicit steps and only appends missing job steps", () => {
		const previous = buildOk(null, [{ id: "a", title: "Explicit A", agent: "coder", status: "running" }]);
		const result = deriveAutoPlanSteps({
			previous,
			jobs: [
				{ jobId: "a", agent: "coder", objective: "Different objective", dependsOn: [] },
				{ jobId: "b", agent: "tester", objective: "New job", dependsOn: ["a"] },
			],
		});
		assert.deepEqual(result.steps.map((s) => s.id), ["b"], "only the missing step is generated");
		assert.deepEqual(result.steps[0]!.dependsOn, ["a"], "prior explicit step is a valid dependency");
	});

	it("treats a job already linked by an explicit step's jobIds as represented", () => {
		const previous = buildOk(null, [{ id: "group", title: "Group", jobIds: ["a"] }]);
		const result = deriveAutoPlanSteps({ previous, jobs: [{ jobId: "a", agent: "coder", objective: "A", dependsOn: [] }] });
		assert.deepEqual(result.steps, []);
	});

	it("omits dependencies that are outside the batch and have no plan step, with a diagnosis", () => {
		const result = deriveAutoPlanSteps({ previous: null, jobs: [{ jobId: "b", agent: "tester", objective: "B", dependsOn: ["ghost"] }] });
		assert.deepEqual(result.steps[0]!.dependsOn, []);
		assert.match(result.diagnostics.join("\n"), /dependency "ghost".*omitted/);
	});

	it("does not emit a dependency on a batch job represented only via another step's jobIds", () => {
		const previous = buildOk(null, [{ id: "group", title: "Group", jobIds: ["a"] }]);
		const result = deriveAutoPlanSteps({
			previous,
			jobs: [
				{ jobId: "a", agent: "coder", objective: "A", dependsOn: [] },
				{ jobId: "b", agent: "tester", objective: "B", dependsOn: ["a"] },
			],
		});
		assert.deepEqual(result.steps.map((s) => s.id), ["b"]);
		assert.deepEqual(result.steps[0]!.dependsOn, [], "a has no step id, so the reference is dropped");
		assert.match(result.diagnostics.join("\n"), /dependency "a"/);
	});
});

describe("membership bindings — additive to the existing entry", () => {
	it("collects job↔step bindings, deduped, ignoring malformed entries", () => {
		const branch = [
			entry(PROGRESS_MEMBERSHIP_ENTRY_TYPE, { jobIds: ["a"], bindings: [{ jobId: "a", stepId: "s1" }] }),
			entry(PROGRESS_MEMBERSHIP_ENTRY_TYPE, { jobIds: ["b"], bindings: [{ jobId: "b", stepId: "s2" }, { jobId: "b", stepId: "s2" }, { stepId: "s3" }, "junk"] }),
			entry("other", { bindings: [{ jobId: "x", stepId: "y" }] }),
			entry(PROGRESS_MEMBERSHIP_ENTRY_TYPE, { jobIds: ["c"] }),
		];
		assert.deepEqual(collectMembershipBindings(branch), [
			{ jobId: "a", stepId: "s1" },
			{ jobId: "b", stepId: "s2" },
		]);
	});

	it("keeps collectMembershipJobIds behavior unchanged when bindings are present", () => {
		const branch = [entry(PROGRESS_MEMBERSHIP_ENTRY_TYPE, { jobIds: ["a"], bindings: [{ jobId: "a", stepId: "s1" }] })];
		assert.deepEqual(collectMembershipJobIds(branch), ["a"]);
	});
});
