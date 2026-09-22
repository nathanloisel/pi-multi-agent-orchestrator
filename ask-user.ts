/**
 * ask-user.ts — the reusable ask_user_question UI (phase 2).
 *
 * One helper backs BOTH surfaces:
 *   - the main agent's own `ask_user_question` tool (registered in index.ts)
 *   - worker-routed questions (worker.ts ask_user_question → parent broker →
 *     human-question seam), rendered in the MAIN session with the asking
 *     job/agent identity
 *
 * Behaviour contract (shared with the phase 1 wire schema):
 *   - ONE question per invocation; 2..8 named options (with optional
 *     descriptions) or free text when options are omitted
 *   - allowCustom (default true) enables a typed custom answer even when
 *     options are present
 *   - keyboard: up/down + Enter to pick, inline entry for custom answers,
 *     Escape cancels — an explicit cancellation, never a default answer
 *   - deadlines and aborts are honoured even while QUEUED (questions serialize
 *     FIFO): a stale dialog is closed/never shown and resolves timeout/cancelled
 *   - headless/no-UI runs return unavailable IMMEDIATELY (no dialog, no answer)
 *   - RPC mode falls back to the built-in select/input dialogs
 *   - TUI mode renders an interactive overlay via ctx.ui.custom()
 *
 * Core never imports this module (no TUI dependency in core/): the extension
 * registers it as the broker's human-question seam.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { clampRequestTimeoutSeconds } from "./core/messaging.ts";

export interface QuestionUiParams {
	question: string;
	options?: { label: string; description?: string }[];
	allowCustom?: boolean;
	timeoutSeconds?: number;
}

export interface QuestionUiOptions {
	/** Who is asking (e.g. "job parse-j1 · coder · attempt-001"); omitted for the main agent's own questions. */
	identity?: string;
	/** External abort (tool signal, worker exit): closes/cancels any open or queued dialog. */
	signal?: AbortSignal;
}

export type QuestionOutcome =
	| { status: "answered"; answer: string; wasCustom: boolean }
	| { status: "cancelled" }
	| { status: "timeout" }
	| { status: "unavailable"; reason: string };

/** FIFO serialization: one question dialog is open at a time. */
class QuestionQueue {
	private running = false;
	private waiting: Array<() => void> = [];

	run<T>(job: () => Promise<T>): Promise<T> {
		if (!this.running) {
			this.running = true;
			return this.execute(job);
		}
		return new Promise<T>((resolve, reject) => {
			this.waiting.push(() => {
				this.execute(job).then(resolve, reject);
			});
		});
	}

	private execute<T>(job: () => Promise<T>): Promise<T> {
		return job().finally(() => {
			const next = this.waiting.shift();
			if (next) next();
			else this.running = false;
		});
	}
}

const queue = new QuestionQueue();

/** Session teardown hook: nothing to force-close (ctx.ui.custom resolves via
 * its own signal listener), kept for explicit lifecycle clarity. */
export function disposeQuestionUi(): void {
	/* the queue drains naturally; dialogs observe their abort signals */
}

/**
 * Ask the user ONE question. Never throws: every failure path resolves to an
 * explicit outcome. Never fabricates an answer on timeout/Escape.
 */
