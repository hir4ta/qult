/**
 * Zod schemas for all API responses.
 * Single source of truth — frontend imports types via `import type`.
 * Server uses these types for response construction (no runtime .parse()).
 */
import { z } from "zod";

// --- Shared primitives ---

export const StepItemSchema = z.object({
	text: z.string(),
	done: z.boolean(),
});

export const WaveInfoSchema = z.object({
	key: z.string(),
	title: z.string(),
	total: z.number(),
	checked: z.number(),
	isCurrent: z.boolean(),
});

// --- Tasks ---

export const TaskDetailSchema = z.object({
	slug: z.string(),
	status: z.string().optional(),
	focus: z.string().optional(),
	completed: z.number().optional(),
	total: z.number().optional(),
	waves: z.array(WaveInfoSchema).optional(),
	next_steps: z.array(StepItemSchema).optional(),
	started_at: z.string().optional(),
	completed_at: z.string().optional(),
	size: z.string().optional(),
	spec_type: z.string().optional(),
	review_status: z.string().optional(),
	owner: z.string().optional(),
	project_name: z.string().optional(),
});

export const TasksResponseSchema = z.object({
	active: z.string(),
	tasks: z.array(TaskDetailSchema),
	project_name: z.string(),
});

// --- Specs ---

export const SpecEntrySchema = z.object({
	task_slug: z.string(),
	file: z.string(),
	size: z.number(),
	updated_at: z.string(),
});

export const SpecsResponseSchema = z.object({
	specs: z.array(SpecEntrySchema),
});

export const SpecContentResponseSchema = z.object({
	content: z.string(),
});

// --- Knowledge ---

export const KnowledgeEntrySchema = z.object({
	id: z.number(),
	label: z.string(),
	source: z.string(),
	sub_type: z.string(),
	hit_count: z.number(),
	content: z.string(),
	saved_at: z.string().optional(),
	enabled: z.boolean(),
	author: z.string().optional(),
	project_name: z.string().optional(),
	tags: z.array(z.string()).default([]),
	verification_due: z.string().nullable().optional(),
	last_verified: z.string().nullable().optional(),
	verification_count: z.number().optional(),
});

export const KnowledgeResponseSchema = z.object({
	entries: z.array(KnowledgeEntrySchema),
});

export const KnowledgeSearchResponseSchema = z.object({
	entries: z.array(KnowledgeEntrySchema),
	method: z.string(),
});

export const KnowledgeStatsSchema = z.object({
	total: z.number(),
	bySubType: z.record(z.number()),
	avgHitCount: z.number(),
});

// --- Activity ---

export const ActivityEntrySchema = z.object({
	timestamp: z.string(),
	action: z.string(),
	target: z.string(),
	detail: z.string().optional(),
});

export const ActivityResponseSchema = z.object({
	entries: z.array(ActivityEntrySchema),
});

export const AuditLogEntrySchema = z.object({
	id: z.number(),
	projectId: z.string(),
	project_name: z.string().optional(),
	timestamp: z.string(),
	event: z.string(),
	actor: z.string(),
	slug: z.string(),
	action: z.string(),
	detail: z.string(),
});

export const AuditLogResponseSchema = z.object({
	entries: z.array(AuditLogEntrySchema),
	total: z.number(),
});

export const ReworkRateSchema = z.object({
	slug: z.string(),
	size: z.string(),
	completedAt: z.string(),
	reworkRate: z.number(),
	reworkedCount: z.number(),
	totalCount: z.number(),
	pending: z.boolean(),
});

export const CycleTimeSchema = z.object({
	slug: z.string(),
	size: z.string(),
	phases: z.object({
		planning: z.number().nullable(),
		approvalWait: z.number().nullable(),
		implementation: z.number().nullable(),
		total: z.number(),
	}),
});

export const AnalyticsResponseSchema = z.object({
	hitRanking: z.array(z.object({
		id: z.number(),
		title: z.string(),
		hitCount: z.number(),
		projectName: z.string(),
	})),
	completionStats: z.array(z.object({
		size: z.string(),
		avgDays: z.number(),
		count: z.number(),
	})),
	reworkRates: z.array(ReworkRateSchema),
	cycleTimeBreakdown: z.array(CycleTimeSchema),
});

export const KnowledgeGapSchema = z.object({
	query: z.string(),
	intent: z.string(),
	best_score: z.number(),
	result_count: z.number(),
	timestamp: z.string(),
	spec_slug: z.string().optional(),
});

// --- Decisions ---

