import { describe, expect, it } from "vitest";
import {
	ActivityEntrySchema,
	DecisionEntrySchema,
	EpicSummarySchema,
	GraphEdgesResponseSchema,
	HealthResponseSchema,
	KnowledgeEntrySchema,
	KnowledgeStatsSchema,
	ReviewSchema,
	ReviewStatusResponseSchema,
	TaskDetailSchema,
	TasksResponseSchema,
	ValidationReportSchema,
	VersionResponseSchema,
} from "../schemas.js";

describe("API schemas smoke test", () => {
	it("KnowledgeEntry parses valid data", () => {
		const data = {
			id: 1,
			label: "Test decision",
			source: "decisions/test.json",
			sub_type: "decision",
			hit_count: 5,
			content: '{"decision":"test"}',
			saved_at: "2026-03-19T10:00:00Z",
			enabled: true,
			project_name: "alfred",
		};
		expect(KnowledgeEntrySchema.parse(data)).toEqual(data);
	});

	it("KnowledgeEntry rejects missing required fields", () => {
		expect(() => KnowledgeEntrySchema.parse({ id: 1 })).toThrow();
	});

	it("TaskDetail parses minimal data", () => {
		const data = { slug: "my-task" };
		expect(TaskDetailSchema.parse(data)).toMatchObject({ slug: "my-task" });
	});

	it("TasksResponse parses full response", () => {
		const data = {
			active: "my-task",
			tasks: [{ slug: "my-task", status: "active", completed: 3, total: 5 }],
			project_name: "test",
		};
		expect(TasksResponseSchema.parse(data)).toEqual(data);
	});

	it("GraphEdgesResponse parses vector method", () => {
		const data = {
			edges: [{ source: 1, target: 2, score: 0.85 }],
			method: "vector" as const,
			truncated: false,
		};
		expect(GraphEdgesResponseSchema.parse(data)).toEqual(data);
	});

	it("GraphEdgesResponse rejects invalid method", () => {
		expect(() =>
			GraphEdgesResponseSchema.parse({ edges: [], method: "invalid", truncated: false }),
		).toThrow();
	});

	it("ReviewStatusResponse parses wrapper shape", () => {
		const data = {
			review_status: "approved",
			latest_review: { timestamp: "2026-03-19", status: "approved", comments: [] },
			unresolved_count: 0,
		};
		expect(ReviewStatusResponseSchema.parse(data)).toEqual(data);
	});

	it("Review parses inner review object", () => {
		const data = {
			timestamp: "2026-03-19T10:00:00Z",
			status: "approved" as const,
			comments: [{ file: "design.md", line: 10, body: "LGTM" }],
		};
		expect(ReviewSchema.parse(data)).toEqual(data);
	});

	it("ValidationReport includes optional summary", () => {
		const data = {
			checks: [{ name: "required_sections", status: "pass", message: "OK" }],
			summary: "1/1 passed",
		};
		expect(ValidationReportSchema.parse(data)).toEqual(data);
	});

	it("KnowledgeStats parses stats response", () => {
		const data = { total: 10, bySubType: { decision: 5, pattern: 3, rule: 2 }, avgHitCount: 3.5 };
		expect(KnowledgeStatsSchema.parse(data)).toEqual(data);
	});

	it("HealthResponse parses health endpoint", () => {
		const data = { total: 10, bySubType: { decision: 5 } };
		expect(HealthResponseSchema.parse(data)).toEqual(data);
	});

	it("ActivityEntry parses audit log entry", () => {
		const data = { timestamp: "2026-03-19", action: "spec.init", target: "my-task" };
		expect(ActivityEntrySchema.parse(data)).toMatchObject(data);
	});

	it("EpicSummary parses with tasks", () => {
		const data = {
			slug: "my-epic",
			name: "Test Epic",
			status: "in-progress",
			completed: 1,
			total: 3,
			tasks: [{ slug: "task-1", status: "done" }],
		};
		expect(EpicSummarySchema.parse(data)).toEqual(data);
	});

	it("DecisionEntry matches KnowledgeEntry shape", () => {
		const data = {
			id: 1,
			label: "DEC-1",
			source: "decisions/dec-1.json",
			sub_type: "decision",
			hit_count: 0,
			content: "{}",
			enabled: true,
		};
		expect(DecisionEntrySchema.parse(data)).toMatchObject(data);
	});

	it("VersionResponse parses version string", () => {
		expect(VersionResponseSchema.parse({ version: "0.3.16" })).toEqual({ version: "0.3.16" });
	});
});
