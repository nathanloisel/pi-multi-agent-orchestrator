/**
 * Pure planning helper for scripts/install-pi-test-version.mjs.
 *
 * Maps a requested pi version/tag plus npm registry metadata onto the concrete
 * npm install arguments used to create a "selected pi version" test overlay in
 * node_modules (no manifest/lock changes). Kept pure so tests can cover the
 * mapping with mocked metadata and no network.
 */

const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

/**
 * Resolve a requested pi release ("0.85.1", "0.87.0", "latest", or another
 * Resolve a requested pi release ("0.85.1", "0.87.0", "latest", or another
 * dist-tag) to an exact coding-agent version.
 *
 * @param {{ requested: string, distTags: Record<string, string> | undefined }} input
 * @returns {string} exact version
 */
export function resolveVersion(input) {
	const { requested, distTags } = input;

	if (typeof requested !== "string" || requested.trim() === "") {
		throw new Error("No pi version requested. Pass an exact version (e.g. 0.87.0), 'latest', or a dist-tag name.");
	}
	const wanted = requested.trim();

	let version;
	if (SEMVER_RE.test(wanted)) {
		version = wanted;
	} else if (wanted === "latest" && (!distTags || typeof distTags !== "object" || Array.isArray(distTags))) {
		// 'latest' must resolve via dist-tags; without metadata we cannot guess.
		throw new Error("Could not resolve dist-tag 'latest': npm dist-tags metadata was missing or malformed.");
	} else if (distTags && Object.hasOwn(distTags, wanted)) {
		version = distTags[wanted];
	} else {
		const known = distTags ? Object.keys(distTags).join(", ") : "none";
		throw new Error(
			`Requested pi version '${wanted}' is neither an exact semver version nor a known dist-tag (known: ${known}).`,
		);
	}
	if (!SEMVER_RE.test(version)) {
		throw new Error(`Dist-tag '${wanted}' resolved to '${version}', which is not a valid exact version.`);
	}
	return version;
}

/**
 * Derive the install plan for the orchestrator's declared peer packages from
 * the SELECTED release's own dependencies — so peers always match the selected
 * pi instead of assuming every package shares one version.
 *
 * @param {{
 *   requested: string,
 *   distTags: Record<string, string>,
 *   codingAgentDependencies: Record<string, string>,
 *   peerPackageNames?: string[],
 * }} input
 * @returns {{
 *   codingAgent: { name: string, version: string },
 *   peers: Array<{ name: string, spec: string }>,
 * }}
 */
export function resolveInstallPlan(input) {
	const {
		requested,
		distTags,
		codingAgentDependencies,
		peerPackageNames = [
			"@earendil-works/pi-ai",
			"@earendil-works/pi-tui",
			"typebox",
		],
	} = input;

	const version = resolveVersion({ requested, distTags });

	const codingAgent = { name: "@earendil-works/pi-coding-agent", version };
	const peers = peerPackageNames.map((name) => {
		const spec = codingAgentDependencies?.[name];
		if (typeof spec !== "string" || spec.trim() === "") {
			throw new Error(
				`Selected pi ${version} does not declare a dependency on peer package '${name}'. ` +
					`Cannot guarantee matching peer versions — refusing to install a mixed tree.`,
			);
		}
		return { name, spec };
	});

	return { codingAgent, peers };
}

/** Concrete argv tail (package specs) handed to `npm install --no-save`. */
export function installSpecs(plan) {
	return [`${plan.codingAgent.name}@${plan.codingAgent.version}`, ...plan.peers.map((p) => `${p.name}@${p.spec}`)];
}

/** One-line human-readable summary of the resolved profile (for CI logs). */
export function describePlan(plan) {
	const peers = plan.peers.map((p) => `${p.name}@${p.spec}`).join(" ");
	return `pi coding-agent ${plan.codingAgent.version}; matched peers: ${peers}`;
}
