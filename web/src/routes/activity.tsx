import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { EpicDependencies } from "@/components/epic-deps";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { activityQueryOptions, epicsQueryOptions } from "@/lib/api";
import { useI18n, dateLocale } from "@/lib/i18n";
import type { ActivityEntry, EpicSummary } from "@/lib/types";

export const Route = createFileRoute("/activity")({
	component: ActivityPage,
});

const FILTERS = ["all", "spec.init", "spec.complete", "review.submit"] as const;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function ActivityPage() {
	const { t } = useI18n();
	const [filter, setFilter] = useState<string>("all");
	const [showAll, setShowAll] = useState(false);
	const [dateFrom, setDateFrom] = useState("");
	const [dateTo, setDateTo] = useState("");
	const { data: activityData, isLoading } = useQuery(
		activityQueryOptions(100, filter === "all" ? undefined : filter),
	);
	const { data: epicsData } = useQuery(epicsQueryOptions());

	const allEntries = activityData?.entries ?? [];
	const entries = useMemo(() => {
		let result = allEntries;
		if (!showAll && !dateFrom && !dateTo) {
			const cutoff = Date.now() - WEEK_MS;
			result = result.filter((e) => { try { return new Date(e.timestamp).getTime() >= cutoff; } catch { return true; } });
		}
		if (dateFrom) { const f = new Date(dateFrom).getTime(); result = result.filter((e) => { try { return new Date(e.timestamp).getTime() >= f; } catch { return true; } }); }
		if (dateTo) { const t = new Date(dateTo).getTime() + 86400000; result = result.filter((e) => { try { return new Date(e.timestamp).getTime() < t; } catch { return true; } }); }
		return result;
	}, [allEntries, showAll, dateFrom, dateTo]);
	const hasOlder = !showAll && entries.length < allEntries.length;
	const epics = (epicsData?.epics ?? []).filter((e) => e.status !== "completed" && e.status !== "done");

	return (
		<div className="space-y-6">
			<div className="sticky top-14 z-10 bg-background pb-3 flex items-center gap-4">
				<Tabs value={filter} onValueChange={setFilter}>
					<TabsList>
						{FILTERS.map((f) => (
							<TabsTrigger key={f} value={f} className="text-xs">
								{f === "all" ? t("activity.all") : f}
							</TabsTrigger>
						))}
					</TabsList>
				</Tabs>
				<div className="flex items-center gap-2 text-xs ml-auto">
					<span className="text-muted-foreground">{t("activity.fromDate")}</span>
					<input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="rounded-lg border bg-card px-2 py-1 text-xs h-7" />
					<span className="text-muted-foreground">{t("activity.toDate")}</span>
					<input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="rounded-lg border bg-card px-2 py-1 text-xs h-7" />
					<Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => {
						const header = "timestamp,action,target,detail\n";
						const rows = entries.map((e) => `${e.timestamp},${e.action},${e.target},"${(e.detail ?? "").replace(/"/g, '""')}"`).join("\n");
						const blob = new Blob([header + rows], { type: "text/csv" });
						const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = "activity.csv"; a.click(); URL.revokeObjectURL(url);
					}}>
						{t("activity.exportCsv")}
					</Button>
				</div>
			</div>

			{isLoading ? (
				<div className="space-y-2">
					{Array.from({ length: 5 }).map((_, i) => (
						<Skeleton key={`skel-${i}`} className="h-10 w-full" />
					))}
				</div>
			) : (
				<>
					<ActivityTable entries={entries} />
					{hasOlder && (
						<div className="flex justify-center">
							<Button variant="outline" size="sm" onClick={() => setShowAll(true)}>
								{t("activity.showOlder")}
							</Button>
						</div>
					)}
				</>
			)}

			{epics.length > 0 && <EpicSection epics={epics} />}
		</div>
	);
}