export const DecisionEntrySchema = z.object({
	id: z.number(),
	label: z.string(),
	source: z.string(),
	sub_type: z.string(),
	hit_count: z.number(),
	content: z.string(),
	saved_at: z.string().optional(),
	enabled: z.boolean(),
	project_name: z.string().optional(),
});

export const DecisionsResponseSchema = z.object({
	decisions: z.array(DecisionEntrySchema),
});

// --- Validation ---

export const ValidationCheckSchema = z.object({
	name: z.string(),
	status: z.string(),
	message: z.string().optional(),
});

export const ValidationReportSchema = z.object({
	checks: z.array(ValidationCheckSchema),
	summary: z.string().optional(),
});

// --- Review ---

export const ReviewCommentSchema = z.object({
	file: z.string(),
	line: z.number(),
	endLine: z.number().optional(),
	body: z.string(),
	resolved: z.boolean().optional(),
});

export const ReviewSchema = z.object({
	timestamp: z.string(),
	status: z.enum(["approved", "changes_requested"]),
	comments: z.array(ReviewCommentSchema).optional(),
	summary: z.string().optional(),
	reviewer: z.string().optional(),
});

export const ReviewStatusResponseSchema = z.object({
	review_status: z.string(),
	latest_review: z.unknown().nullable(),
	unresolved_count: z.number(),
});

export const ReviewHistoryResponseSchema = z.object({
	reviews: z.array(ReviewSchema),
});

// --- Health ---

export const HealthResponseSchema = z.object({
	total: z.number(),
	bySubType: z.record(z.number()),
});

// --- Version ---

export const VersionResponseSchema = z.object({
	version: z.string(),
});

// --- Briefing ---

export const BriefingActiveSpecSchema = z.object({
	slug: z.string(),
	currentWave: z.number(),
	totalWaves: z.number(),
	remainingTasks: z.number(),
});

export const BriefingSchema = z.object({
	activeSpecs: z.array(BriefingActiveSpecSchema),
	completedToday: z.number(),
	knowledgeTotal: z.number(),
	overdueVerifications: z.number(),
	recentCompletions: z.array(z.object({
		slug: z.string(),
		completedAt: z.string(),
	})),
});

// --- Heatmap ---

export const HeatmapEntrySchema = z.object({
	date: z.string(),
	count: z.number(),
});

export const HeatmapSchema = z.object({
	data: z.array(HeatmapEntrySchema),
	weeks: z.number(),
});

// --- Inferred types ---

export type StepItem = z.infer<typeof StepItemSchema>;
export type WaveInfo = z.infer<typeof WaveInfoSchema>;
export type TaskDetail = z.infer<typeof TaskDetailSchema>;
export type TasksResponse = z.infer<typeof TasksResponseSchema>;
export type SpecEntry = z.infer<typeof SpecEntrySchema>;
export type SpecsResponse = z.infer<typeof SpecsResponseSchema>;
export type SpecContentResponse = z.infer<typeof SpecContentResponseSchema>;
export type KnowledgeEntry = z.infer<typeof KnowledgeEntrySchema>;
export type KnowledgeResponse = z.infer<typeof KnowledgeResponseSchema>;
export type KnowledgeSearchResponse = z.infer<typeof KnowledgeSearchResponseSchema>;
export type KnowledgeStats = z.infer<typeof KnowledgeStatsSchema>;
export type ActivityEntry = z.infer<typeof ActivityEntrySchema>;
export type ActivityResponse = z.infer<typeof ActivityResponseSchema>;
export type DecisionEntry = z.infer<typeof DecisionEntrySchema>;
export type DecisionsResponse = z.infer<typeof DecisionsResponseSchema>;
export type ValidationCheck = z.infer<typeof ValidationCheckSchema>;
export type ValidationReport = z.infer<typeof ValidationReportSchema>;
export type ReviewComment = z.infer<typeof ReviewCommentSchema>;
export type Review = z.infer<typeof ReviewSchema>;
export type ReviewStatusResponse = z.infer<typeof ReviewStatusResponseSchema>;
export type ReviewHistoryResponse = z.infer<typeof ReviewHistoryResponseSchema>;
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
export type VersionResponse = z.infer<typeof VersionResponseSchema>;
export type BriefingActiveSpec = z.infer<typeof BriefingActiveSpecSchema>;
export type BriefingResponse = z.infer<typeof BriefingSchema>;
export type HeatmapEntry = z.infer<typeof HeatmapEntrySchema>;
export type HeatmapResponse = z.infer<typeof HeatmapSchema>;
