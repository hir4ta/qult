import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, useParams, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { ButlerEmpty } from "@/components/butler-empty";
import { TaskListView } from "@/components/task-list-view";
import { tasksQueryOptions } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/tasks")({
	component: TasksLayout,
});

function TasksLayout() {
	const { t } = useI18n();
	const search = useSearch({ strict: false }) as { project?: string };
	const { data } = useQuery(tasksQueryOptions(search.project));
	const allTasks = data?.tasks ?? [];
	const { slug: selectedSlug } = useParams({ strict: false }) as { slug?: string };
	const [statusFilter, setStatusFilter] = useState<string>("all");
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
			if (statusFilter === "done" && !terminalStatuses.has(task.status ?? "")) return false;
			return true;
		})
		.sort((a, b) => {
			// Active tasks first, then by started_at descending (newest first)
			const aTerminal = terminalStatuses.has(a.status ?? "") ? 1 : 0;
			const bTerminal = terminalStatuses.has(b.status ?? "") ? 1 : 0;
			if (aTerminal !== bTerminal) return aTerminal - bTerminal;
			return (b.started_at ?? "").localeCompare(a.started_at ?? "");
		});

	return (
		<div className="flex gap-6 items-start">
			<div className="w-72 shrink-0 space-y-2 overflow-y-auto max-h-[calc(100vh-100px)] px-1 pt-1">
				{/* Filters */}
				<div className="flex items-center justify-between pb-1">
					<div className="flex flex-wrap gap-1">
						{(["all", "active", "done"] as const).map((s) => (
							<button key={s} type="button" onClick={() => setStatusFilter(s)}
								className={cn("rounded-lg px-2 py-0.5 text-[10px] font-medium transition-colors border",
									statusFilter === s ? "bg-card text-foreground border-border" : "bg-card text-muted-foreground border-border/40 hover:text-foreground"
								)}
							>{t(`filter.${s}` as never)}</button>
						))}
					</div>
				</div>

				<TaskListView tasks={tasks} selectedSlug={selectedSlug} />

				{tasks.length === 0 && allTasks.length === 0 && <ButlerEmpty scene="empty-tray" messageKey="empty.noTasks" />}
			</div>
			<div className="min-w-0 flex-1">
				<Outlet />
			</div>
		</div>
	);
}
