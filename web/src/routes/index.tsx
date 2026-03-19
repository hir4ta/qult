import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Brain, CheckCircle2, CircleCheck, CircleDot, Clock, Zap } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
	Pagination,
	PaginationContent,
	PaginationItem,
	PaginationLink,
	PaginationNext,
	PaginationPrevious,
} from "@/components/ui/pagination";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
	decisionsQueryOptions,
	epicsQueryOptions,
	healthQueryOptions,
	tasksQueryOptions,
} from "@/lib/api";
import type { DecisionEntry, EpicSummary, MemoryHealthStats, TaskDetail } from "@/lib/types";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/")({
	component: OverviewPage,
});

// Shimmer colors from brand palette — each task gets a unique color.
const SHIMMER_COLORS = [
	{ r: 45, g: 139, b: 122 }, // brand-pattern (teal)
	{ r: 98, g: 129, b: 65 }, // brand-decision (olive)
	{ r: 123, g: 107, b: 141 }, // brand-purple
	{ r: 230, g: 126, b: 34 }, // brand-rule (orange)
	{ r: 64, g: 81, b: 59 }, // brand-session (dark green)
];

function shimmerGradient(index: number) {
	const c = SHIMMER_COLORS[index % SHIMMER_COLORS.length]!;
	return `linear-gradient(90deg, rgba(${c.r},${c.g},${c.b},0.04) 0%, rgba(${c.r},${c.g},${c.b},0.12) 50%, rgba(${c.r},${c.g},${c.b},0.04) 100%)`;
}

const SIZE_LABEL_KEYS: Record<string, TranslationKey> = {
	S: "size.S",
	M: "size.M",
	L: "size.L",
	XL: "size.XL",
	D: "size.D",
};

const ITEMS_PER_PAGE = 9;

function OverviewPage() {
	const { t } = useI18n();
	const [taskPage, setTaskPage] = useState(1);
	const { data: tasksData, isLoading: tasksLoading } = useQuery(tasksQueryOptions());
	const { data: healthData } = useQuery(healthQueryOptions());
	const { data: epicsData } = useQuery(epicsQueryOptions());
	const { data: decisionsData } = useQuery(decisionsQueryOptions(5));

	const tasks = [...(tasksData?.tasks ?? [])].sort((a, b) => {
		// Newest first by started_at (descending).
		const aTime = a.started_at ?? "";
		const bTime = b.started_at ?? "";
		return bTime.localeCompare(aTime);
	});

	return (
		<div className="space-y-8">
			{/* Stats row + Health */}
			<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_1fr_auto]">
				<StatCard
					label={t("overview.totalTasks")}
					value={tasks.length}
					icon={<Zap className="size-4" style={{ color: "#e67e22" }} />}
					loading={tasksLoading}
				/>
				<StatCard
					label={t("overview.active")}
					value={tasks.filter((t) => {
						const s = t.status;
						return s !== "completed" && s !== "done" && s !== "cancelled";
					}).length}
					icon={<Clock className="size-4" style={{ color: "#40513b" }} />}
					loading={tasksLoading}
				/>
				<StatCard
					label={t("overview.completed")}
					value={tasks.filter((t) => t.status === "completed" || t.status === "done").length}
					icon={<CheckCircle2 className="size-4" style={{ color: "#2d8b7a" }} />}
					loading={tasksLoading}
				/>
				<StatCard
					label={t("overview.knowledge")}
					value={healthData?.total ?? 0}
					icon={<Brain className="size-4" style={{ color: "#628141" }} />}
				/>
				<HealthCard stats={healthData} />
			</div>

			{/* Task cards */}
			{tasks.length > 0 && (() => {
				const totalPages = Math.ceil(tasks.length / ITEMS_PER_PAGE);
				const paged = tasks.slice((taskPage - 1) * ITEMS_PER_PAGE, taskPage * ITEMS_PER_PAGE);
				return (
					<section className="space-y-3">
						<h2
							className="text-sm font-semibold uppercase tracking-wider text-muted-foreground"
							style={{ fontFamily: "var(--font-display)" }}
						>
							{t("overview.tasks")}
						</h2>
						<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
							{paged.map((task, i) => (
								<TaskCard
									key={task.slug}
									task={task}
									colorIndex={(taskPage - 1) * ITEMS_PER_PAGE + i}
								/>
							))}
						</div>
						{totalPages > 1 && (
							<SimplePagination page={taskPage} totalPages={totalPages} onPageChange={setTaskPage} />
						)}
					</section>
				);
			})()}

			{/* Bottom row: Epics + Decisions */}
			<div className="grid gap-6 lg:grid-cols-2">
				<EpicProgressCard epics={epicsData?.epics?.filter((e) => e.status !== "completed")} />
				<RecentDecisionsCard decisions={decisionsData?.decisions} />
			</div>
		</div>
	);
}

