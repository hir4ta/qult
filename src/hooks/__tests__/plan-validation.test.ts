import { describe, expect, it } from "vitest";
import { isPlanFile, validatePlanStructure } from "../detect.js";

describe("isPlanFile", () => {
	it("detects .claude/plans/ files", () => {
		expect(isPlanFile("/Users/foo/.claude/plans/my-plan.md")).toBe(true);
		expect(isPlanFile("/home/user/.claude/plans/lovely-stargazing-papert.md")).toBe(true);
	});

	it("detects plan*.md files", () => {
		expect(isPlanFile("/project/plan.md")).toBe(true);
		expect(isPlanFile("/project/plan-v2.md")).toBe(true);
	});

	it("rejects non-plan files", () => {
		expect(isPlanFile("/project/src/foo.ts")).toBe(false);
		expect(isPlanFile("/project/README.md")).toBe(false);
		expect(isPlanFile("/project/explanation.md")).toBe(false);
	});
});

describe("validatePlanStructure", () => {
	it("validates well-structured plan", () => {
		const plan = `# Plan
## Context
Something

## Phases
### Phase 1: Foundation
- **Acceptance Criteria**: tests pass
- **Test Plan**: run vitest

### Phase 2: Enhancement
- **Acceptance Criteria**: lint clean
- **Test Plan**: run biome
`;
		const result = validatePlanStructure(plan);
		expect(result.hasPhases).toBe(true);
		expect(result.phaseCount).toBe(2);
		expect(result.phasesWithCriteria).toBe(2);
		expect(result.hasTestPlan).toBe(true);
	});

	it("detects missing phases", () => {
		const plan = "# Plan\nJust do everything at once.";
		const result = validatePlanStructure(plan);
		expect(result.hasPhases).toBe(false);
		expect(result.phaseCount).toBe(0);
	});

	it("detects phases without criteria", () => {
		const plan = `### Phase 1: Do stuff\nJust do it\n### Phase 2: More stuff\nDo more`;
		const result = validatePlanStructure(plan);
		expect(result.hasPhases).toBe(true);
		expect(result.phaseCount).toBe(2);
		expect(result.phasesWithCriteria).toBe(0);
	});

	it("detects missing test plan", () => {
		const plan = `### Phase 1: Foo\n- **Acceptance Criteria**: done`;
		const result = validatePlanStructure(plan);
		expect(result.hasTestPlan).toBe(false);
	});
});
