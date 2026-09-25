/**
 * Tests: concurrency gate (§12) admission strictness.
 *
 * Regression coverage for the drain() over-admission bug: a granted slot must
 * be reserved synchronously inside drain() before the waiter's promise is
 * resolved, otherwise a single release resolves the entire wait queue (the
 * waiter's `active++` ran in a later microtask, so the drain loop never saw
 * the slot consumed). All tests are deterministic: grants are flushed with
 * setImmediate (drains the microtask queue), never with timed sleeps.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConcurrencyManager, Gate } from "../core/concurrency.ts";

/** Drain queued microtask continuations deterministically (no timers/sleeps). */
async function flush(): Promise<void> {
	for (let i = 0; i < 2; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("Gate admission strictness", () => {
	it("global limit holds with 3+ queued waiters across releases", async () => {
		const gate = new Gate(2);
		const r1 = await gate.acquire();
		const r2 = await gate.acquire();

		const admitted: number[] = [];
		const releases: Array<() => void> = [];
		const waiters = [0, 1, 2].map((i) =>
			gate.acquire().then((rel) => {
				admitted.push(i);
				releases.push(rel);
			}),
		);
		assert.deepEqual(gate.stats, { active: 2, pending: 3, limit: 2 });

		// One release must reserve exactly one slot, synchronously.
		r1();
		assert.deepEqual(gate.stats, { active: 2, pending: 2, limit: 2 });
		await flush();
		assert.deepEqual(admitted, [0]); // FIFO; old drain admitted all three
		assert.deepEqual(gate.stats, { active: 2, pending: 2, limit: 2 });

		// Second release admits exactly one more; still no over-admission.
		r2();
		await flush();
		assert.deepEqual(admitted, [0, 1]);
		assert.deepEqual(gate.stats, { active: 2, pending: 1, limit: 2 });

		// Draining the admitted waiters frees slots for the last waiter.
		releases[0]();
		await flush();
		assert.deepEqual(admitted, [0, 1, 2]);
		assert.deepEqual(gate.stats, { active: 2, pending: 0, limit: 2 });

		releases[1]();
		releases[2]();
		await flush();
		assert.deepEqual(gate.stats, { active: 0, pending: 0, limit: 2 });
		await Promise.all(waiters);
	});

	it("cancelling a queued waiter leaks no slot and never admits it", async () => {
		const gate = new Gate(1);
		const held = await gate.acquire();

		const ac1 = new AbortController();
		const outcomes: string[] = [];
		const w1 = gate.acquire(ac1.signal).then(
			() => outcomes.push("granted"),
			(e: Error) => outcomes.push(`rejected:${e.message}`),
		);
		const survivors = [1, 2].map((i) =>
			gate.acquire().then((rel) => {
				outcomes.push(`granted:${i}`);
				return rel;
			}),
		);
		assert.deepEqual(gate.stats, { active: 1, pending: 3, limit: 1 });

		// Queued cancellation removes the waiter without consuming a slot.
		ac1.abort();
		await w1;
		assert.deepEqual(outcomes, ["rejected:aborted"]);
		assert.deepEqual(gate.stats, { active: 1, pending: 2, limit: 1 });

		// A single release admits exactly one survivor — the aborted waiter
		// must never receive a slot (old drain resolved both survivors).
		held();
		assert.deepEqual(gate.stats, { active: 1, pending: 1, limit: 1 });
		await flush();
		assert.deepEqual(outcomes, ["rejected:aborted", "granted:1"]);

		const rel1 = await survivors[0]!;
		rel1();
		await flush();
		assert.deepEqual(outcomes, ["rejected:aborted", "granted:1", "granted:2"]);

		const rel2 = await survivors[1]!;
		rel2();
		await flush();
		assert.deepEqual(gate.stats, { active: 0, pending: 0, limit: 1 });
	});

	it("abort after grant keeps the granted slot (no leak, exactly one release)", async () => {
		const gate = new Gate(1);
		const held = await gate.acquire();
		const ac = new AbortController();
		const pending = gate.acquire(ac.signal);

		held(); // synchronous grant inside release()
		assert.deepEqual(gate.stats, { active: 1, pending: 0, limit: 1 });
		ac.abort(); // grant wins: listener was removed at grant time
		const rel = await pending;
		rel();
		assert.deepEqual(gate.stats, { active: 0, pending: 0, limit: 1 });

		// Gate is immediately reusable at full limit.
		const again = await gate.acquire();
		again();
		assert.deepEqual(gate.stats, { active: 0, pending: 0, limit: 1 });
	});

	it("double release does not underflow or over-admit", async () => {
		const gate = new Gate(1);
		const held = await gate.acquire();
		const pending = gate.acquire().then((rel) => rel);
		held();
		held(); // idempotent: second call must not decrement again
		await flush();
		assert.deepEqual(gate.stats, { active: 1, pending: 0, limit: 1 });
		const rel = await pending;
		rel();
		rel();
		assert.deepEqual(gate.stats, { active: 0, pending: 0, limit: 1 });
	});
});

describe("ConcurrencyManager admission strictness", () => {
	it("global limit holds with 3+ queued callers across releases", async () => {
		const cm = new ConcurrencyManager({ global: 2, byModel: {} });
		const r1 = await cm.acquire(undefined);
		const r2 = await cm.acquire(undefined);

		const admitted: number[] = [];
		const releases: Array<() => void> = [];
		const waiters = [0, 1, 2].map((i) =>
			cm.acquire(undefined).then((rel) => {
				admitted.push(i);
				releases.push(rel);
			}),
		);
		assert.deepEqual(cm.stats().global, { active: 2, pending: 3, limit: 2 });

		r1();
		assert.deepEqual(cm.stats().global, { active: 2, pending: 2, limit: 2 });
		await flush();
		assert.deepEqual(admitted, [0]);
		assert.deepEqual(cm.stats().global, { active: 2, pending: 2, limit: 2 });

		r2();
		await flush();
		assert.deepEqual(admitted, [0, 1]);
		assert.deepEqual(cm.stats().global, { active: 2, pending: 1, limit: 2 });

		releases[0]!();
		await flush();
		assert.deepEqual(admitted, [0, 1, 2]);
		releases[1]!();
		releases[2]!();
		await flush();
		assert.deepEqual(cm.stats().global, { active: 0, pending: 0, limit: 2 });
		await Promise.all(waiters);
	});

	it("per-alias limit holds with 3+ queued callers across releases", async () => {
		const cm = new ConcurrencyManager({ global: 5, byModel: { "worker-cheap": 1 } });
		const held = await cm.acquire("worker-cheap");

		const admitted: number[] = [];
		const releases: Array<() => void> = [];
		const waiters = [0, 1, 2].map((i) =>
			cm.acquire("worker-cheap").then((rel) => {
				admitted.push(i);
				releases.push(rel);
			}),
		);
		// Callers take a global slot synchronously, then queue on the alias gate
		// a microtask later (after the immediate global acquire resolves).
		assert.deepEqual(cm.stats().global, { active: 4, pending: 0, limit: 5 });
		await flush();
		assert.deepEqual(cm.stats()["worker-cheap"], { active: 1, pending: 3, limit: 1 });

		// One release admits exactly one waiter on the alias gate (old code
		// resolved the whole alias queue from a single release).
		held();
		assert.deepEqual(cm.stats()["worker-cheap"], { active: 1, pending: 2, limit: 1 });
		await flush();
		assert.deepEqual(admitted, [0]);

		releases[0]!();
		await flush();
		assert.deepEqual(admitted, [0, 1]);
		assert.deepEqual(cm.stats()["worker-cheap"], { active: 1, pending: 1, limit: 1 });

		releases[1]!();
		await flush();
		assert.deepEqual(admitted, [0, 1, 2]);
		assert.deepEqual(cm.stats()["worker-cheap"], { active: 1, pending: 0, limit: 1 });

		releases[2]!();
		await flush();
		assert.deepEqual(cm.stats()["worker-cheap"], { active: 0, pending: 0, limit: 1 });
		assert.deepEqual(cm.stats().global, { active: 0, pending: 0, limit: 5 });
		await Promise.all(waiters);
	});

	it("aborting a caller queued on the model gate releases its global slot", async () => {
		const cm = new ConcurrencyManager({ global: 2, byModel: { "worker-cheap": 1 } });
		const held = await cm.acquire("worker-cheap");
		const ac = new AbortController();
		const pending = cm.acquire("worker-cheap", ac.signal);
		// Global had room, so the caller queues on the alias gate (one
		// microtask later, after the immediate global acquire resolves).
		assert.deepEqual(cm.stats().global, { active: 2, pending: 0, limit: 2 });
		await flush();
		assert.deepEqual(cm.stats()["worker-cheap"], { active: 1, pending: 1, limit: 1 });

		ac.abort();
		await assert.rejects(pending, /aborted/);
		// The already-taken global slot must be returned — no leak.
		assert.deepEqual(cm.stats().global, { active: 1, pending: 0, limit: 2 });
		assert.deepEqual(cm.stats()["worker-cheap"], { active: 1, pending: 0, limit: 1 });

		held();
		await flush();
		assert.deepEqual(cm.stats().global, { active: 0, pending: 0, limit: 2 });
		assert.deepEqual(cm.stats()["worker-cheap"], { active: 0, pending: 0, limit: 1 });
	});
});
