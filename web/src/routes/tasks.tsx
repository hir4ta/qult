import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { tasksQueryOptions } from "@/lib/api";
import type { StepItem, TaskDetail } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Link, Outlet, createFileRoute } from "@tanstack/react-router";
import { ChevronDown, CircleCheck, CircleDot, Circle } from "lucide-react";
import { useState } from "react";

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

	const activeTasks = tasks.filter((t) => t.status !== "completed");
	const completedTasks = tasks.filter((t) => t.status === "completed");

	return (
		<div className="flex gap-6">
			<div className="w-72 shrink-0 space-y-4 overflow-y-auto max-h-[calc(100vh-100px)]">
				{/* Active Tasks */}
				{activeTasks.length > 0 && (
					<div className="space-y-2">
						<h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground px-1">Active</h3>
						{activeTasks.map((task, i) => (
							<TaskAccordionCard
								key={task.slug}
								task={task}
								isActive={task.slug === activeSlug}
								colorIndex={i}
							/>
						))}
					</div>
				)}

				{/* Completed Tasks */}
				{completedTasks.length > 0 && (
					<div className="space-y-2">
						<h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground px-1">Completed</h3>
						{completedTasks.map((task, i) => (
							<TaskAccordionCard
								key={task.slug}
								task={task}
								isActive={false}
								colorIndex={activeTasks.length + i}
							/>
						))}
					</div>
				)}

				{tasks.length === 0 && <p className="text-sm text-muted-foreground">No tasks found.</p>}
			</div>
			<div className="min-w-0 flex-1">
				<Outlet />
			</div>
		</div>
	);
}

function TaskAccordionCard({
	task,
	isActive,
	colorIndex,
}: { task: TaskDetail; isActive: boolean; colorIndex: number }) {
	const [expanded, setExpanded] = useState(false);
	const progress = task.total > 0 ? (task.completed / task.total) * 100 : 0;
	const isCompleted = task.status === "completed";
	const firstUnchecked = task.next_steps?.find((s) => !s.done);
	const c = SHIMMER_COLORS[colorIndex % SHIMMER_COLORS.length]!;
	const accentColor = `rgb(${c.r},${c.g},${c.b})`;
	const firstUncheckedIdx = task.next_steps?.findIndex((s) => !s.done) ?? -1;

	return (
		<div
			className={cn(
				"rounded-xl border bg-card text-card-foreground shadow-sm transition-all",
				isActive && "ring-1",
				isCompleted && "opacity-60",
			)}
			style={isActive ? { borderColor: `rgba(${c.r},${c.g},${c.b},0.35)` } : undefined}
		>
			{/* Card header — always visible, clickable to navigate */}
			<Link
				to="/tasks/$slug"
				params={{ slug: task.slug }}
				className="block p-3 pb-2"
			>
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-2 min-w-0">
						{isCompleted ? (
							<CircleCheck className="size-3.5 shrink-0" style={{ color: "#2d8b7a" }} />
						) : isActive ? (
							<CircleDot className="size-3.5 shrink-0" style={{ color: accentColor }} />
						) : (
							<Circle className="size-3.5 shrink-0 text-muted-foreground/30" />
						)}
						<span className="text-sm font-medium truncate">{task.slug}</span>
					</div>
					<Badge variant="outline" className="text-[10px] px-1 py-0 shrink-0">
						{task.size ?? "?"}
					</Badge>
				</div>
			</Link>

			{/* Compact info — always visible */}
			<div className="px-3 pb-2 space-y-1.5">
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
				{firstUnchecked && !isCompleted && !expanded && (
					<div className="relative overflow-hidden rounded-md px-2 py-1">
						<div
							className="absolute inset-0 animate-shimmer"
							style={{
								background: `linear-gradient(90deg, rgba(${c.r},${c.g},${c.b},0.03) 0%, rgba(${c.r},${c.g},${c.b},0.12) 50%, rgba(${c.r},${c.g},${c.b},0.03) 100%)`,
								backgroundSize: "200% 100%",
							}}
						/>
						<p className="relative text-[10px] line-clamp-1" style={{ color: accentColor }}>
							→ {firstUnchecked.text}
						</p>
					</div>
				)}
			</div>

			{/* Accordion toggle — Next Steps */}
			{task.next_steps && task.next_steps.length > 0 && !isCompleted && (
				<>
					<button
						type="button"
						onClick={(e) => { e.preventDefault(); setExpanded(!expanded); }}
						className="flex w-full items-center justify-between border-t border-border/50 px-3 py-1.5 text-[10px] text-muted-foreground hover:bg-accent/50 transition-colors"
					>
						<span>Next Steps ({task.completed}/{task.total})</span>
						<ChevronDown
							className={cn("size-3 transition-transform", expanded && "rotate-180")}
						/>
					</button>

					{expanded && (
						<div className="px-3 pb-3 space-y-0.5">
							{task.next_steps.map((step, i) => {
								const isCurrent = i === firstUncheckedIdx;
								return (
									<div
										key={`step-${i}`}
										className={cn(
											"relative flex items-start gap-2 rounded-md px-2 py-1 transition-colors",
											isCurrent && "overflow-hidden",
										)}
									>
										{isCurrent && (
											<div
												className="absolute inset-0 animate-shimmer"
												style={{
													background: `linear-gradient(90deg, rgba(${c.r},${c.g},${c.b},0.03) 0%, rgba(${c.r},${c.g},${c.b},0.10) 50%, rgba(${c.r},${c.g},${c.b},0.03) 100%)`,
													backgroundSize: "200% 100%",
												}}
											/>
										)}
										<Checkbox checked={step.done} className="relative mt-0.5" />
										<span
											className={cn(
												"relative text-[10px] leading-relaxed",
												step.done && "line-through text-muted-foreground",
												isCurrent && "font-medium",
											)}
										>
											{step.text}
										</span>
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
