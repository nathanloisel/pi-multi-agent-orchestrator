export interface InstallPlan {
	codingAgent: { name: string; version: string };
	peers: Array<{ name: string; spec: string }>;
}

export declare function resolveVersion(input: {
	requested: string;
	distTags: Record<string, string> | undefined;
}): string;

export declare function resolveInstallPlan(input: {
	requested: string;
	distTags: Record<string, string> | undefined;
	codingAgentDependencies: Record<string, string> | undefined;
	peerPackageNames?: string[];
}): InstallPlan;

export declare function installSpecs(plan: InstallPlan): string[];

export declare function describePlan(plan: InstallPlan): string;