function StatCard({
	label,
	value,
	icon,
	loading,
}: {
	label: string;
	value: number;
	icon: React.ReactNode;
	loading?: boolean;
}) {
	return (
		<Card className="border-stone-200 dark:border-stone-700">
			<CardContent className="flex items-center gap-4 py-4">
				<div className="flex size-10 items-center justify-center rounded-lg bg-accent/80">
					{icon}
				</div>
				<div>
					{loading ? (
						<Skeleton className="h-7 w-12" />
					) : (
						<p className="text-2xl font-bold" style={{ fontFamily: "var(--font-display)" }}>
							{value}
						</p>
					)}
					<p className="text-xs text-muted-foreground">{label}</p>
				</div>
			</CardContent>
		</Card>
	);
}

function TaskCard({
	task,
	colorIndex,
}: {
	task: TaskDetail;
	colorIndex: number;
}) {
	const { t } = useI18n();
	const progress = (task.total ?? 0) > 0 ? ((task.completed ?? 0) / (task.total ?? 1)) * 100 : 0;
	const isCompleted = task.status === "completed" || task.status === "done" || task.status === "cancelled";
	const currentWave = task.waves?.find((w) => w.isCurrent);
	const c = SHIMMER_COLORS[colorIndex % SHIMMER_COLORS.length]!;
	const accentColor = `rgb(${c.r},${c.g},${c.b})`;

	return (
		<Link to="/tasks/$slug" params={{ slug: task.slug }} className="block">
			<Card
				className={cn(
					"h-[140px] !gap-0 !py-0 border-stone-200 transition-[border-color,transform] duration-200 hover:border-stone-300 hover:-translate-y-0.5 dark:border-stone-700 dark:hover:border-stone-600",
					isCompleted && "opacity-60",
				)}
			>
				<CardContent className="flex-1 flex flex-col p-4 gap-1.5">
					{/* Header */}
					<div className="flex items-center justify-between gap-2">
						<div className="flex items-center gap-2 min-w-0">
							{isCompleted ? (
								<CircleCheck className="size-4 shrink-0" style={{ color: "#2d8b7a" }} />
							) : (
								<CircleDot className="size-4 shrink-0" style={{ color: accentColor }} />
							)}
							<span className="text-sm font-semibold truncate">{task.slug}</span>
						</div>
						<div className="flex shrink-0 gap-1.5">
							{task.size && (
								<Tooltip>
									<TooltipTrigger asChild>
										<Badge
											variant="outline"
											className="text-[10px] px-1.5 py-0 rounded-full cursor-help"
										>
											{task.size}
										</Badge>
									</TooltipTrigger>
									<TooltipContent>{SIZE_LABEL_KEYS[task.size] ? t(SIZE_LABEL_KEYS[task.size]!) : task.size}</TooltipContent>
								</Tooltip>
							)}
						</div>
					</div>

					{/* Current wave + shimmer */}
					<div className="flex-1 flex flex-col justify-center gap-1">
						{task.project_name && (
							<p className="text-[10px] font-medium text-muted-foreground">
								{task.project_name}
							</p>
						)}
						{currentWave && !isCompleted && (
							<div className="relative overflow-hidden rounded-md px-2 py-1">
								<div
									className="absolute inset-0 animate-shimmer"
									style={{ background: shimmerGradient(colorIndex), backgroundSize: "200% 100%" }}
								/>
								<p className="relative text-[11px] line-clamp-1" style={{ color: accentColor }}>
									→ {currentWave.key === "closing" ? "Closing" : `Wave ${currentWave.key}`}: {currentWave.title} ({currentWave.checked}/{currentWave.total})
								</p>
							</div>
						)}
					</div>

					{/* Progress */}
					<div className="flex items-center gap-2.5">
						<Progress value={progress} className="flex-1" />
						<span className="text-[11px] tabular-nums text-muted-foreground">
							{task.completed}/{task.total}
						</span>
					</div>
				</CardContent>
			</Card>
		</Link>
	);
}

function HealthCard({ stats }: { stats?: MemoryHealthStats }) {
	const { t } = useI18n();
	if (!stats) return null;
	return (
		<Card className="border-stone-200 dark:border-stone-700 min-w-[220px]">
			<CardContent className="flex items-center gap-4 py-4">
				<div className="flex flex-col gap-2 flex-1">
					<p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
						{t("overview.memoryHealth")}
					</p>
					<div className="flex items-center gap-3">
						<Tooltip>
							<TooltipTrigger asChild>
								<span
									className="text-sm tabular-nums font-medium cursor-help"
									style={{ color: (stats.stale_count ?? 0) > 0 ? "#e67e22" : undefined }}
								>
									{stats.stale_count ?? 0} <span className="text-[10px] text-muted-foreground">{t("overview.stale")}</span>
								</span>
							</TooltipTrigger>
							<TooltipContent>{t("overview.staleHint")}</TooltipContent>
						</Tooltip>
						<Tooltip>
							<TooltipTrigger asChild>
								<span
									className="text-sm tabular-nums font-medium cursor-help"
									style={{ color: (stats.conflict_count ?? 0) > 0 ? "#c0392b" : undefined }}
								>
									{stats.conflict_count ?? 0} <span className="text-[10px] text-muted-foreground">{t("overview.conflicts")}</span>
								</span>
							</TooltipTrigger>
							<TooltipContent>{t("overview.conflictsHint")}</TooltipContent>
						</Tooltip>
					</div>
					{stats.vitality_dist && <VitalityBar dist={stats.vitality_dist} />}
				</div>
			</CardContent>
		</Card>
	);
}

