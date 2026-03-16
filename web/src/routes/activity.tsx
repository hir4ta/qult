import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/activity")({
	component: ActivityPage,
});

function ActivityPage() {
	return (
		<div>
			<h1 className="text-lg font-semibold text-foreground">Activity</h1>
			<p className="mt-2 text-sm text-muted-foreground">Activity timeline will be here.</p>
		</div>
	);
}
