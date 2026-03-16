import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/knowledge")({
	component: KnowledgePage,
});

function KnowledgePage() {
	return (
		<div>
			<h1 className="text-lg font-semibold text-foreground">Knowledge</h1>
			<p className="mt-2 text-sm text-muted-foreground">Knowledge base will be here.</p>
		</div>
	);
}
