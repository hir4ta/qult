import { ReviewPanel } from "@/components/review/ReviewPanel";
import { SectionCard, SPEC_FILE_COLORS } from "@/components/section-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
	specContentQueryOptions,
	specsQueryOptions,
	tasksQueryOptions,
	validationQueryOptions,
} from "@/lib/api";
import type { SpecEntry, TaskDetail, ValidationReport } from "@/lib/types";
import { useQueries, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Calendar, CircleCheck, CircleDot, MessageSquareText } from "lucide-react";
import { useState } from "react";

export const Route = createFileRoute("/tasks/$slug")({
	component: TaskDetailPage,
});

const SIZE_LABELS: Record<string, string> = {
	S: "Small — 3 spec files",
	M: "Medium — 4-5 spec files",
	L: "Large — 7 spec files",
	XL: "Extra Large — 7 spec files",
	D: "Delta — 2 spec files",
};

function TaskDetailPage() {
	const { slug } = Route.useParams();
	const { data: tasksData } = useQuery(tasksQueryOptions());
	const { data: specsData } = useQuery(specsQueryOptions(slug));
	const { data: validationData } = useQuery(validationQueryOptions(slug));
	const [reviewFile, setReviewFile] = useState<string | null>(null);

	const task = tasksData?.tasks.find((t) => t.slug === slug);
	const specs = specsData?.specs ?? [];

	// Fetch all spec contents in parallel
	const specContents = useQueries({
		queries: specs.map((spec) => specContentQueryOptions(slug, spec.file)),
	});

	const isPending = task?.review_status === "pending";

	if (!task) {
		return <p className="text-sm text-muted-foreground">Task not found.</p>;
	}

	return (
		<div className="flex gap-6 h-[calc(100vh-120px)]">
			{/* Left column — task metadata (sticky) */}
			<div className="w-[280px] shrink-0 space-y-4 overflow-y-auto">
				<TaskInfoCard task={task} validationData={validationData ?? undefined} />

				{/* Next Steps (if active) */}
				{task.status !== "completed" && task.next_steps && task.next_steps.length > 0 && (
					<div className="rounded-lg border bg-card p-4 space-y-2">
						<h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Next Steps</h3>
						<div className="space-y-1">
							{task.next_steps.map((step, i) => (
								<div key={`step-${i}`} className="flex items-start gap-2">
									<Checkbox checked={step.done} className="mt-0.5" />
									<span className={`text-xs leading-relaxed ${step.done ? "line-through text-muted-foreground" : ""}`}>
										{step.text}
									</span>
								</div>
							))}
						</div>
					</div>
				)}

				{/* Spec file list for review mode */}
				{isPending && (
					<div className="rounded-lg border bg-card p-4 space-y-2">
						<h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Review</h3>
						{specs.map((spec) => (
							<button
								type="button"
								key={spec.file}
								onClick={() => setReviewFile(reviewFile === spec.file ? null : spec.file)}
								className={`w-full rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent ${
									reviewFile === spec.file ? "bg-accent font-medium" : ""
								}`}
								style={{ borderLeft: `3px solid ${SPEC_FILE_COLORS[spec.file] ?? "#44403c"}` }}
							>
								<div className="flex items-center gap-1.5">
									<MessageSquareText className="size-3 shrink-0 text-muted-foreground" />
									{spec.file.replace(".md", "")}
								</div>
							</button>
						))}
					</div>
				)}
			</div>

			{/* Right column — spec sections */}
			<div className="flex-1 min-w-0 overflow-y-auto space-y-3 pb-8">
				{reviewFile && isPending ? (
					<ReviewPanel
						slug={slug}
						reviewStatus={task.review_status ?? "pending"}
						specContent={specContents.find(
							(_, i) => specs[i]?.file === reviewFile
						)?.data?.content ?? ""}
						currentFile={reviewFile}
					/>
				) : (
					<>
						{specs.map((spec, i) => {
							const content = specContents[i]?.data?.content ?? "";
							if (!content) return null;
							return (
								<SectionCard
									key={spec.file}
									title={spec.file}
									content={content}
									defaultOpen={spec.file === "session.md"}
								/>
							);
						})}
						{specs.length === 0 && (
							<div className="flex h-40 items-center justify-center rounded-lg border border-dashed">
								<p className="text-sm text-muted-foreground">No spec files found.</p>
							</div>
						)}
					</>
				)}
			</div>
		</div>
	);
}

