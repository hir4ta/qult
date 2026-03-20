import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Calendar, CheckCircle2, CircleCheck, CircleDot } from "@animated-color-icons/lucide-react";
import { useState } from "react";
import { CoverageHeatmap } from "@/components/coverage-heatmap";
import { ReviewPanel } from "@/components/review/ReviewPanel";
import { SectionCard } from "@/components/section-card";
import { TraceabilityMatrix } from "@/components/traceability";
import { WaveTimeline } from "@/components/wave-timeline";
import { ButlerEmpty } from "@/components/butler-empty";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
	completeTask,
	fileApprovalsQueryOptions,
	setFileApproval,
	specContentQueryOptions,
	specsQueryOptions,
	tasksQueryOptions,
	validationQueryOptions,
} from "@/lib/api";
import { useI18n, dateLocale } from "@/lib/i18n";
import type { TranslationKey } from "@/lib/i18n";
import type { TaskDetail, ValidationReport } from "@/lib/types";

export const Route = createFileRoute("/tasks/$slug")({
	component: TaskDetailPage,
});

const SIZE_LABEL_KEYS: Record<string, TranslationKey> = {
	S: "size.S",
	M: "size.M",
	L: "size.L",
	XL: "size.XL",
	D: "size.D",
};

function TaskDetailPage() {
	const { t } = useI18n();
	const { slug } = Route.useParams();
	const queryClient = useQueryClient();
	const { data: tasksData } = useQuery(tasksQueryOptions());
	const { data: specsData } = useQuery(specsQueryOptions(slug));
	const { data: validationData } = useQuery(validationQueryOptions(slug));
	const { data: approvalsData } = useQuery(fileApprovalsQueryOptions(slug));
	const [confirmComplete, setConfirmComplete] = useState(false);
	const [reviewModeFiles, setReviewModeFiles] = useState<Set<string>>(new Set());

	const task = tasksData?.tasks.find((t) => t.slug === slug);
	const specs = specsData?.specs ?? [];
	const approvals = approvalsData?.approvals ?? {};

	// Fetch all spec contents in parallel
	const specContents = useQueries({
		queries: specs.map((spec) => specContentQueryOptions(slug, spec.file)),
	});

	const completeMutation = useMutation({
		mutationFn: () => completeTask(slug),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["tasks"] });
			setConfirmComplete(false);
		},
	});

	const approveMutation = useMutation({
		mutationFn: ({ file, approved }: { file: string; approved: boolean }) =>
			setFileApproval(slug, file, approved),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["file-approvals", slug] });
			queryClient.invalidateQueries({ queryKey: ["tasks"] });
		},
	});

	const needsReview = ["M", "L", "XL"].includes(task?.size ?? "");
	const isPending = needsReview && task?.review_status !== "approved";
	const isActive = task?.status !== "completed" && task?.status !== "done" && task?.status !== "cancelled";
	const canComplete =
		isActive &&
		(task?.review_status === "approved" || !["M", "L", "XL"].includes(task?.size ?? ""));

	const toggleReviewMode = (file: string) => {
		setReviewModeFiles((prev) => {
			const next = new Set(prev);
			if (next.has(file)) next.delete(file);
			else next.add(file);
			return next;
		});
	};

	if (!task) {
		return <p className="text-sm text-muted-foreground">{t("task.notFound")}</p>;
	}

	return (
		<div className="flex gap-6 h-[calc(100vh-120px)]">
			{/* Left column — task metadata (sticky) */}
			<div className="w-[280px] shrink-0 space-y-4 overflow-y-auto pt-1">
				<TaskInfoCard task={task} validationData={validationData ?? undefined} />

				{/* Complete button */}
				{canComplete && (
					<div className="rounded-lg border bg-card p-4">
						{!confirmComplete ? (
							<Button
								size="sm"
								variant="brutalist"
								className="w-full gap-1.5 text-xs"
								onClick={() => setConfirmComplete(true)}
							>
								<CheckCircle2 className="size-3.5" />
								{t("task.completeTask")}
							</Button>
						) : (
							<div className="space-y-2">
								<p className="text-xs text-muted-foreground">{t("task.confirmComplete")}</p>
								<div className="flex gap-2">
									<Button
										size="sm"
										className="flex-1 text-xs"
										onClick={() => completeMutation.mutate()}
										disabled={completeMutation.isPending}
									>
										{completeMutation.isPending ? "..." : t("task.confirm")}
									</Button>
									<Button
										size="sm"
										variant="outline"
										className="flex-1 text-xs"
										onClick={() => setConfirmComplete(false)}
									>
										{t("task.cancel")}
									</Button>
								</div>
								{completeMutation.isError && (
									<p className="text-xs text-red-500">{completeMutation.error.message}</p>
								)}
							</div>
						)}
					</div>
				)}
			</div>

			{/* Right column — spec sections */}
			<div className="flex-1 min-w-0 overflow-y-auto space-y-3 pt-1 pb-8">
				{/* Wave timeline */}
				{task.waves && task.waves.length > 0 && (
					<WaveTimeline waves={task.waves} />
				)}
				{/* Traceability + Coverage */}
				{(() => {
					const contentMap: Record<string, string> = {};
					for (let i = 0; i < specs.length; i++) {
						const c = specContents[i]?.data?.content;
						if (c) contentMap[specs[i]!.file] = c;
					}
					return Object.keys(contentMap).length > 0 ? <TraceabilityMatrix specContents={contentMap} /> : null;
				})()}
				{validationData && validationData.checks.length > 0 && (
					<CoverageHeatmap checks={validationData.checks} />
				)}

				{specs.map((spec, i) => {
					const content = specContents[i]?.data?.content ?? "";
					if (!content) return null;
					const showApprove = isActive && needsReview && spec.file !== "session.md";
					const canReview = isActive && needsReview && spec.file !== "session.md";
					const isReviewMode = canReview && reviewModeFiles.has(spec.file);
					return (
						<SectionCard
							key={spec.file}
							title={spec.file}
							content={content}
							defaultOpen={spec.file === "session.md"}
							slug={slug}
							approved={showApprove ? approvals[spec.file] === true : undefined}
							onApprove={
								showApprove
									? (file, approved) => approveMutation.mutate({ file, approved })
									: undefined
							}
							canReview={canReview}
							isReviewMode={isReviewMode}
							onToggleReviewMode={() => toggleReviewMode(spec.file)}
							reviewPanel={isReviewMode ? (
								<ReviewPanel
									slug={slug}
									reviewStatus={task?.review_status ?? "pending"}
									specContent={content}
									currentFile={spec.file}
								/>
							) : undefined}
						/>
					);
				})}
				{specs.length === 0 && (
					<ButlerEmpty scene="empty-tray" messageKey="empty.noSpecs" />
				)}
			</div>
		</div>
	);
}

