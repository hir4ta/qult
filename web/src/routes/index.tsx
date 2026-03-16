import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
	component: OverviewPage,
});

function OverviewPage() {
	return (
		<div>
			<h1 className="text-lg font-semibold text-foreground">Overview</h1>
			<p className="mt-2 text-sm text-muted-foreground">Dashboard overview will be here.</p>
		</div>
	);
}
