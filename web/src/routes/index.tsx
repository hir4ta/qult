import { Badge } from "@/components/ui/badge";
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
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { AlertTriangle, Brain, CheckCircle2, Circle, CircleCheck, CircleDot, Clock, Zap } from "lucide-react";

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

const SIZE_LABELS: Record<string, string> = {
	S: "Small — 3 spec files",
	M: "Medium — 4-5 spec files",
	L: "Large — 7 spec files",
	XL: "Extra Large — 7 spec files",
	D: "Delta — 2 spec files",
};

function OverviewPage() {
	const { data: tasksData, isLoading: tasksLoading } = useQuery(tasksQueryOptions());
	const { data: healthData } = useQuery(healthQueryOptions());
	const { data: epicsData } = useQuery(epicsQueryOptions());
	const { data: decisionsData } = useQuery(decisionsQueryOptions(5));

	const tasks = tasksData?.tasks ?? [];
	const activeSlug = tasksData?.active ?? "";

	return (
		<div className="space-y-8">
			{/* Stats row */}
			<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
				<StatCard
					label="Total Tasks"
					value={tasks.length}
					icon={<Zap className="size-4" style={{ color: "#e67e22" }} />}
					loading={tasksLoading}
				/>
				<StatCard
					label="Active"
					value={tasks.filter((t) => t.status === "active").length}
					icon={<Clock className="size-4" style={{ color: "#40513b" }} />}
					loading={tasksLoading}
				/>
				<StatCard
					label="Completed"
					value={tasks.filter((t) => t.status === "completed").length}
					icon={<CheckCircle2 className="size-4" style={{ color: "#2d8b7a" }} />}
					loading={tasksLoading}
				/>
				<StatCard
					label="Knowledge"
					value={healthData?.total ?? 0}
					icon={<Brain className="size-4" style={{ color: "#628141" }} />}
				/>
			</div>

			{/* Task cards */}
			{tasks.length > 0 && (
				<section className="space-y-3">
					<h2
						className="text-sm font-semibold uppercase tracking-wider text-muted-foreground"
						style={{ fontFamily: "var(--font-display)" }}
					>
						Tasks
					</h2>
					<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
						{tasks.map((task, i) => (
							<TaskCard key={task.slug} task={task} isActive={task.slug === activeSlug} colorIndex={i} />
						))}
					</div>
				</section>
			)}

			{/* Bottom row: Health + Epics + Decisions */}
			<div className="grid gap-6 lg:grid-cols-3">
				<HealthCard stats={healthData} />
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
}: { label: string; value: number; icon: React.ReactNode; loading?: boolean }) {
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

function TaskCard({ task, isActive, colorIndex }: { task: TaskDetail; isActive: boolean; colorIndex: number }) {
	const progress = task.total > 0 ? (task.completed / task.total) * 100 : 0;
	const isCompleted = task.status === "completed";
	const firstUnchecked = task.next_steps?.find((s) => !s.done);
	const c = SHIMMER_COLORS[colorIndex % SHIMMER_COLORS.length]!;
	const accentColor = `rgb(${c.r},${c.g},${c.b})`;

	return (
		<Link to="/tasks/$slug" params={{ slug: task.slug }} className="block">
			<Card
				className={cn(
					"h-[140px] !gap-0 !py-0 border-stone-200 transition-all hover:shadow-md hover:border-stone-300 dark:border-stone-700 dark:hover:border-stone-600",
					isActive && "ring-1",
					isCompleted && "opacity-60",
				)}
				style={isActive ? { borderColor: `rgba(${c.r},${c.g},${c.b},0.3)` } : undefined}
			>
				<CardContent className="flex-1 flex flex-col p-4 gap-1.5">
					{/* Header */}
					<div className="flex items-center justify-between gap-2">
						<div className="flex items-center gap-2 min-w-0">
							{isCompleted ? (
								<CircleCheck className="size-4 shrink-0" style={{ color: "#2d8b7a" }} />
							) : isActive ? (
								<CircleDot className="size-4 shrink-0" style={{ color: accentColor }} />
							) : (
								<Circle className="size-4 shrink-0 text-muted-foreground/30" />
							)}
							<span className="text-sm font-semibold truncate">{task.slug}</span>
						</div>
						<div className="flex shrink-0 gap-1.5">
							{task.size && (
								<Tooltip>
									<TooltipTrigger asChild>
										<Badge variant="outline" className="text-[10px] px-1.5 py-0 rounded-full cursor-help">
											{task.size}
										</Badge>
									</TooltipTrigger>
									<TooltipContent>{SIZE_LABELS[task.size] ?? `Size: ${task.size}`}</TooltipContent>
								</Tooltip>
							)}
						</div>
					</div>

					{/* Focus + shimmer */}
					<div className="flex-1 flex flex-col justify-center gap-1">
						{task.project_name && (
							<p className="text-[10px] font-medium" style={{ color: accentColor }}>{task.project_name}</p>
						)}
						{task.focus && (
							<p className="text-[11px] text-muted-foreground line-clamp-1">{task.focus}</p>
						)}
						{firstUnchecked && !isCompleted && (
							<div className="relative overflow-hidden rounded-md px-2 py-1">
								<div
									className="absolute inset-0 animate-shimmer"
									style={{ background: shimmerGradient(colorIndex), backgroundSize: "200% 100%" }}
								/>
								<p className="relative text-[11px] line-clamp-1" style={{ color: accentColor }}>
									→ {firstUnchecked.text}
								</p>
							</div>
						)}
					</div>

					{/* Progress */}
					<div className="flex items-center gap-2.5">
						<Progress value={progress} className="h-1.5 flex-1" />
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
	if (!stats) return null;
	return (
		<Card className="border-stone-200 dark:border-stone-700">
			<CardHeader className="pb-3">
				<CardTitle className="text-sm font-semibold" style={{ fontFamily: "var(--font-display)" }}>
					Memory Health
				</CardTitle>
			</CardHeader>
			<CardContent className="space-y-4">
				<div className="grid grid-cols-3 gap-3 text-center">
					<MetricBlock value={stats.total} label="Total" />
					<MetricBlock
						value={stats.stale_count}
						label="Stale"
						warn={stats.stale_count > 0}
						warnColor="#e67e22"
					/>
					<MetricBlock
						value={stats.conflict_count}
						label="Conflicts"
						warn={stats.conflict_count > 0}
						warnColor="#c0392b"
					/>
				</div>
				{stats.vitality_dist && <VitalityDist dist={stats.vitality_dist} />}
			</CardContent>
		</Card>
	);
}

function MetricBlock({
	value,
	label,
	warn,
	warnColor,
}: { value: number; label: string; warn?: boolean; warnColor?: string }) {
	return (
		<div className="rounded-lg bg-accent/50 px-2 py-2.5">
			<p
				className="text-xl font-bold"
				style={{ color: warn ? warnColor : undefined, fontFamily: "var(--font-display)" }}
			>
				{value}
			</p>
			<p className="text-[10px] text-muted-foreground">{label}</p>
		</div>
	);
}

function VitalityDist({ dist }: { dist: [number, number, number, number, number] }) {
	const labels = ["0-20", "21-40", "41-60", "61-80", "81-100"];
	const max = Math.max(...dist, 1);
	return (
		<div className="space-y-1.5">
			<p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
				Vitality
			</p>
			<div className="flex items-end gap-1.5 h-10">
				{dist.map((count, i) => (
					<div key={labels[i]} className="flex-1 flex flex-col items-center gap-1">
						<div
							className="w-full rounded-sm transition-all"
							style={{
								height: `${Math.max((count / max) * 100, count > 0 ? 8 : 0)}%`,
								backgroundColor: "#2d8b7a",
								opacity: 0.25 + (i / 4) * 0.75,
							}}
						/>
						<span className="text-[9px] text-muted-foreground">{labels[i]}</span>
					</div>
				))}
			</div>
		</div>
	);
}

function EpicProgressCard({ epics }: { epics?: EpicSummary[] }) {
	if (!epics || epics.length === 0) return null;
	return (
		<Card className="border-stone-200 dark:border-stone-700">
			<CardHeader className="pb-3">
				<CardTitle className="text-sm font-semibold" style={{ fontFamily: "var(--font-display)" }}>
					Epics
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
							<Progress value={progress} className="h-1.5" />
						</div>
					);
				})}
			</CardContent>
		</Card>
	);
}

