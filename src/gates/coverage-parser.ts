/**
 * Parse test coverage percentage from various framework outputs.
 * Returns the overall line coverage percentage, or null if not found.
 * Pure function — no side effects.
 */

// Istanbul/NYC table (vitest, jest): "All files |   85.71 | ..."
// The last percentage column is "% Lines"
const ISTANBUL_RE = /All\s+files\s*\|[\s\d.]+\|[\s\d.]+\|[\s\d.]+\|\s*([\d.]+)\s*\|/;

// pytest-cov: "TOTAL    150    30    80%"
const PYTEST_RE = /^TOTAL\s+\d+\s+\d+\s+(\d+)%/m;

// go test: "coverage: 75.3% of statements"
const GO_RE = /coverage:\s*([\d.]+)%\s+of\s+statements/;

// cargo-tarpaulin: "75.00% coverage, 30/40 lines covered"
const TARPAULIN_RE = /([\d.]+)%\s+coverage,\s+\d+\/\d+\s+lines\s+covered/;

export function parseCoveragePercent(output: string): number | null {
	if (!output) return null;

	// Try each pattern in order of specificity
	let match: RegExpMatchArray | null;

	// Istanbul/NYC table (vitest, jest)
	match = output.match(ISTANBUL_RE);
	if (match) return parseFloat(match[1]!);

	// pytest-cov
	match = output.match(PYTEST_RE);
	if (match) return parseFloat(match[1]!);

	// go test
	match = output.match(GO_RE);
	if (match) return parseFloat(match[1]!);

	// cargo-tarpaulin
	match = output.match(TARPAULIN_RE);
	if (match) return parseFloat(match[1]!);

	// cargo-llvm-cov — match Lines Cover (3rd percentage in TOTAL row)
	if (/^TOTAL\s/m.test(output)) {
		// Extract all percentages from the TOTAL line
		const totalLine = output.split("\n").find((l) => /^TOTAL\s/.test(l));
		if (totalLine) {
			const percentages = [...totalLine.matchAll(/([\d.]+)%/g)].map((m) => parseFloat(m[1]!));
			// Lines Cover is typically the 3rd percentage (after Regions Cover, Functions Executed)
			if (percentages.length >= 3) return percentages[2]!;
			if (percentages.length > 0) return percentages[percentages.length - 1]!;
		}
	}

	return null;
}
