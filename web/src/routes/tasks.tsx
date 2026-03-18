import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { tasksQueryOptions } from "@/lib/api";
import type { StepItem, TaskDetail } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Link, Outlet, createFileRoute } from "@tanstack/react-router";
import { CircleCheck, CircleDot, Circle } from "lucide-react";

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
	const { data } = useQuery(tasksQueryOptions());
	const tasks = data?.tasks ?? [];
	const activeSlug = data?.active ?? "";

	return (
		<div className="flex gap-6">
			<div className="w-72 shrink-0 space-y-3">
				{tasks.map((task, i) => (
					<TaskListCard key={task.slug} task={task} isActive={task.slug === activeSlug} colorIndex={i} />
				))}
				{tasks.length === 0 && <p className="text-sm text-muted-foreground">No tasks found.</p>}
			</div>
			<div className="min-w-0 flex-1">
				<Outlet />
			</div>
		</div>
	);
}

function TaskListCard({ task, isActive, colorIndex }: { task: TaskDetail; isActive: boolean; colorIndex: number }) {
	const progress = task.total > 0 ? (task.completed / task.total) * 100 : 0;
	const isCompleted = task.status === "completed";
	const firstUnchecked = task.next_steps?.find((s) => !s.done);
	const c = SHIMMER_COLORS[colorIndex % SHIMMER_COLORS.length]!;
	const accentColor = `rgb(${c.r},${c.g},${c.b})`;

	return (
		<Link to="/tasks/$slug" params={{ slug: task.slug }} className="block">
			<Card
				className={cn(
					"!gap-0 !py-0 transition-all hover:shadow-sm cursor-pointer",
					isActive && "ring-1",
					isCompleted && "opacity-60",
				)}
				style={isActive ? { borderColor: `rgba(${c.r},${c.g},${c.b},0.35)` } : undefined}
			>
				<CardHeader className="p-3 pb-1.5">
					<div className="flex items-center justify-between">
						<div className="flex items-center gap-2 min-w-0">
							{isCompleted ? (
								<CircleCheck className="size-3.5 shrink-0" style={{ color: "#2d8b7a" }} />
							) : isActive ? (
								<CircleDot className="size-3.5 shrink-0" style={{ color: accentColor }} />
							) : (
								<Circle className="size-3.5 shrink-0 text-muted-foreground/30" />
							)}
							<CardTitle className="text-sm font-medium truncate">{task.slug}</CardTitle>
						</div>
						<div className="flex gap-1">
							{task.size && (
								<Badge variant="outline" className="text-[10px] px-1 py-0">
									{task.size}
								</Badge>
							)}
						</div>
					</div>
				</CardHeader>
				<CardContent className="p-3 pt-0 space-y-1.5">
					{task.project_name && (
						<p className="text-[10px] font-medium" style={{ color: "#40513b" }}>{task.project_name}</p>
					)}
					{task.focus && (
						<p className="text-[11px] text-muted-foreground line-clamp-1">{task.focus}</p>
					)}
					<div className="flex items-center gap-2">
						<Progress value={progress} className="h-1 flex-1" />
						<span className="text-[10px] tabular-nums text-muted-foreground">
							{task.completed}/{task.total}
						</span>
					</div>
					{firstUnchecked && !isCompleted && (
						<NextStepHighlight step={firstUnchecked} colorIndex={colorIndex} />
					)}
				</CardContent>
			</Card>
		</Link>
	);
}

function NextStepHighlight({ step, colorIndex }: { step: StepItem; colorIndex: number }) {
	const c = SHIMMER_COLORS[colorIndex % SHIMMER_COLORS.length]!;
	return (
		<div className="relative overflow-hidden rounded-md px-2 py-1">
			<div
				className="absolute inset-0 animate-shimmer"
				style={{
					background: `linear-gradient(90deg, rgba(${c.r},${c.g},${c.b},0.03) 0%, rgba(${c.r},${c.g},${c.b},0.12) 50%, rgba(${c.r},${c.g},${c.b},0.03) 100%)`,
					backgroundSize: "200% 100%",
				}}
			/>
			<p className="relative text-[10px] line-clamp-1" style={{ color: `rgb(${c.r},${c.g},${c.b})` }}>
				→ {step.text}
			</p>
		</div>
	);
}
