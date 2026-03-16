import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/tasks/$slug")({
	component: TaskDetailPage,
});

function TaskDetailPage() {
	const { slug } = Route.useParams();
	return (
		<div>
			<h1 className="text-lg font-semibold text-foreground">Task: {slug}</h1>
			<p className="mt-2 text-sm text-muted-foreground">Task detail will be here.</p>
		</div>
	);
}
