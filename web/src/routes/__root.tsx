import type { QueryClient } from "@tanstack/react-query";
import { useQuery } from "@tanstack/react-query";
import { createRootRouteWithContext, Link, Outlet, useLocation } from "@tanstack/react-router";
import { Activity, BookOpen, Globe, LayoutDashboard, ListChecks } from "@animated-color-icons/lucide-react";
import { useMemo, useState } from "react";
import { KeyboardHelpDialog } from "@/components/keyboard-help";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useI18n } from "@/lib/i18n";
import { useKeyboardShortcuts } from "@/lib/keyboard";
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
	{ to: "/", labelKey: "nav.overview" as TranslationKey, icon: LayoutDashboard, color: "#40513b" },
	{ to: "/tasks", labelKey: "nav.tasks" as TranslationKey, icon: ListChecks, color: "#628141" },
	{ to: "/knowledge", labelKey: "nav.knowledge" as TranslationKey, icon: BookOpen, color: "#2d8b7a" },
	{ to: "/activity", labelKey: "nav.activity" as TranslationKey, icon: Activity, color: "#e67e22" },
] as const;

function LanguageToggle() {
	const { locale, setLocale } = useI18n();
	return (
		<button
			type="button"
			onClick={() => setLocale(locale === "en" ? "ja" : "en")}
			className="al-icon-wrapper flex items-center gap-1.5 px-2.5 h-8 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
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
		<span className="text-[11px] text-muted-foreground/50 font-mono">v{data.version}</span>
	);
}

function useAmbientTint() {
	const location = useLocation();
	const path = location.pathname;
	const tab = tabs.find((t) => (t.to === "/" ? path === "/" : path.startsWith(t.to)));
	return tab?.color ?? tabs[0].color;
}

function RootLayout() {
	const { t } = useI18n();
	const [showHelp, setShowHelp] = useState(false);
	const ambientColor = useAmbientTint();
	useKeyboardShortcuts(useMemo(() => ({ "?": () => setShowHelp(true) }), []));
	return (
		<TooltipProvider>
			<KeyboardHelpDialog open={showHelp} onClose={() => setShowHelp(false)} />
			<div
				className="grain-overlay flex min-h-screen flex-col bg-background transition-colors duration-500"
				style={{ backgroundColor: `${ambientColor}08` }}
			>
				<header className="sticky top-0 z-50">
					<div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-6 mt-4">
						{/* Logo — standalone, left */}
						<span
							className="text-2xl font-bold tracking-tight shrink-0"
							style={{ fontFamily: "var(--font-display)", color: "#40513b" }}
						>
							alfred
						</span>

						<div className="flex-1" />

						{/* Nav tabs — grouped pill, right-aligned */}
						<nav className="flex items-center gap-0.5 rounded-full bg-card/80 border border-border/40 px-1.5 py-1">
							{tabs.map((tab) => {
								const Icon = tab.icon;
								return (
									<Link
										key={tab.to}
										to={tab.to}
										activeOptions={{ exact: tab.to === "/" }}
										className={cn(
											"al-icon-wrapper flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition-colors",
											"text-muted-foreground hover:text-foreground",
										)}
										activeProps={{
											className: "bg-brand-dark text-white hover:text-white",
										}}
									>
										<Icon className="size-4" />
										{t(tab.labelKey)}
									</Link>
								);
							})}
						</nav>

						<LanguageToggle />

						{/* Version — standalone */}
						<VersionBadge />
					</div>
				</header>
				<main className="mx-auto w-full max-w-7xl flex-1 px-6 py-6">
					<Outlet />
				</main>
			</div>
		</TooltipProvider>
	);
}
