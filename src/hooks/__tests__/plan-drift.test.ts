import { describe, expect, it } from "vitest";
import { extractPlanCriteria } from "../detect.js";

const SAMPLE_PLAN = `# Implementation Plan

## Context
Implement auth module.

### Phase 1: Core Auth
- **Files**: \`src/auth.ts\`, \`src/middleware.ts\`
- **Acceptance Criteria**:
  - Login returns JWT token
  - Token refresh works within 5 minutes
- **Test Plan**: Unit tests for auth.ts

### Phase 2: OAuth Integration
- **Files**: \`src/oauth.ts\`, \`src/providers/google.ts\`
- **Acceptance Criteria**:
  - Google OAuth flow completes
  - Token stored in session
`;

describe("plan drift", () => {
	describe("extractPlanCriteria", () => {
		it("extracts phases from plan markdown", () => {
			const phases = extractPlanCriteria(SAMPLE_PLAN);
			expect(phases).toHaveLength(2);
		});

		it("extracts phase names", () => {
			const phases = extractPlanCriteria(SAMPLE_PLAN);
			expect(phases[0]!.name).toContain("Phase 1");
		});

		it("extracts file paths", () => {
			const phases = extractPlanCriteria(SAMPLE_PLAN);
			expect(phases[0]!.files).toContain("src/auth.ts");
			expect(phases[0]!.files).toContain("src/middleware.ts");
		});

		it("extracts acceptance criteria", () => {
			const phases = extractPlanCriteria(SAMPLE_PLAN);
			expect(phases[0]!.criteria.length).toBeGreaterThanOrEqual(2);
			expect(phases[0]!.criteria.some((c) => c.includes("Login returns JWT"))).toBe(true);
			expect(phases[0]!.criteria.some((c) => c.includes("Token refresh"))).toBe(true);
		});

		it("extracts second phase criteria", () => {
			const phases = extractPlanCriteria(SAMPLE_PLAN);
			expect(phases[1]!.criteria.length).toBeGreaterThanOrEqual(2);
			expect(phases[1]!.criteria.some((c) => c.includes("Google OAuth"))).toBe(true);
		});

		it("returns empty for content without phases", () => {
			const phases = extractPlanCriteria("# Just a doc\nSome text.");
			expect(phases).toHaveLength(0);
		});

		it("handles plan with no acceptance criteria", () => {
			const plan = "### Phase 1: Setup\nJust do things.\n### Phase 2: Build\nBuild stuff.";
			const phases = extractPlanCriteria(plan);
			expect(phases).toHaveLength(2);
			expect(phases[0]!.criteria).toHaveLength(0);
		});

		it("deduplicates file paths", () => {
			const plan = "### Phase 1: Test\nEdit `src/foo.ts` and `src/foo.ts` again.";
			const phases = extractPlanCriteria(plan);
			const fileCount = phases[0]!.files.filter((f) => f === "src/foo.ts").length;
			expect(fileCount).toBeLessThanOrEqual(1);
		});
	});
});
