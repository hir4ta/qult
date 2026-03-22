import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, Outlet, useParams, useSearch } from "@tanstack/react-router";
import { ChevronDown, CircleCheck, CircleDashed, CirclePause, CircleX } from "@animated-color-icons/lucide-react";
import { useState } from "react";
import { StatusBadge } from "@/components/status-badge";
import { ButlerEmpty } from "@/components/butler-empty";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { tasksQueryOptions } from "@/lib/api";
import type { TaskDetail, WaveInfo } from "@/lib/types";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { formatDate } from "@/lib/format";

export const Route = createFileRoute("/tasks")({
	component: TasksLayout,
});

const SHIMMER_COLORS = [
	{ r: 45, g: 139, b: 122 },
	{ r: 98, g: 129, b: 65 },
	{ r: 123, g: 107, b: 141 },
	{ r: 230, g: 126, b: 34 },
	{ r: 64, g: 81, b: 59 },
];

function TasksLayout() {
	const { t } = useI18n();
	const search = useSearch({ strict: false }) as { project?: string };
	const { data } = useQuery(tasksQueryOptions(search.project));
	const allTasks = data?.tasks ?? [];
	const { slug: selectedSlug } = useParams({ strict: false }) as { slug?: string };
	const [statusFilter, setStatusFilter] = useState<string>("all");
	const [sizeFilter, setSizeFilter] = useState<Set<string>>(new Set());
	const terminalStatuses = new Set(["completed", "done", "cancelled"]);
	const navigate = Route.useNavigate();

	// Auto-navigate to active spec if no slug selected
	const activeTask = allTasks.find((t) => !terminalStatuses.has(t.status ?? ""));
	if (!selectedSlug && activeTask) {
		const activeProjectId = (activeTask as Record<string, unknown>).project_id as string | undefined;
		navigate({ to: "/tasks/$slug", params: { slug: activeTask.slug }, search: activeProjectId ? { project: activeProjectId } : {} });
	}

	const tasks = allTasks
		.filter((task) => {
			if (statusFilter === "active" && terminalStatuses.has(task.status ?? "")) return false;
			if (statusFilter === "review" && task.review_status !== "pending") return false;
			if (statusFilter === "done" && !terminalStatuses.has(task.status ?? "")) return false;
			if (sizeFilter.size > 0 && !sizeFilter.has(task.size ?? "")) return false;
			return true;
		})
		.sort((a, b) => {
			// Active tasks first, then by started_at descending (newest first)
			const aTerminal = terminalStatuses.has(a.status ?? "") ? 1 : 0;
			const bTerminal = terminalStatuses.has(b.status ?? "") ? 1 : 0;
			if (aTerminal !== bTerminal) return aTerminal - bTerminal;
			return (b.started_at ?? "").localeCompare(a.started_at ?? "");
		});
	const toggleSize = (size: string) => setSizeFilter((prev) => { const n = new Set(prev); if (n.has(size)) n.delete(size); else n.add(size); return n; });

	return (
		<div className="flex gap-6 items-start">
			<div className="w-72 shrink-0 space-y-2 overflow-y-auto max-h-[calc(100vh-100px)] px-1 pt-1">
				{/* Status + size filter */}
				<div className="flex flex-wrap gap-1 pb-1">
					{(["all", "active", "done"] as const).map((s) => (
						<button key={s} type="button" onClick={() => setStatusFilter(s)}
							className={cn("rounded-lg px-2 py-0.5 text-[10px] font-medium transition-colors border",
								statusFilter === s ? "bg-card text-foreground border-border" : "bg-card text-muted-foreground border-border/40 hover:text-foreground"
							)}
						>{t(`filter.${s}` as never)}</button>
					))}
				</div>
				<div className="flex flex-wrap gap-1 pb-1">
					{["S", "M", "L"].map((s) => (
						<button key={s} type="button" onClick={() => toggleSize(s)}
							className={cn("rounded-full px-1.5 py-0 text-[10px] font-medium transition-colors border",
								sizeFilter.has(s) ? "bg-card text-foreground border-border" : "bg-card text-muted-foreground border-border/40 hover:text-foreground"
							)}
						>{s}</button>
					))}
				</div>
				{tasks.map((task, i) => (
					<TaskAccordionCard
						key={task.slug}
						task={task}
						isSelected={task.slug === selectedSlug}
						colorIndex={i}
					/>
				))}

				{tasks.length === 0 && allTasks.length === 0 && <ButlerEmpty scene="empty-tray" messageKey="empty.noTasks" />}
			</div>
			<div className="min-w-0 flex-1">
				<Outlet />
			</div>
		</div>
	);
}

function WavesLabel({ waves }: { waves: WaveInfo[] }) {
	const { t } = useI18n();
	const done = waves.filter((w) => w.checked === w.total && w.total > 0).length;
	return (
		<span>
			{t("tasks.waves")} ({done}/{waves.length})
		</span>
	);
}