function TaskInfoCard({
	task,
	validationData,
}: {
	task: TaskDetail;
	validationData?: ValidationReport;
}) {
	const { t, locale } = useI18n();
	const isCompleted = task.status === "completed" || task.status === "done" || task.status === "cancelled";

	return (
		<div className="rounded-lg border bg-card p-4 space-y-3">
			{/* Header */}
			<div className="flex items-center gap-2">
				{isCompleted ? (
					<CircleCheck className="size-5 shrink-0" style={{ color: "#2d8b7a" }} />
				) : (
					<CircleDot className="size-5 shrink-0" style={{ color: "#40513b" }} />
				)}
				<h2 className="text-base font-semibold font-mono truncate">{task.slug}</h2>
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
							<Badge variant="outline" className="cursor-help">
								{task.size}
							</Badge>
						</TooltipTrigger>
						<TooltipContent>{SIZE_LABEL_KEYS[task.size] ? t(SIZE_LABEL_KEYS[task.size]!) : task.size}</TooltipContent>
					</Tooltip>
				)}
				{task.spec_type && <Badge variant="outline">{task.spec_type}</Badge>}
				{task.review_status && (
					<Badge
						variant="outline"
						style={{
							borderColor:
								task.review_status === "approved"
									? "rgba(45,139,122,0.4)"
									: task.review_status === "changes_requested"
										? "rgba(230,126,34,0.4)"
										: "rgba(107,114,128,0.3)",
							color:
								task.review_status === "approved"
									? "#2d8b7a"
									: task.review_status === "changes_requested"
										? "#e67e22"
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
						<span>{t("task.started")}: {formatDate(task.started_at, locale)}</span>
					</div>
				)}
				{task.completed_at && (
					<div className="flex items-center gap-2 text-xs" style={{ color: "#2d8b7a" }}>
						<CircleCheck className="size-3 shrink-0" />
						<span>{t("task.completed")}: {formatDate(task.completed_at, locale)}</span>
					</div>
				)}
			</div>

			{/* Focus */}
			{task.focus && (
				<>
					<Separator />
					<div>
						<p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
							{t("task.focus")}
						</p>
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
	const { t } = useI18n();
	const passed = report.checks.filter((c) => c.status === "pass").length;
	const failed = report.checks.filter((c) => c.status === "fail").length;
	const color = failed > 0 ? "#c0392b" : "#2d8b7a";
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Badge
					variant="outline"
					className="text-xs cursor-help"
					style={{ borderColor: color, color }}
				>
					{passed}P / {failed}F
				</Badge>
			</TooltipTrigger>
			<TooltipContent>
				<p>
					{t("task.validation")}: {passed} {t("task.passed")}, {failed} {t("task.failed")}
				</p>
			</TooltipContent>
		</Tooltip>
	);
}

function formatDate(iso: string, locale: "en" | "ja" = "en"): string {
	try {
		const d = new Date(iso);
		return d.toLocaleDateString(dateLocale(locale), { year: "numeric", month: "short", day: "numeric" });
	} catch {
		return iso;
	}
}
