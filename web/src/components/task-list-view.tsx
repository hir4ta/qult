import { Link } from "@tanstack/react-router";
import { CircleCheck, CircleDashed, CirclePause, CircleX } from "@animated-color-icons/lucide-react";
import { Progress } from "@/components/ui/progress";
import type { TaskDetail } from "@/lib/types";
import { cn } from "@/lib/utils";

function TaskStatusDot({ status }: { status: string }) {
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
		default:
			return <CircleDashed className="size-3.5 shrink-0" style={{ color: "#628141" }} />;
	}
}

export function TaskListView({
	tasks,
	selectedSlug,
}: {
	tasks: TaskDetail[];
	selectedSlug?: string;
}) {
	return (
		<div className="space-y-1">
			{tasks.map((task) => {
				const progress = (task.total ?? 0) > 0 ? ((task.completed ?? 0) / (task.total ?? 1)) * 100 : 0;
				const isCompleted = task.status === "completed" || task.status === "done" || task.status === "cancelled";
				const projectId = (task as Record<string, unknown>).project_id as string | undefined;

				return (
					<Link
						key={task.slug}
						to="/tasks/$slug"
						params={{ slug: task.slug }}
						search={projectId ? { project: projectId } : {}}
						className={cn(
							"flex items-center gap-3 h-10 px-3 rounded-organic border border-transparent transition-colors hover:bg-accent/50",
							task.slug === selectedSlug && "border-border bg-accent/30",
							isCompleted && "opacity-60",
						)}
					>
						<TaskStatusDot status={task.status ?? "pending"} />
						<span className="text-sm font-mono truncate min-w-0 flex-1">{task.slug}</span>
						<div className="flex items-center gap-2 shrink-0 w-32">
							<Progress value={progress} className="h-1 flex-1" />
							<span className="text-[10px] tabular-nums text-muted-foreground w-8 text-right">
								{task.completed}/{task.total}
							</span>
						</div>
					</Link>
				);
			})}
		</div>
	);
}
