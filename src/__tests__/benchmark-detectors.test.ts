import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectSecurityPatterns } from "../hooks/detectors/security-check.ts";
import { detectSemanticPatterns } from "../hooks/detectors/semantic-check.ts";
import {
	analyzeTestQuality,
	getBlockingTestSmells,
} from "../hooks/detectors/test-quality-check.ts";

const FIXTURES_DIR = join(import.meta.dirname, "fixtures/ground-truth");
const manifest = JSON.parse(readFileSync(join(FIXTURES_DIR, "manifest.json"), "utf-8"));

describe("detector precision/recall benchmarks", () => {
	describe("security-check", () => {
		const cases = manifest.security as {
			file: string;
			expected_detections: number;
			description: string;
		}[];

		for (const tc of cases) {
			it(`${tc.file}: ${tc.description}`, () => {
				const file = join(FIXTURES_DIR, tc.file);
				const fixes = detectSecurityPatterns(file);
				const detected = fixes.reduce((sum, f) => sum + f.errors.length, 0);

				if (tc.expected_detections === 0) {
					// True negatives: should not detect anything
					expect(detected).toBe(0);
				} else {
					// True positives: should detect at least some
					expect(detected).toBeGreaterThan(0);
				}
			});
		}

		it("aggregate precision >= 0.7 and recall >= 0.5", () => {
			let totalExpected = 0;
			let totalDetected = 0;
			let truePositives = 0;
			let falsePositives = 0;

			for (const tc of cases) {
				const file = join(FIXTURES_DIR, tc.file);
				const fixes = detectSecurityPatterns(file);
				const detected = fixes.reduce((sum, f) => sum + f.errors.length, 0);

				totalExpected += tc.expected_detections;
				totalDetected += detected;

				if (tc.expected_detections > 0) {
					// For positive cases, detected count up to expected is true positive
					truePositives += Math.min(detected, tc.expected_detections);
					falsePositives += Math.max(0, detected - tc.expected_detections);
				} else {
					// For negative cases, any detection is false positive
					falsePositives += detected;
				}
			}

			const precision = totalDetected > 0 ? truePositives / (truePositives + falsePositives) : 1;
			const recall = totalExpected > 0 ? truePositives / totalExpected : 1;

			console.log(
				`Security: precision=${precision.toFixed(2)}, recall=${recall.toFixed(2)}, TP=${truePositives}, FP=${falsePositives}, expected=${totalExpected}`,
			);

			expect(precision).toBeGreaterThanOrEqual(0.7);
			expect(recall).toBeGreaterThanOrEqual(0.5);
		});
	});

	describe("semantic-check", () => {
		const cases = manifest.semantic as {
			file: string;
			expected_detections: number;
			description: string;
		}[];

		for (const tc of cases) {
			it(`${tc.file}: ${tc.description}`, () => {
				const file = join(FIXTURES_DIR, tc.file);
				const fixes = detectSemanticPatterns(file);
				const detected = fixes.reduce((sum, f) => sum + f.errors.length, 0);

				if (tc.expected_detections === 0) {
					expect(detected).toBe(0);
				} else {
					expect(detected).toBeGreaterThan(0);
				}
			});
		}

		it("aggregate precision >= 0.7 and recall >= 0.5", () => {
			let totalExpected = 0;
			let truePositives = 0;
			let falsePositives = 0;

			for (const tc of cases) {
				const file = join(FIXTURES_DIR, tc.file);
				const fixes = detectSemanticPatterns(file);
				const detected = fixes.reduce((sum, f) => sum + f.errors.length, 0);

				totalExpected += tc.expected_detections;

				if (tc.expected_detections > 0) {
					truePositives += Math.min(detected, tc.expected_detections);
					falsePositives += Math.max(0, detected - tc.expected_detections);
				} else {
					falsePositives += detected;
				}
			}

			const totalDetected = truePositives + falsePositives;
			const precision = totalDetected > 0 ? truePositives / totalDetected : 1;
			const recall = totalExpected > 0 ? truePositives / totalExpected : 1;

			console.log(
				`Semantic: precision=${precision.toFixed(2)}, recall=${recall.toFixed(2)}, TP=${truePositives}, FP=${falsePositives}, expected=${totalExpected}`,
			);

			expect(precision).toBeGreaterThanOrEqual(0.7);
			expect(recall).toBeGreaterThanOrEqual(0.5);
		});
	});

	describe("test-quality-check", () => {
		const cases = manifest["test-quality"] as {
			file: string;
			expected_blocking: number;
			expected_advisory: number;
			description: string;
		}[];

		for (const tc of cases) {
			it(`${tc.file}: ${tc.description}`, () => {
				const file = join(FIXTURES_DIR, tc.file);
				const result = analyzeTestQuality(file);
				expect(result).not.toBeNull();

				const blockingFixes = getBlockingTestSmells(file, result!);
				const blockingCount = blockingFixes.reduce((sum, f) => sum + f.errors.length, 0);
				const advisorySmells = result!.smells.filter(
					(s) =>
						!["empty-test", "always-true", "trivial-assertion", "constant-self"].includes(s.type),
				);

				// Verify detection counts
				expect(blockingCount).toBeGreaterThanOrEqual(tc.expected_blocking);
				expect(advisorySmells.length).toBeGreaterThanOrEqual(tc.expected_advisory);
			});
		}
	});
});