export async function askUserQuestion(ctx: ExtensionContext, params: QuestionUiParams, options: QuestionUiOptions = {}): Promise<QuestionOutcome> {
	if (!params.question || typeof params.question !== "string") {
		return { status: "unavailable", reason: "invalid question: question must be a non-empty string" };
	}
	if (params.options !== undefined) {
		if (!Array.isArray(params.options) || params.options.length < 2 || params.options.length > 8) {
			return { status: "unavailable", reason: "options must contain 2..8 entries when present (omit options for free text)" };
		}
	}

	// Headless / no UI: unavailable immediately, no dialog is ever opened.
	if (!ctx || ctx.hasUI === false || (ctx.mode !== "tui" && ctx.mode !== "rpc")) {
		return { status: "unavailable", reason: `no interactive UI is available (mode: ${ctx?.mode ?? "none"}); questions require a TUI or RPC session` };
	}

	// Deadline: honoured for queued AND open dialogs; an expired question is
	// never answered with a default.
	const timeoutSeconds = clampRequestTimeoutSeconds(params.timeoutSeconds);
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutSeconds * 1000);
	const onExternalAbort = () => controller.abort();
	options.signal?.addEventListener("abort", onExternalAbort, { once: true });
	if (options.signal?.aborted) controller.abort();

	try {
		if (ctx.mode === "rpc") {
			// Built-in dialogs over the RPC extension-UI protocol.
			if (controller.signal.aborted) return timedOut ? { status: "timeout" } : { status: "cancelled" };
			const builtins = await askViaBuiltins(ctx, params, options, controller.signal);
			// null = the dialog was dismissed with no answer: distinguish the local
			// deadline (timeout) from an explicit Escape/external abort (cancelled).
			if (builtins !== null) return builtins;
			return timedOut ? { status: "timeout" } : { status: "cancelled" };
		}
		// TUI: serialize through the FIFO queue, but observe the deadline/abort
		// the WHOLE time — including while queued. A question that expires while
		// queued resolves immediately and is never shown; when its turn comes the
		// stale queue entry drains without opening anything.
		return await new Promise<QuestionOutcome>((resolveOuter) => {
			let outerSettled = false;
			const onAbortOuter = () => settleOuter(timedOut ? { status: "timeout" } : { status: "cancelled" });
			const settleOuter = (outcome: QuestionOutcome) => {
				if (outerSettled) return;
				outerSettled = true;
				controller.signal.removeEventListener("abort", onAbortOuter);
				resolveOuter(outcome);
			};
			controller.signal.addEventListener("abort", onAbortOuter, { once: true });
			if (controller.signal.aborted) {
				settleOuter(timedOut ? { status: "timeout" } : { status: "cancelled" });
				return;
			}
			void queue
				.run(async () => {
					if (controller.signal.aborted) return timedOut ? { status: "timeout" as const } : { status: "cancelled" as const };
					const result = await openQuestionDialog(ctx, params, options, controller.signal);
					if (result === null || result === undefined) return timedOut ? { status: "timeout" as const } : { status: "cancelled" as const };
					return { status: "answered" as const, answer: result.answer, wasCustom: result.wasCustom };
				})
				.then(
					(outcome) => settleOuter(outcome),
					(err) => settleOuter({ status: "unavailable", reason: `question UI failed: ${err instanceof Error ? err.message : String(err)}` }),
				);
		});
	} catch (err) {
		return { status: "unavailable", reason: `question UI failed: ${err instanceof Error ? err.message : String(err)}` };
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", onExternalAbort);
	}
}

// ── RPC fallback (built-in dialogs) ──────────────────────────────────────────

/** Built-in RPC fallback. Returns null when a dialog was dismissed with no
 * answer (timeout-vs-cancel mapping happens in the caller). */
async function askViaBuiltins(ctx: ExtensionContext, params: QuestionUiParams, options: QuestionUiOptions, signal: AbortSignal): Promise<QuestionOutcome | null> {
	const title = renderTitle(params, options);
	const allowCustom = params.allowCustom ?? true;
	if (params.options === undefined) {
		const answer = await ctx.ui.input(title, "Your answer", { signal });
		return answer === undefined ? null : { status: "answered", answer, wasCustom: true };
	}
	const labels = params.options.map((o) => o.label);
	const picked = await ctx.ui.select(title, labels, { signal });
	if (picked !== undefined) return { status: "answered", answer: picked, wasCustom: false };
	if (allowCustom) {
		const custom = await ctx.ui.input(`${title} (custom answer)`, "Your answer", { signal });
		if (custom !== undefined) return { status: "answered", answer: custom, wasCustom: true };
	}
	return null;
}

function renderTitle(params: QuestionUiParams, options: QuestionUiOptions): string {
	const identity = options.identity ? `${options.identity}: ` : "";
	return `${identity}${params.question}`;
}

// ── TUI overlay dialog ───────────────────────────────────────────────────────

interface DialogResult {
	answer: string;
	wasCustom: boolean;
}

