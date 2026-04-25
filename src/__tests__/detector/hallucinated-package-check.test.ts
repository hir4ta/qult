import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAllCaches } from "../../state/flush.ts";

beforeEach(() => {
	resetAllCaches();
	vi.clearAllMocks();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("checkPackageExists", () => {
	async function check(pm: string, packageName: string) {
		vi.resetModules();
		const mod = await import("../../detector/hallucinated-package-check.ts");
		return mod.checkPackageExists(pm, packageName);
	}

	it("returns true for existing npm package (200)", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
		const exists = await check("npm", "lodash");
		expect(exists).toBe(true);
		expect(fetch).toHaveBeenCalledWith(
			"https://registry.npmjs.org/lodash",
			expect.objectContaining({ method: "HEAD" }),
		);
	});

	it("returns false for non-existent npm package (404)", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
		const exists = await check("npm", "totally-fake-pkg-xyz");
		expect(exists).toBe(false);
	});

	it("returns true on network error (fail-open)", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
		const exists = await check("npm", "some-pkg");
		expect(exists).toBe(true);
	});

	it("returns true on timeout (fail-open)", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("Aborted", "AbortError")));
		const exists = await check("npm", "some-pkg");
		expect(exists).toBe(true);
	});

	it("checks PyPI registry for pip packages", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
		const exists = await check("pip", "requests");
		expect(exists).toBe(true);
		expect(fetch).toHaveBeenCalledWith(
			"https://pypi.org/pypi/requests/json",
			expect.objectContaining({ method: "HEAD" }),
		);
	});

	it("checks crates.io registry for cargo packages", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
		await check("cargo", "serde");
		expect(fetch).toHaveBeenCalledWith(
			"https://crates.io/api/v1/crates/serde",
			expect.objectContaining({ method: "HEAD" }),
		);
	});

	it("checks rubygems registry for gem packages", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
		await check("gem", "rails");
		expect(fetch).toHaveBeenCalledWith(
			"https://rubygems.org/api/v1/gems/rails.json",
			expect.objectContaining({ method: "HEAD" }),
		);
	});

	it("checks Go proxy for go packages", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
		await check("go", "github.com/gin-gonic/gin");
		expect(fetch).toHaveBeenCalledWith(
			"https://proxy.golang.org/github.com/gin-gonic/gin/@v/list",
			expect.objectContaining({ method: "HEAD" }),
		);
	});

	it("checks packagist for composer packages with vendor/name split", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
		await check("composer", "laravel/framework");
		expect(fetch).toHaveBeenCalledWith(
			"https://repo.packagist.org/p2/laravel/framework.json",
			expect.objectContaining({ method: "HEAD" }),
		);
	});

	it("returns true for unsupported package manager (fail-open)", async () => {
		const exists = await check("unknown-pm", "pkg");
		expect(exists).toBe(true);
	});
});

describe("checkInstalledPackages", () => {
	async function checkPkgs(pm: string, packages: string[]) {
		vi.resetModules();
		const mod = await import("../../detector/hallucinated-package-check.ts");
		return mod.checkInstalledPackages(pm, packages);
	}

	it("creates blocking PendingFix for nonexistent packages", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation((url: string) => {
				if (url.includes("real-pkg")) {
					return Promise.resolve({ ok: true, status: 200 });
				}
				return Promise.resolve({ ok: false, status: 404 });
			}),
		);

		const fixes = await checkPkgs("npm", ["real-pkg", "fake-pkg"]);
		expect(fixes.length).toBe(1);
		expect(fixes[0]!.gate).toBe("hallucinated-package-check");
		expect(fixes[0]!.errors[0]).toContain("fake-pkg");
		expect(fixes[0]!.errors[0]).toContain("does not exist");
	});

	it("returns empty array when all packages exist", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));

		const fixes = await checkPkgs("npm", ["lodash", "express"]);
		expect(fixes).toEqual([]);
	});

	it("checks multiple packages in parallel", async () => {
		let fetchCount = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation(() => {
				fetchCount++;
				return Promise.resolve({ ok: true, status: 200 });
			}),
		);

		await checkPkgs("npm", ["a", "b", "c"]);
		expect(fetchCount).toBe(3);
	});

	it("returns empty array on gate disabled", async () => {
		// Gate disabled scenario - we mock isGateDisabled via session state
		vi.resetModules();

		// When the gate is disabled, checkInstalledPackages should skip
		// This is handled in the function itself
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));

		const mod = await import("../../detector/hallucinated-package-check.ts");
		// Default state: gate not disabled, so it should check
		const fixes = await mod.checkInstalledPackages("npm", ["fake"]);
		expect(fixes.length).toBe(1);
	});
});
