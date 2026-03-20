import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Brain, CheckCircle2, Clock, Zap } from "lucide-react";
import { useState } from "react";
import {
	Pagination,
	PaginationContent,
	PaginationItem,
	PaginationLink,
	PaginationNext,
	PaginationPrevious,
} from "@/components/ui/pagination";
import { Card, CardContent } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
	epicsQueryOptions,
	healthQueryOptions,
	tasksQueryOptions,
} from "@/lib/api";
import type { MemoryHealthStats } from "@/lib/types";
import { useI18n } from "@/lib/i18n";
import { StatCard } from "@/components/overview/stat-card";
import { TaskCard } from "@/components/overview/task-card";
import { EpicProgressCard } from "@/components/overview/epic-card";

export const Route = createFileRoute("/")({
	component: OverviewPage,
});

const ITEMS_PER_PAGE = 9;

function OverviewPage() {
	const { t } = useI18n();
	const [taskPage, setTaskPage] = useState(1);
	const { data: tasksData, isLoading: tasksLoading } = useQuery(tasksQueryOptions());
	const { data: healthData } = useQuery(healthQueryOptions());
	const { data: epicsData } = useQuery(epicsQueryOptions());
	// decisionsData removed — recent decisions section removed per user request

	const tasks = [...(tasksData?.tasks ?? [])].sort((a, b) => {
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
						<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" style={{ minHeight: "calc(140px * 3 + 16px * 2)" }}>
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

			{/* Epics */}
			<EpicProgressCard epics={epicsData?.epics?.filter((e) => e.status !== "completed")} />
		</div>
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

function VitalityBar({ dist }: { dist: [number, number, number, number, number] }) {
	const { t } = useI18n();
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
				<p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
					{t("overview.vitality")}
				</p>
				<div className="flex gap-2 mt-1 text-[10px]">
					{["0-20", "21-40", "41-60", "61-80", "81-100"].map((label, i) => (
						<span key={label} className="tabular-nums">{label}: {dist[i]}</span>
					))}
				</div>
			</TooltipContent>
		</Tooltip>
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
					<span className="text-xs text-muted-foreground tabular-nums px-2">
						{page} / {totalPages}
					</span>
				</PaginationItem>
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