function TaskInfoCard({ task, validationData }: { task: TaskDetail; validationData?: ValidationReport }) {
	const isCompleted = task.status === "completed";

	return (
		<div className="rounded-lg border bg-card p-4 space-y-3">
			{/* Header */}
			<div className="flex items-center gap-2">
				{isCompleted ? (
					<CircleCheck className="size-5 shrink-0" style={{ color: "#2d8b7a" }} />
				) : (
					<CircleDot className="size-5 shrink-0" style={{ color: "#40513b" }} />
				)}
				<h2 className="text-base font-semibold truncate">{task.slug}</h2>
			</div>

			{/* Badges */}
			<div className="flex flex-wrap gap-1.5">
				<Badge
					variant="outline"
					style={{
						borderColor: isCompleted ? "rgba(45,139,122,0.4)" : "rgba(64,81,59,0.4)",
						color: isCompleted ? "#2d8b7a" : "#40513b",
					}}
				>
					{isCompleted ? "completed" : "active"}
				</Badge>
				{task.size && (
					<Tooltip>
						<TooltipTrigger asChild>
							<Badge variant="outline" className="cursor-help">{task.size}</Badge>
						</TooltipTrigger>
						<TooltipContent>{SIZE_LABELS[task.size] ?? `Size: ${task.size}`}</TooltipContent>
					</Tooltip>
				)}
				{task.spec_type && (
					<Badge variant="outline">{task.spec_type}</Badge>
				)}
				{task.review_status && (
					<Badge
						variant="outline"
						style={{
							borderColor:
								task.review_status === "approved" ? "rgba(45,139,122,0.4)"
								: task.review_status === "changes_requested" ? "rgba(230,126,34,0.4)"
								: "rgba(107,114,128,0.3)",
							color:
								task.review_status === "approved" ? "#2d8b7a"
								: task.review_status === "changes_requested" ? "#e67e22"
								: "#6b7280",
						}}
					>
						{task.review_status}
					</Badge>
				)}
				{validationData && <ValidationBadge report={validationData} />}
			</div>

			<Separator />

			{/* Dates */}
			<div className="space-y-1.5">
				{task.started_at && (
					<div className="flex items-center gap-2 text-xs text-muted-foreground">
						<Calendar className="size-3 shrink-0" />
						<span>Started: {formatDate(task.started_at)}</span>
					</div>
				)}
				{task.completed_at && (
					<div className="flex items-center gap-2 text-xs" style={{ color: "#2d8b7a" }}>
						<CircleCheck className="size-3 shrink-0" />
						<span>Completed: {formatDate(task.completed_at)}</span>
					</div>
				)}
			</div>

			{/* Focus */}
			{task.focus && (
				<>
					<Separator />
					<div>
						<p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">Focus</p>
						<p className="text-xs leading-relaxed">{task.focus}</p>
					</div>
				</>
			)}

			{/* Project */}
			{task.project_name && (
				<p className="text-[10px] text-muted-foreground">{task.project_name}</p>
			)}
		</div>
	);
}

function ValidationBadge({ report }: { report: ValidationReport }) {
	const passed = report.checks.filter((c) => c.status === "pass").length;
	const failed = report.checks.filter((c) => c.status === "fail").length;
	const color = failed > 0 ? "#c0392b" : "#2d8b7a";
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Badge variant="outline" className="text-xs cursor-help" style={{ borderColor: color, color }}>
					{passed}P / {failed}F
				</Badge>
			</TooltipTrigger>
			<TooltipContent>
				<p>Validation: {passed} passed, {failed} failed</p>
			</TooltipContent>
		</Tooltip>
	);
}

function formatDate(iso: string): string {
	try {
		const d = new Date(iso);
		return d.toLocaleDateString("ja-JP", { year: "numeric", month: "short", day: "numeric" });
	} catch {
		return iso;
	}
}
