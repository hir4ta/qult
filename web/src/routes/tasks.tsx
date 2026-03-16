import { Outlet, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/tasks")({
	component: TasksLayout,
});

function TasksLayout() {
	return (
		<div>
			<h1 className="text-lg font-semibold text-foreground">Tasks</h1>
			<p className="mt-2 text-sm text-muted-foreground">Task list will be here.</p>
			<Outlet />
		</div>
	);
}
