export interface KnowledgeRow {
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
}

export interface ProjectRecord {
	id: string;
	name: string;
	remote: string;
	path: string;
	branch: string;
	registeredAt: string;
	lastSeenAt: string;
	status: string;
	metadata: string;
}

export interface SpecIndexRow {
	id: number;
	projectId: string;
	slug: string;
	fileName: string;
	contentHash: string;
	title: string;
	content: string;
	size: string;
	specType: string;
	status: string;
	createdAt: string;
	updatedAt: string;
}

export interface KnowledgeStats {
	total: number;
	bySubType: Record<string, number>;
	avgHitCount: number;
	topAccessed: KnowledgeRow[];
}

export interface LowVitalityRow extends KnowledgeRow {
	vitality: number;
}

export interface VectorMatch {
	sourceId: number;
	score: number;
	source?: "knowledge" | "spec";
}

export interface KnowledgeConflict {
	a: KnowledgeRow;
	b: KnowledgeRow;
	similarity: number;
	type: "potential_duplicate" | "potential_contradiction";
}

export interface ProjectInfo {
	remote: string;
	path: string;
	name: string;
	branch: string;
}

export interface SessionLink {
	claudeSessionId: string;
	masterSessionId: string;
	projectRemote: string;
	projectPath: string;
	taskSlug: string;
	branch: string;
	linkedAt: string;
}

export interface SessionContinuity {
	masterSessionId: string;
	linkedSessions: string[];
	compactCount: number;
}

export const SUB_TYPE_DECISION = "decision" as const;
export const SUB_TYPE_PATTERN = "pattern" as const;
export const SUB_TYPE_RULE = "rule" as const;
export const SUB_TYPE_SNAPSHOT = "snapshot" as const; // internal: session snapshots, not searchable

export type ValidSubType =
	| typeof SUB_TYPE_DECISION
	| typeof SUB_TYPE_PATTERN
	| typeof SUB_TYPE_RULE;
export const VALID_SUB_TYPES: ValidSubType[] = ["decision", "pattern", "rule"];

// mneme-compatible knowledge schemas (stored as JSON in KnowledgeRow.content)

export interface DecisionEntry {
	id: string;
	title: string;
	context: string;
	decision: string;
	reasoning: string;
	alternatives: string[];
	tags: string[];
	createdAt: string;
	updatedAt?: string;
	status: "draft" | "approved";
	lang?: string;
	author?: string;
	updated_by?: string;
}

export interface PatternEntry {
	id: string;
	type: "good" | "bad" | "error-solution";
	title: string;
	context: string;
	pattern: string;
	applicationConditions: string;
	expectedOutcomes: string;
	tags: string[];
	createdAt: string;
	updatedAt?: string;
	status: "draft" | "approved";
	lang?: string;
	author?: string;
	updated_by?: string;
}

export interface RuleEntry {
	id: string;
	title: string;
	key: string;
	text: string;
	category: string;
	priority: "p0" | "p1" | "p2";
	rationale: string;
	sourceRef?: { type: "decision" | "pattern"; id: string };
	tags: string[];
	createdAt: string;
	updatedAt?: string;
	status: "draft" | "approved";
	lang?: string;
	author?: string;
	updated_by?: string;
}
