import { isGateDisabled } from "../../state/session-state.ts";
import type { PendingFix } from "../../types.ts";

const CHECK_TIMEOUT = 3_000;

// Registry URL builders per package manager
const REGISTRY_URLS: Record<string, (pkg: string) => string> = {
	npm: (pkg) => `https://registry.npmjs.org/${pkg}`,
	yarn: (pkg) => `https://registry.npmjs.org/${pkg}`,
	pnpm: (pkg) => `https://registry.npmjs.org/${pkg}`,
	bun: (pkg) => `https://registry.npmjs.org/${pkg}`,
	pip: (pkg) => `https://pypi.org/pypi/${pkg}/json`,
	cargo: (pkg) => `https://crates.io/api/v1/crates/${pkg}`,
	gem: (pkg) => `https://rubygems.org/api/v1/gems/${pkg}.json`,
	go: (pkg) => `https://proxy.golang.org/${pkg}/@v/list`,
	composer: (pkg) => `https://repo.packagist.org/p2/${pkg}.json`,
};

/** Check if a package exists in its registry.
 *  Returns true if exists or on any error (fail-open).
 *  Returns false only on confirmed 404. */
export async function checkPackageExists(pm: string, packageName: string): Promise<boolean> {
	const urlBuilder = REGISTRY_URLS[pm];
	if (!urlBuilder) return true; // Unknown PM → fail-open

	const url = urlBuilder(packageName);

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT);
	try {
		const response = await fetch(url, {
			method: "HEAD",
			signal: controller.signal,
		});

		if (response.status === 404) return false;
		return true; // 200, 301, 403, etc. → assume exists
	} catch {
		// Network error, timeout, abort → fail-open
		return true;
	} finally {
		clearTimeout(timeout);
	}
}

/** Check a list of packages against their registry.
 *  Returns blocking PendingFix[] for packages that don't exist. */
export async function checkInstalledPackages(
	pm: string,
	packages: string[],
): Promise<PendingFix[]> {
	if (isGateDisabled("hallucinated-package-check")) return [];
	if (packages.length === 0) return [];

	const results = await Promise.allSettled(
		packages.map(async (pkg) => {
			const exists = await checkPackageExists(pm, pkg);
			return { pkg, exists };
		}),
	);

	const nonExistent: string[] = [];
	for (const result of results) {
		if (result.status === "fulfilled" && !result.value.exists) {
			nonExistent.push(result.value.pkg);
		}
		// rejected → fail-open (skip)
	}

	if (nonExistent.length === 0) return [];

	return [
		{
			file: "(install-command)",
			gate: "hallucinated-package-check",
			errors: nonExistent.map(
				(pkg) =>
					`Package "${pkg}" does not exist in ${pm} registry — possible hallucination. Remove or replace with a real package.`,
			),
		},
	];
}