async function openQuestionDialog(ctx: ExtensionContext, params: QuestionUiParams, options: QuestionUiOptions, signal: AbortSignal): Promise<DialogResult | null> {
	const allowCustom = params.allowCustom ?? true;
	const hasOptions = (params.options?.length ?? 0) > 0;
	const choices: { label: string; description?: string; isOther?: boolean }[] = [
		...(params.options ?? []),
		...(allowCustom && hasOptions ? [{ label: "Type your own answer", isOther: true }] : []),
	];

	return ctx.ui.custom<DialogResult | null>(
		(tui, theme, _kb, done) => {
			let optionIndex = 0;
			// A text-only question starts directly in custom-answer entry.
			let editMode = !hasOptions;
			let customText = "";
			let closed = false;
			const finish = (result: DialogResult | null) => {
				if (closed) return;
				closed = true;
				signal.removeEventListener("abort", onAbort);
				done(result);
			};
			const onAbort = () => finish(null);
			signal.addEventListener("abort", onAbort, { once: true });

			const handleKey = (data: string) => {
				if (closed) return;
				if (editMode) {
					if (matchesKey(data, Key.escape)) {
						if (hasOptions) {
							editMode = false;
							customText = "";
							optionIndex = choices.findIndex((c) => c.isOther) >= 0 ? choices.findIndex((c) => c.isOther) : 0;
							return;
						}
						finish(null);
						return;
					}
					if (matchesKey(data, Key.enter)) {
						const trimmed = customText.trim();
						if (trimmed) finish({ answer: trimmed, wasCustom: true });
						else if (!hasOptions) finish(null);
						return;
					}
					if (matchesKey(data, Key.backspace) || matchesKey(data, Key.delete)) {
						customText = customText.slice(0, -1);
						return;
					}
					// Inline text entry: printable input only; escape sequences
					// (arrows, etc.) are never appended as text.
					let printable = data.length > 0;
					for (const char of data) {
						const code = char.codePointAt(0) ?? 0;
						if (code < 32 || code === 127) {
							printable = false;
							break;
						}
					}
					if (printable) customText += data;
					return;
				}
				if (matchesKey(data, Key.up)) {
					optionIndex = Math.max(0, optionIndex - 1);
					return;
				}
				if (matchesKey(data, Key.down)) {
					optionIndex = Math.min(choices.length - 1, optionIndex + 1);
					return;
				}
				if (matchesKey(data, Key.enter)) {
					const selected = choices[optionIndex];
					if (!selected) return;
					if (selected.isOther) {
						editMode = true;
						customText = "";
						return;
					}
					finish({ answer: selected.label, wasCustom: false });
					return;
				}
				if (matchesKey(data, Key.escape)) {
					finish(null);
					return;
				}
			};

			const handleInput = (data: string) => {
				try {
					handleKey(data);
				} finally {
					tui.requestRender();
				}
			};

			const render = (width: number): string[] => {
				const renderWidth = Math.max(1, width);
				const lines: string[] = [];
				const add = (text: string) => lines.push(...wrapTextWithAnsi(text, renderWidth));
				const addWithPrefix = (prefix: string, text: string) => {
					const prefixWidth = visibleWidth(prefix);
					if (prefixWidth >= renderWidth) {
						add(prefix + text);
						return;
					}
					const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
					const continuation = " ".repeat(prefixWidth);
					wrapped.forEach((line, i) => lines.push(`${i === 0 ? prefix : continuation}${line}`));
				};

				lines.push(theme.fg("accent", "─".repeat(renderWidth)));
				if (options.identity) addWithPrefix(" ", theme.fg("muted", options.identity));
				addWithPrefix(" ", theme.fg("text", params.question));
				lines.push("");

				if (hasOptions) {
					for (let i = 0; i < choices.length; i++) {
						const choice = choices[i];
						const selected = i === optionIndex;
						const prefix = selected ? theme.fg("accent", "> ") : "  ";
						const label = `${i + 1}. ${choice.label}${choice.isOther && editMode ? " ✎" : ""}`;
						const color = selected || (choice.isOther && editMode) ? "accent" : "text";
						addWithPrefix(prefix, theme.fg(color, label));
						if (choice.description) addWithPrefix("     ", theme.fg("muted", choice.description));
					}
				} else {
					addWithPrefix(" ", theme.fg("muted", "Your answer:"));
					addWithPrefix(" > ", customText.length ? theme.fg("text", customText) : theme.fg("dim", "…"));
				}

				if (editMode && hasOptions) {
					lines.push("");
					addWithPrefix(" ", theme.fg("muted", "Your answer:"));
					addWithPrefix(" > ", customText.length ? theme.fg("text", customText) : theme.fg("dim", "…"));
				}

				lines.push("");
				addWithPrefix(" ", theme.fg("dim", editMode ? "Enter to submit • Esc to cancel" : "↑↓ navigate • Enter select • Esc cancel"));
				lines.push(theme.fg("accent", "─".repeat(renderWidth)));
				return lines;
			};

			return {
				render,
				invalidate: () => {},
				handleInput,
			};
		},
		{ overlay: true },
	);
}