function RecentDecisionsCard({ decisions }: { decisions?: DecisionEntry[] }) {
	if (!decisions || decisions.length === 0) return null;
	return (
		<Card className="border-stone-200 dark:border-stone-700">
			<CardHeader className="pb-3">
				<CardTitle className="text-sm font-semibold" style={{ fontFamily: "var(--font-display)" }}>
					Recent Decisions
				</CardTitle>
			</CardHeader>
			<CardContent>
				<div className="space-y-3">
					{decisions.map((dec, i) => (
						<div key={`${dec.task_slug}-${dec.title}-${i}`}>
							{i > 0 && <Separator className="mb-3" />}
							<div className="flex items-start gap-3">
								<div
									className="mt-1.5 size-2 shrink-0 rounded-full"
									style={{ backgroundColor: "#628141" }}
								/>
								<div className="min-w-0 flex-1">
									<p className="text-sm font-medium leading-snug">{dec.title}</p>
									{dec.chosen && (
										<p className="mt-0.5 text-xs text-muted-foreground line-clamp-1">
											{dec.chosen}
										</p>
									)}
								</div>
								<Badge variant="outline" className="shrink-0 text-[10px] rounded-full">
									{dec.task_slug}
								</Badge>
							</div>
						</div>
					))}
				</div>
			</CardContent>
		</Card>
	);
}