function VitalityLabel() {
	const { t } = useI18n();
	return (
		<p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
			{t("overview.vitality")}
		</p>
	);
}

function VitalityBar({ dist }: { dist: [number, number, number, number, number] }) {
	const total = dist.reduce((a, b) => a + b, 0) || 1;
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<div className="flex h-2 w-full overflow-hidden rounded-full cursor-help">
					{dist.map((count, i) => (
						<div
							key={i}
							style={{
								width: `${(count / total) * 100}%`,
								backgroundColor: "#2d8b7a",
								opacity: 0.2 + (i / 4) * 0.8,
							}}
						/>
					))}
				</div>
			</TooltipTrigger>
			<TooltipContent>
				<VitalityLabel />
				<div className="flex gap-2 mt-1 text-[10px]">
					{["0-20", "21-40", "41-60", "61-80", "81-100"].map((label, i) => (
						<span key={label} className="tabular-nums">{label}: {dist[i]}</span>
					))}
				</div>
			</TooltipContent>
		</Tooltip>
	);
}

function EpicProgressCard({ epics }: { epics?: EpicSummary[] }) {
	const { t } = useI18n();
	if (!epics || epics.length === 0) return null;
	return (
		<Card className="border-stone-200 dark:border-stone-700">
			<CardHeader className="pb-3">
				<CardTitle className="text-sm font-semibold" style={{ fontFamily: "var(--font-display)" }}>
					{t("overview.epics")}
				</CardTitle>
			</CardHeader>
			<CardContent className="space-y-3">
				{epics.map((epic) => {
					const progress = epic.total > 0 ? (epic.completed / epic.total) * 100 : 0;
					return (
						<div key={epic.slug} className="space-y-1.5">
							<div className="flex items-center justify-between gap-2">
								<span className="text-sm font-medium truncate">{epic.name}</span>
								<span className="text-xs tabular-nums text-muted-foreground shrink-0">
									{epic.completed}/{epic.total}
								</span>
							</div>
							<Progress value={progress} className="" />
						</div>
					);
				})}
			</CardContent>
		</Card>
	);
}

function RecentDecisionsCard({ decisions }: { decisions?: DecisionEntry[] }) {
	const { t } = useI18n();
	if (!decisions || decisions.length === 0) return null;
	return (
		<Card className="border-stone-200 dark:border-stone-700">
			<CardHeader className="pb-3">
				<CardTitle className="text-sm font-semibold" style={{ fontFamily: "var(--font-display)" }}>
					{t("overview.recentDecisions")}
				</CardTitle>
			</CardHeader>
			<CardContent>
				<div className="space-y-3">
					{decisions.map((dec, i) => {
						// Parse JSON content to extract decision summary.
						let chosen: string | undefined;
						try {
							const parsed = JSON.parse(dec.content);
							chosen = parsed.decision;
						} catch { /* raw content */ }
						return (
							<div key={`${dec.id}-${i}`}>
								{i > 0 && <Separator className="mb-3" />}
								<div className="flex items-start gap-3">
									<div
										className="mt-1.5 size-2 shrink-0 rounded-full"
										style={{ backgroundColor: "#628141" }}
									/>
									<div className="min-w-0 flex-1">
										<p className="text-sm font-medium leading-snug">{dec.label}</p>
										{chosen && (
											<p className="mt-0.5 text-xs text-muted-foreground line-clamp-1">
												{chosen}
											</p>
										)}
									</div>
									{dec.project_name && (
										<Badge variant="outline" className="shrink-0 text-[10px] rounded-full">
											{dec.project_name}
										</Badge>
									)}
								</div>
							</div>
						);
					})}
				</div>
			</CardContent>
		</Card>
	);
}

function SimplePagination({
	page,
	totalPages,
	onPageChange,
}: {
	page: number;
	totalPages: number;
	onPageChange: (page: number) => void;
}) {
	return (
		<Pagination>
			<PaginationContent>
				<PaginationItem>
					<PaginationPrevious
						onClick={() => onPageChange(Math.max(1, page - 1))}
						aria-disabled={page <= 1}
						className={page <= 1 ? "pointer-events-none opacity-50" : "cursor-pointer"}
					/>
				</PaginationItem>
				{Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
					<PaginationItem key={p}>
						<PaginationLink
							isActive={p === page}
							onClick={() => onPageChange(p)}
							className="cursor-pointer"
						>
							{p}
						</PaginationLink>
					</PaginationItem>
				))}
				<PaginationItem>
					<PaginationNext
						onClick={() => onPageChange(Math.min(totalPages, page + 1))}
						aria-disabled={page >= totalPages}
						className={page >= totalPages ? "pointer-events-none opacity-50" : "cursor-pointer"}
					/>
				</PaginationItem>
			</PaginationContent>
		</Pagination>
	);
}
