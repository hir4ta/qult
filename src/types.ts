// ===== v1 Compatibility (removed in Phase 1 when store is rewritten) =====

/** @deprecated v1 compat — will be removed in Phase 1 */
export interface KnowledgeRowV1 {
	id: number;
	projectId: string;
	filePath: string;
	contentHash: string;
	title: string;
	content: string;
	subType: string;
	branch: string;
	author: string;
	createdAt: string;
	updatedAt: string;
	hitCount: number;
	lastAccessed: string;
	enabled: boolean;
	verificationDue?: string | null;
	lastVerified?: string | null;
	verificationCount?: number;
}

/** @deprecated v1 compat */
export interface KnowledgeStats {
	total: number;
	bySubType: Record<string, number>;
	avgHitCount: number;
	topAccessed: KnowledgeRowV1[];
}

/** @deprecated v1 compat */
export interface KnowledgeConflict {
	a: KnowledgeRowV1;
	b: KnowledgeRowV1;
	similarity: number;
	type: "potential_duplicate" | "potential_contradiction";
}

/** @deprecated v1 compat */
export interface ProjectInfo {
	remote: string;
	path: string;
	name: string;
	branch: string;
}

// ===== v2 Knowledge Types =====

export type KnowledgeType = "error_resolution" | "exemplar" | "convention";
export const KNOWLEDGE_TYPES: KnowledgeType[] = ["error_resolution", "exemplar", "convention"];

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

export interface ExemplarContent {
	bad: string;
	good: string;
	explanation: string;
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
	| "convention_warn";

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
	/** @deprecated v1 compat — removed in Phase 1 */
	branch: string;
	registeredAt: string;
	lastSeenAt: string;
	status: string;
	/** @deprecated v1 compat — removed in Phase 1 */
	metadata: string;
}

// ===== Vector Search =====

export interface VectorMatch {
	sourceId: number;
	score: number;
	/** @deprecated v1 compat — removed in Phase 1 */
	source?: "knowledge" | "spec";
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
