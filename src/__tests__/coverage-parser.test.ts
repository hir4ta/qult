import { describe, expect, it } from "vitest";
import { parseCoveragePercent } from "../gates/coverage-parser.ts";

describe("parseCoveragePercent", () => {
	it("returns null for empty output", () => {
		expect(parseCoveragePercent("")).toBeNull();
	});

	it("returns null for output without coverage data", () => {
		expect(parseCoveragePercent("All tests passed\n✓ 42 tests")).toBeNull();
	});

	// vitest/istanbul format: "All files  |   85.71 |    78.57 |   90.00 |   85.71"
	it("parses vitest/istanbul coverage output", () => {
		const output = `
----------|---------|----------|---------|---------|
File      | % Stmts | % Branch | % Funcs | % Lines |
----------|---------|----------|---------|---------|
All files |   85.71 |    78.57 |   90.00 |   85.71 |
 foo.ts   |   85.71 |    78.57 |   90.00 |   85.71 |
----------|---------|----------|---------|---------|`;
		expect(parseCoveragePercent(output)).toBe(85.71);
	});

	// jest format: same istanbul table
	it("parses jest coverage output", () => {
		const output = `
----------|---------|----------|---------|---------|-------------------
File      | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s
----------|---------|----------|---------|---------|-------------------
All files |     100 |      100 |     100 |     100 |
 index.js |     100 |      100 |     100 |     100 |
----------|---------|----------|---------|---------|-------------------`;
		expect(parseCoveragePercent(output)).toBe(100);
	});

	// vitest/v8 format: "All files  |   72.5 |    65.2 |   80.0 |   72.5"
	it("parses vitest v8 coverage output", () => {
		const output = `
 % Coverage report from v8
----------|---------|----------|---------|---------|
File      | % Stmts | % Branch | % Funcs | % Lines |
----------|---------|----------|---------|---------|
All files |    72.5 |     65.2 |    80.0 |    72.5 |
----------|---------|----------|---------|---------|`;
		expect(parseCoveragePercent(output)).toBe(72.5);
	});

	// pytest-cov format: "TOTAL                    150     30    80%"
	it("parses pytest-cov coverage output", () => {
		const output = `
Name                      Stmts   Miss  Cover
---------------------------------------------
src/__init__.py               0      0   100%
src/main.py                 100     20    80%
src/utils.py                 50     10    80%
---------------------------------------------
TOTAL                       150     30    80%`;
		expect(parseCoveragePercent(output)).toBe(80);
	});

	// go test -cover format: "coverage: 75.3% of statements"
	it("parses go test coverage output", () => {
		const output = `ok  	github.com/user/pkg	0.123s	coverage: 75.3% of statements`;
		expect(parseCoveragePercent(output)).toBe(75.3);
	});

	// cargo-tarpaulin format: "75.00% coverage, 30/40 lines covered"
	it("parses cargo tarpaulin coverage output", () => {
		const output = `Apr 10 23:00:00.000  INFO cargo_tarpaulin: 75.00% coverage, 30/40 lines covered`;
		expect(parseCoveragePercent(output)).toBe(75);
	});

	// cargo-llvm-cov format: "TOTAL [... ] 82.5%"
	it("parses cargo-llvm-cov coverage output", () => {
		const output = `Filename                      Regions    Missed Regions     Cover   Functions  Missed Functions  Executed       Lines      Missed Lines     Cover    Branches   Missed Branches     Cover
-------                       -------    -------            -------  ---------  ---------         ---------      -----      -----            -----    --------   --------            -----
TOTAL                              40                 7     82.50%         10                 2     80.00%         100                17     83.00%          0                 0         -`;
		expect(parseCoveragePercent(output)).toBe(83);
	});

	it("returns number between 0 and 100 for valid output", () => {
		const output = `All files |     0 |      0 |     0 |     0 |`;
		const result = parseCoveragePercent(output);
		expect(result).toBe(0);
	});
});
