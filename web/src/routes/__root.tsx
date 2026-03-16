import { cn } from "@/lib/utils";
import type { QueryClient } from "@tanstack/react-query";
import { Link, Outlet, createRootRouteWithContext } from "@tanstack/react-router";

interface RouterContext {
	queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
	component: RootLayout,
});

const tabs = [
	{ to: "/", label: "Overview" },
	{ to: "/tasks", label: "Tasks" },
	{ to: "/knowledge", label: "Knowledge" },
	{ to: "/activity", label: "Activity" },
] as const;

function RootLayout() {
	return (
		<div className="min-h-screen bg-background">
			<header className="sticky top-0 z-50 border-b border-border bg-card/80 backdrop-blur-sm">
				<div className="mx-auto flex h-12 max-w-7xl items-center gap-6 px-4">
					<span className="text-sm font-semibold tracking-tight text-foreground">alfred</span>
					<nav className="flex gap-1">
						{tabs.map((tab) => (
							<Link
								key={tab.to}
								to={tab.to}
								activeOptions={{ exact: tab.to === "/" }}
								className={cn(
									"rounded-md px-3 py-1.5 text-sm transition-colors",
									"text-muted-foreground hover:text-foreground hover:bg-accent",
								)}
								activeProps={{
									className: "bg-accent text-foreground font-medium",
								}}
							>
								{tab.label}
							</Link>
						))}
					</nav>
				</div>
			</header>
			<main className="mx-auto max-w-7xl px-4 py-6">
				<Outlet />
			</main>
		</div>
	);
}
