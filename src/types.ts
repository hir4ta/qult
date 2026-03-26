// ===== Knowledge Types =====

export type KnowledgeType = "error_resolution" | "fix_pattern" | "convention" | "decision";
export const KNOWLEDGE_TYPES: KnowledgeType[] = [
	"error_resolution",
	"fix_pattern",
	"convention",
	"decision",
];

export interface KnowledgeRow {
	id: number;
	projectId: string;
	type: KnowledgeType;
	title: string;
	content: string; // JSON (type-specific structure)
	tags: string;
	author: string;
	hitCount: number;
	lastAccessed: string;
	enabled: boolean;
	createdAt: string;
	updatedAt: string;
}

// Knowledge content JSON structures

export interface ErrorResolutionContent {
	error_signature: string;
	resolution: string;
	context?: string;
}

export interface FixPatternContent {
	file_path: string;
	error_type: "lint" | "type";
	error_signature: string;
	before: string;
	after: string;
	rule?: string;
}

export interface DecisionContent {
	context: string;
	decision: string;
	rationale: string;
	source: "plan" | "commit" | "design_discussion";
}

export interface ConventionContent {
	pattern: string;
	category: string; // naming | imports | error-handling | testing | architecture | style
	example_files?: string[];
}

// ===== Quality Events =====

export type QualityEventType =
	| "gate_pass"
	| "gate_fail"
	| "error_hit"
	| "error_miss"
	| "test_pass"
	| "test_fail"
	| "assertion_warning"
	| "convention_pass"
	| "convention_warn"
	| "plan_created"
	| "knowledge_saved";

export interface QualityEvent {
	id: number;
	projectId: string;
	sessionId: string;
	eventType: QualityEventType;
	data: string; // JSON
	createdAt: string;
}

// ===== Project =====

export interface ProjectRecord {
	id: string;
	name: string;
	remote: string;
	path: string;
	registeredAt: string;
	lastSeenAt: string;
	status: string;
}

// ===== Vector Search =====

export interface VectorMatch {
	sourceId: number;
	score: number;
}

// ===== Quality Score =====

export interface QualityScore {
	sessionScore: number; // 0-100
	breakdown: {
		gatePassRateWrite: { score: number; pass: number; total: number };
		gatePassRateCommit: { score: number; pass: number; total: number };
		errorResolutionHit: { score: number; hit: number; total: number };
		conventionAdherence: { score: number; pass: number; total: number };
	};
	trend: "improving" | "stable" | "declining";
}