function TaskAccordionCard({
	task,
	isSelected,
	colorIndex,
}: {
	task: TaskDetail;
	isSelected: boolean;
	colorIndex: number;
}) {
	const projectId = (task as Record<string, unknown>).project_id as string | undefined;
	const [expanded, setExpanded] = useState(false);
	const progress = (task.total ?? 0) > 0 ? ((task.completed ?? 0) / (task.total ?? 1)) * 100 : 0;
	const isCompleted = task.status === "completed" || task.status === "done" || task.status === "cancelled";
	const c = SHIMMER_COLORS[colorIndex % SHIMMER_COLORS.length]!;

	return (
		<div
			className={cn(
				"rounded-lg border bg-card text-card-foreground transition-colors overflow-hidden",
				isSelected && "border-2",
				isCompleted && "opacity-60",
			)}
			style={isSelected ? { borderColor: "var(--color-brand-dark)" } : undefined}
		>
			{/* Card header — clickable to navigate */}
		<Link to="/tasks/$slug" params={{ slug: task.slug }} search={projectId ? { project: projectId } : {}} className="block p-3 pb-2 space-y-1.5">
			{/* Row 1: Spec name */}
			<div className="flex items-center gap-2 min-w-0">
				<TaskStatusIcon status={task.status ?? "pending"} />
				<span className="text-sm font-medium font-mono truncate">{task.slug}</span>
			</div>

			{/* Row 2: Project name, date */}
			<p className="text-[10px] text-muted-foreground truncate">
				{task.project_name}{task.project_name && task.started_at ? " \u00b7 " : ""}{task.started_at ? formatDate(task.started_at) : ""}
			</p>

			{/* Row 3: Status + Size badges */}
			<div className="flex items-center gap-1.5 flex-wrap">
				<StatusBadge status={task.status ?? "pending"} />
				{task.size && (
					<Badge variant="outline" className="text-[10px] px-1.5 py-0 rounded-full">
						{task.size}
					</Badge>
				)}
				{task.spec_type && task.spec_type !== "feature" && (
					<Badge variant="outline" className="text-[10px] px-1.5 py-0" style={{ borderColor: "rgba(98,129,65,0.4)", color: "#628141" }}>
						{task.spec_type}
					</Badge>
				)}
			</div>

			{/* Row 4: Progress bar */}
			<div className="flex items-center gap-2">
				<Progress value={progress} className="h-1 flex-1 [&>div]:bg-[#e67e22]" />
				<span className="text-[10px] tabular-nums text-muted-foreground">
					{task.completed}/{task.total}
				</span>
			</div>
		</Link>

		{/* Compact info */}
		<div className="px-3 pb-3 space-y-1.5">
			{task.focus && (
				<p className="text-[11px] text-muted-foreground line-clamp-1">{task.focus}</p>
			)}

			</div>

			{/* Accordion toggle — Waves */}
			{task.waves && task.waves.length > 0 && !isCompleted && (
				<>
					<button
						type="button"
						onClick={(e) => {
							e.preventDefault();
							setExpanded(!expanded);
						}}
						className="flex w-full items-center justify-between border-t border-border/50 px-3 py-1.5 text-[10px] text-muted-foreground hover:bg-accent/50 transition-colors"
					>
						<WavesLabel waves={task.waves} />
						<ChevronDown className={cn("size-3 transition-transform", expanded && "rotate-180")} />
					</button>

					{expanded && (
						<div className="px-3 pb-3 space-y-1">
							{task.waves.map((wave) => {
								const waveDone = wave.total > 0 && wave.checked === wave.total;
								const waveProgress = wave.total > 0 ? (wave.checked / wave.total) * 100 : 0;
								return (
									<div
										key={`wave-${wave.key}`}
										className={cn(
											"relative rounded-md px-2 py-1.5 transition-colors",
											wave.isCurrent && "overflow-hidden",
										)}
									>
										{wave.isCurrent && (
											<div
												className="absolute inset-0 animate-shimmer"
												style={{
													background: `linear-gradient(90deg, rgba(${c.r},${c.g},${c.b},0.03) 0%, rgba(${c.r},${c.g},${c.b},0.10) 50%, rgba(${c.r},${c.g},${c.b},0.03) 100%)`,
													backgroundSize: "200% 100%",
												}}
											/>
										)}
										<div className="relative flex items-center justify-between mb-0.5">
											<span
												className={cn(
													"text-[10px] font-medium",
													waveDone && "text-muted-foreground",
													wave.isCurrent && "font-semibold",
												)}
											>
												{wave.key === "closing" ? "Closing" : `Wave ${wave.key}`}: {wave.title}
											</span>
											<span className="text-[10px] tabular-nums text-muted-foreground">
												{wave.checked}/{wave.total}
											</span>
										</div>
										<Progress value={waveProgress} className={cn("relative h-1", waveDone ? "[&>div]:bg-[#2d8b7a]" : "[&>div]:bg-[#e67e22]")} />
									</div>
								);
							})}
						</div>
					)}
				</>
			)}
		</div>
	);
}

/** Brand-colored status icon for task cards. */
function TaskStatusIcon({ status }: { status: string }) {
	switch (status) {
		case "done":
		case "completed":
			return <CircleCheck className="size-3.5 shrink-0" style={{ color: "#2d8b7a" }} />;
		case "review":
			return <CircleDashed className="size-3.5 shrink-0" style={{ color: "#e67e22" }} />;
		case "deferred":
			return <CirclePause className="size-3.5 shrink-0" style={{ color: "#7b6b8d" }} />;
		case "cancelled":
			return <CircleX className="size-3.5 shrink-0" style={{ color: "#c0392b" }} />;
		case "pending":
			return <CircleDashed className="size-3.5 shrink-0" style={{ color: "#9ca3af" }} />;
		default: // in-progress, active
			return <CircleDashed className="size-3.5 shrink-0 animate-spin" style={{ color: "#628141", animationDuration: "1.5s" }} />;
	}
}
