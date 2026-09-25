/**
 * Compatibility probe extension — loaded alongside the orchestrator worker
 * extension (via a second `-e` path) in the REAL pi RPC compatibility smoke
 * test. At session_start it reports the actual tool surface through pi's
 * NATIVE extension-UI envelope (ctx.ui.notify → `extension_ui_request` on
 * stdout in RPC mode). No raw custom stdout protocol is used.
 *
 * Must be loaded AFTER worker.ts (later `-e` = later session_start handler)
 * so the probe observes the active tool set AFTER the worker unions the live
 * messaging tools in.
 */

export default function (pi: {
	getAllTools: () => Array<{ name: string }>;
	getActiveTools: () => string[];
	on: (event: string, handler: (e: unknown, ctx: unknown) => Promise<void> | void) => void;
}) {
	pi.on("session_start", async (_event, ctx) => {
		const ui = (ctx as { ui?: { notify?: (message: string, level?: string) => void } }).ui;
		ui?.notify?.(
			`PROBE:${JSON.stringify({
				all: pi.getAllTools().map((t) => t.name).sort(),
				active: [...pi.getActiveTools()].sort(),
				mode: (ctx as { mode?: string }).mode,
			})}`,
			"info",
		);
	});
}
