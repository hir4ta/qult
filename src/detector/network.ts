/**
 * Network availability probe used by detectors that require external APIs
 * (dep-vuln-check / hallucinated-package-check).
 *
 * Returns `true` only when a HEAD request to the npm registry ping endpoint
 * succeeds within `timeoutMs`. Any error (DNS, abort, non-2xx) yields `false`,
 * letting callers gracefully skip network-bound work in air-gapped runs.
 */

const PING_URL = "https://registry.npmjs.org/-/ping";

export async function isNetworkAvailable(timeoutMs = 2000): Promise<boolean> {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const res = await fetch(PING_URL, { method: "HEAD", signal: ctrl.signal });
		return res.ok;
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}