function ActivityTable({ entries }: { entries: ActivityEntry[] }) {
	const { t, locale } = useI18n();
	const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

	return (
		<Table>
			<TableHeader>
				<TableRow>
					<TableHead className="w-44">{t("activity.timestamp")}</TableHead>
					<TableHead className="w-32">{t("activity.action")}</TableHead>
					<TableHead>{t("activity.target")}</TableHead>
					<TableHead>{t("activity.detail")}</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{entries.map((entry, i) => {
					const isExpanded = expandedIdx === i;
					const hasDetail = !!entry.detail && entry.detail.length > 40;
					return (
						<TableRow
							key={`${entry.timestamp}-${i}`}
							className={hasDetail ? "cursor-pointer hover:bg-accent/50" : ""}
							onClick={() => hasDetail && setExpandedIdx(isExpanded ? null : i)}
						>
							<TableCell className="text-xs text-muted-foreground font-mono align-top">
								{formatTimestamp(entry.timestamp, locale)}
							</TableCell>
							<TableCell className="align-top">
								<ActionBadge action={entry.action} />
							</TableCell>
							<TableCell className="text-sm align-top">{entry.target}</TableCell>
							<TableCell className="text-xs text-muted-foreground">
								{isExpanded ? (
									<div className="whitespace-pre-wrap break-words max-w-lg">{entry.detail}</div>
								) : (
									<div className="max-w-xs truncate">{entry.detail}</div>
								)}
							</TableCell>
						</TableRow>
					);
				})}
				{entries.length === 0 && (
					<TableRow>
						<TableCell colSpan={4} className="text-center text-sm text-muted-foreground">
							{t("activity.noActivity")}
						</TableCell>
					</TableRow>
				)}
			</TableBody>
		</Table>
	);
}

const ACTION_COLORS: Record<string, string> = {
	"spec.init": "#40513b",
	"spec.complete": "#2d8b7a",
	"spec.delete": "#c0392b",
	"review.submit": "#628141",
	"living-spec.update": "#7b6b8d",
};

function ActionBadge({ action }: { action: string }) {
	const color = ACTION_COLORS[action] ?? "#6b7280";
	return (
		<Badge variant="outline" className="text-xs" style={{ borderColor: `${color}40`, color }}>
			{action}
		</Badge>
	);
}

function EpicSection({ epics }: { epics: EpicSummary[] }) {
	const { t } = useI18n();
	return (
		<div className="space-y-3">
			<h3 className="text-sm font-medium text-foreground">{t("activity.epics")}</h3>
			<div className="grid gap-3 sm:grid-cols-2">
				{epics.map((epic) => {
					const progress = epic.total > 0 ? (epic.completed / epic.total) * 100 : 0;
					return (
						<Card key={epic.slug}>
							<CardHeader className="pb-2">
								<div className="flex items-center justify-between">
									<CardTitle className="text-sm">{epic.name}</CardTitle>
									<Badge variant="outline" className="text-xs">
										{epic.status}
									</Badge>
								</div>
							</CardHeader>
							<CardContent className="space-y-2">
								<div className="flex items-center gap-2">
									<Progress value={progress} className="flex-1" />
									<span className="text-xs text-muted-foreground">
										{epic.completed}/{epic.total}
									</span>
								</div>
								{epic.tasks && epic.tasks.length > 0 && (
									<div className="flex flex-wrap gap-1">
										{epic.tasks.map((t) => (
											<Badge
												key={t.slug}
												variant="outline"
												className="text-[10px]"
												style={{
													borderColor:
														t.status === "completed" || t.status === "done"
															? "rgba(45,139,122,0.3)"
															: "rgba(107,114,128,0.3)",
													color: t.status === "completed" || t.status === "done" ? "#2d8b7a" : "#6b7280",
												}}
											>
												{t.slug}
											</Badge>
										))}
									</div>
								)}
								<EpicDependencies epic={epic} />
							</CardContent>
						</Card>
					);
				})}
			</div>
		</div>
	);
}

function formatTimestamp(ts: string, locale: "en" | "ja" = "en"): string {
	try {
		const d = new Date(ts);
		return d.toLocaleString(dateLocale(locale), {
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		});
	} catch {
		return ts;
	}
}
