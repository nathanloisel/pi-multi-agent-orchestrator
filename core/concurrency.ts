/**
 * core/concurrency.ts — controlled parallelism (§12).
 *
 * A global gate plus per-logical-model gates. Concurrency policy is independent
 * from job graph logic: the scheduler asks for a slot keyed by the logical
 * model alias and the gate decides. Future local backends simply configure
 * byModel: { local-worker: 1 }.
 */

import type { ConcurrencyConfig } from "./types.ts";

class Gate {
	private active = 0;
	private queue: { resolve: () => void; reject: (e: Error) => void; onAbort: () => void; signal?: AbortSignal }[] = [];
	constructor(private limit: number) {}
	setLimit(limit: number): void {
		this.limit = Math.max(1, limit);
		this.drain();
	}
	get stats() {
		return { active: this.active, pending: this.queue.length, limit: this.limit };
	}
	async acquire(signal?: AbortSignal): Promise<() => void> {
		if (signal?.aborted) throw new Error("aborted");
		if (this.active < this.limit) {
			this.active++;
			return this.release();
		}
		await new Promise<void>((resolve, reject) => {
			const entry: (typeof this.queue)[number] = {
				resolve,
				reject,
				signal,
				onAbort: () => {
					const i = this.queue.indexOf(entry);
					if (i >= 0) this.queue.splice(i, 1);
					reject(new Error("aborted"));
				},
			};
			signal?.addEventListener("abort", entry.onAbort, { once: true });
			this.queue.push(entry);
		});
		// The slot was reserved synchronously by drain() before resolving us,
		// so the granted count must not be incremented again here (doing so
		// after an await admits more waiters than `limit`).
		return this.release();
	}
	private release(): () => void {
		let done = false;
		return () => {
			if (done) return;
			done = true;
			this.active--;
			this.drain();
		};
	}
	private drain(): void {
		while (this.active < this.limit && this.queue.length > 0) {
			const next = this.queue.shift()!;
			next.signal?.removeEventListener("abort", next.onAbort);
			if (next.signal?.aborted) {
				next.reject(new Error("aborted"));
				continue;
			}
			// Reserve the slot synchronously, exactly once, before handing it
			// over: the waiter's continuation runs in a later microtask, so
			// counting it there would let this loop resolve the whole queue.
			this.active++;
			next.resolve();
		}
	}
}

export class ConcurrencyManager {
	private global: Gate;
	private byModel = new Map<string, Gate>();
	private config: ConcurrencyConfig;

	constructor(config: ConcurrencyConfig) {
		this.config = config;
		this.global = new Gate(Math.max(1, config.global));
	}

	applyConfig(config: ConcurrencyConfig): void {
		this.config = config;
		this.global.setLimit(Math.max(1, config.global));
		for (const [alias, gate] of this.byModel) {
			const limit = config.byModel[alias];
			if (limit !== undefined) gate.setLimit(limit);
		}
	}

	stats(): Record<string, { active: number; pending: number; limit: number }> {
		const out: Record<string, { active: number; pending: number; limit: number }> = { global: this.global.stats };
		for (const [alias, gate] of this.byModel) out[alias] = gate.stats;
		return out;
	}

	private modelGate(alias: string): Gate | undefined {
		const limit = this.config.byModel[alias];
		if (limit === undefined) return undefined;
		let gate = this.byModel.get(alias);
		if (!gate) {
			gate = new Gate(Math.max(1, limit));
			this.byModel.set(alias, gate);
		}
		return gate;
	}

	/** Acquire global + per-model slots; returns a single release function. */
	async acquire(alias: string | undefined, signal?: AbortSignal): Promise<() => void> {
		const releaseGlobal = await this.global.acquire(signal);
		const modelGate = alias ? this.modelGate(alias) : undefined;
		if (!modelGate) return releaseGlobal;
		try {
			const releaseModel = await modelGate.acquire(signal);
			let released = false;
			return () => {
				if (released) return;
				released = true;
				releaseModel();
				releaseGlobal();
			};
		} catch (e) {
			releaseGlobal();
			throw e;
		}
	}
}

export { Gate };
