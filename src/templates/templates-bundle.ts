/**
 * Compiled template bundle — Bun's bundler inlines these at build time.
 * This file is imported by index.ts via require() which Bun resolves
 * at compile time but Vite ignores (caught by try/catch).
 */

import agentPlanEvaluator from "./agent-plan-evaluator.md" with { type: "text" };
import agentPlanGenerator from "./agent-plan-generator.md" with { type: "text" };
import agentReviewer from "./agent-reviewer.md" with { type: "text" };
import rulesPlan from "./rules-plan.md" with { type: "text" };
import rulesQuality from "./rules-quality.md" with { type: "text" };
import skillDetectGates from "./skill-detect-gates.md" with { type: "text" };
import skillPlanGenerator from "./skill-plan-generator.md" with { type: "text" };
import skillReview from "./skill-review.md" with { type: "text" };

export const TEMPLATES: Record<string, string> = {
	"skill-review.md": skillReview,
	"agent-reviewer.md": agentReviewer,
	"skill-detect-gates.md": skillDetectGates,
	"agent-plan-generator.md": agentPlanGenerator,
	"skill-plan-generator.md": skillPlanGenerator,
	"agent-plan-evaluator.md": agentPlanEvaluator,
	"rules-quality.md": rulesQuality,
	"rules-plan.md": rulesPlan,
};
