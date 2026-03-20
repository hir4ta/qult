import type { QueryClient } from "@tanstack/react-query";
import { useQuery } from "@tanstack/react-query";
import { createRootRouteWithContext, Link, Outlet } from "@tanstack/react-router";
import { Activity, BookOpen, Globe, LayoutDashboard, ListChecks } from "lucide-react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/lib/i18n";
import { versionQueryOptions } from "@/lib/api";
import { cn } from "@/lib/utils";

interface RouterContext {
	queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
	component: RootLayout,
});

const tabs = [
	{ to: "/", labelKey: "nav.overview" as TranslationKey, icon: LayoutDashboard },
	{ to: "/tasks", labelKey: "nav.tasks" as TranslationKey, icon: ListChecks },
	{ to: "/knowledge", labelKey: "nav.knowledge" as TranslationKey, icon: BookOpen },
	{ to: "/activity", labelKey: "nav.activity" as TranslationKey, icon: Activity },
] as const;

function LanguageToggle() {
	const { locale, setLocale } = useI18n();
	return (
		<button
			type="button"
			onClick={() => setLocale(locale === "en" ? "ja" : "en")}
			className="flex items-center gap-1.5 rounded-lg border border-border/60 px-2.5 h-8 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
		>
			<Globe className="size-4" />
			<span>{locale === "en" ? "EN" : "JA"}</span>
		</button>
	);
}

function VersionBadge() {
	const { data } = useQuery(versionQueryOptions());
	if (!data?.version) return null;
	return (
		<span className="text-[11px] text-muted-foreground/60 font-mono">v{data.version}</span>
	);
}

function RootLayout() {
	const { t } = useI18n();
	return (
		<TooltipProvider>
			<div className="flex min-h-screen flex-col bg-background">
				<header className="sticky top-0 z-50 border-b border-border/60 bg-card/90 backdrop-blur-md">
					<div className="mx-auto flex h-14 max-w-7xl items-center gap-8 px-6">
						<span
							className="text-xl font-bold tracking-tight"
							style={{ fontFamily: "var(--font-display)", color: "#40513b" }}
						>
							alfred
						</span>
						<nav className="flex flex-1 items-center justify-center gap-1">
							{tabs.map((tab) => {
								const Icon = tab.icon;
								return (
									<Link
										key={tab.to}
										to={tab.to}
										activeOptions={{ exact: tab.to === "/" }}
										className={cn(
											"flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-all",
											"text-muted-foreground hover:text-foreground hover:bg-accent/60",
										)}
										activeProps={{
											className: "bg-accent text-foreground",
										}}
									>
										<Icon className="size-4" />
										{t(tab.labelKey)}
									</Link>
								);
							})}
						</nav>
						<div className="ml-auto flex items-center gap-3">
							<LanguageToggle />
							<VersionBadge />
						</div>
					</div>
				</header>
				<main className="mx-auto w-full max-w-7xl flex-1 px-6 py-6">
					<Outlet />
				</main>
			</div>
		</TooltipProvider>
	);
}
