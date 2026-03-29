declare const __QULT_VERSION__: string;

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { defineCommand } from "citty";

const REPO = "user/qult";

/** Detect current platform in the same format as release artifacts */
function detectPlatform(): string | null {
	let os: string;
	if (process.platform === "darwin") os = "darwin";
	else if (process.platform === "linux") os = "linux";
	else return null;
	const arch = process.arch === "arm64" ? "arm64" : "x64";
	return `${os}-${arch}`;
}

/** Get current qult version */
function currentVersion(): string {
	return typeof __QULT_VERSION__ !== "undefined" ? __QULT_VERSION__ : "dev";
}

/** Fetch latest version tag from GitHub Releases API */
function fetchLatestVersion(): string | null {
	try {
		const output = execSync(`curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest"`, {
			encoding: "utf-8",
			timeout: 10000,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const match = output.match(/"tag_name":\s*"([^"]+)"/);
		return match?.[1] ?? null;
	} catch {
		return null;
	}
}

/** Compare semver strings. Returns true if remote > local. */
export function isNewer(remote: string, local: string): boolean {
	const normalize = (v: string) => v.replace(/^v/, "");
	const rParts = normalize(remote).split(".").map(Number);
	const lParts = normalize(local).split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		const r = rParts[i] ?? 0;
		const l = lParts[i] ?? 0;
		if (r > l) return true;
		if (r < l) return false;
	}
	return false;
}

/** Download a file using curl */
function download(url: string, dest: string): boolean {
	try {
		execSync(`curl -fsSL -o "${dest}" "${url}"`, {
			timeout: 60000,
			stdio: ["ignore", "pipe", "pipe"],
		});
		return true;
	} catch {
		return false;
	}
}

/** Compute SHA256 of a file */
function sha256File(path: string): string {
	const hash = createHash("sha256");
	const data = require("node:fs").readFileSync(path);
	hash.update(data);
	return hash.digest("hex");
}

export async function runSelfUpdate(targetVersion?: string): Promise<void> {
	const current = currentVersion();
	console.log(`Current version: ${current}`);

	if (current === "dev") {
		console.log("Cannot self-update a development build. Use git pull instead.");
		return;
	}

	// Resolve version
	const version = targetVersion ?? fetchLatestVersion();
	if (!version) {
		console.error("Error: Could not fetch latest version from GitHub.");
		return;
	}

	console.log(`Latest version:  ${version}`);

	if (!targetVersion && !isNewer(version, current)) {
		console.log("Already up to date.");
		return;
	}

	const platform = detectPlatform();
	if (!platform) {
		console.error(`Error: Unsupported platform: ${process.platform}`);
		return;
	}
	const artifact = `qult-${platform}.tar.gz`;
	const baseUrl = `https://github.com/${REPO}/releases/download/${version}`;

	// Download to isolated temp directory
	const { mkdtempSync } = require("node:fs");
	const tmpDir = mkdtempSync(join(require("node:os").tmpdir(), "qult-update-"));
	const tmpArchive = join(tmpDir, `qult-update-${Date.now()}.tar.gz`);
	const tmpChecksumFile = `${tmpArchive}.sha256`;

	console.log(`Downloading ${artifact}...`);

	if (!download(`${baseUrl}/${artifact}`, tmpArchive)) {
		console.error(`Error: Failed to download ${artifact}`);
		return;
	}

	if (!download(`${baseUrl}/${artifact}.sha256`, tmpChecksumFile)) {
		console.error("Warning: Could not download checksum file, skipping verification.");
	} else {
		// Verify checksum
		const expectedLine = require("node:fs").readFileSync(tmpChecksumFile, "utf-8");
		const expected = expectedLine.trim().split(/\s+/)[0];
		const actual = sha256File(tmpArchive);

		if (expected !== actual) {
			console.error("Error: Checksum mismatch");
			console.error(`  Expected: ${expected}`);
			console.error(`  Actual:   ${actual}`);
			try {
				unlinkSync(tmpArchive);
				unlinkSync(tmpChecksumFile);
			} catch {
				/* ignore */
			}
			return;
		}
		console.log("Checksum verified.");
	}

	// Extract
	const tmpBinary = join(tmpDir, `qult-update-bin-${Date.now()}`);
	try {
		execSync(`tar xzf "${tmpArchive}" -C "${tmpDir}"`, { stdio: "pipe" });
		const extractedBin = join(tmpDir, "qult");
		if (existsSync(extractedBin)) {
			renameSync(extractedBin, tmpBinary);
		}
	} catch {
		console.error("Error: Failed to extract archive");
		return;
	}

	// Find current binary location
	let currentBinaryPath: string;
	try {
		currentBinaryPath = execSync("which qult", { encoding: "utf-8", stdio: "pipe" }).trim();
	} catch {
		currentBinaryPath = join(process.env.HOME ?? "", ".local", "bin", "qult");
	}

	// Atomic replace
	try {
		const { chmodSync } = require("node:fs");
		chmodSync(tmpBinary, 0o755);
		renameSync(tmpBinary, currentBinaryPath);
		console.log(`Updated ${currentBinaryPath} to ${version}`);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`Error: Could not replace binary: ${msg}`);
		console.error(`Try: sudo mv ${tmpBinary} ${currentBinaryPath}`);
		return;
	}

	// Cleanup
	try {
		unlinkSync(tmpArchive);
		unlinkSync(tmpChecksumFile);
	} catch {
		/* ignore */
	}

	// Update templates
	console.log("Updating hooks and templates...");
	try {
		execSync(`"${currentBinaryPath}" init --force`, { stdio: "inherit" });
	} catch {
		console.log("Warning: Could not auto-update templates. Run 'qult init --force' manually.");
	}

	console.log(`\nqult updated to ${version}`);
}

export const selfUpdateCommand = defineCommand({
	meta: { description: "Update qult to the latest version" },
	args: {
		version: {
			type: "positional",
			description: "Target version (default: latest)",
			required: false,
		},
	},
	async run({ args }) {
		if (process.env.QULT_NO_UPDATE === "1") {
			console.log("Self-update disabled (QULT_NO_UPDATE=1).");
			return;
		}
		await runSelfUpdate(args.version as string | undefined);
	},
});
