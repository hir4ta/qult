import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { activityQueryOptions, analyticsQueryOptions } from "@/lib/api";
import type { AnalyticsResponse } from "@/lib/api";
import { useI18n } from "@/lib/i18n";

export const Route = createFileRoute("/activity")({
	component: ActivityPage,
});

function ActivityPage() {
	const { t } = useI18n();
	const { data: analytics } = useQuery(analyticsQueryOptions());
	const [page, setPage] = useState(0);
	const { data: activity } = useQuery(activityQueryOptions(page));

	const hasMetrics = analytics && (
		(analytics.reworkRates?.length ?? 0) > 0 ||
		(analytics.cycleTimeBreakdown?.length ?? 0) > 0
	);

	return (
		<div className="flex flex-col gap-6 h-[calc(100vh-8rem)]">
			<h1
				className="text-2xl font-bold tracking-tight shrink-0"
				style={{ fontFamily: "var(--font-display)" }}
			>
				{t("activity.title")}
			</h1>

			{hasMetrics ? (
				<div className="shrink-0 space-y-6">
					<SummaryCards analytics={analytics!} />
					<div className="grid gap-6 lg:grid-cols-2">
						<ReworkChart analytics={analytics!} />
						<CycleTimeChart analytics={analytics!} />
					</div>
				</div>
			) : (
				<div className="flex flex-col items-center justify-center py-12 text-center shrink-0">
					<p className="text-lg font-medium text-muted-foreground" style={{ fontFamily: "var(--font-display)" }}>
						{t("activity.empty.title")}
					</p>
					<p className="mt-2 text-sm text-muted-foreground/70">
						{t("activity.empty.description")}
					</p>
				</div>
			)}

			<AuditLogTable
				entries={activity?.entries ?? []}
				total={activity?.total ?? 0}
				page={page}
				onPageChange={setPage}
			/>
		</div>
	);
}

// --- Summary Cards ---

function SummaryCards({ analytics }: { analytics: AnalyticsResponse }) {
	const { t } = useI18n();

	const confirmedRework = analytics.reworkRates.filter((r) => !r.pending);
	const avgRework = confirmedRework.length > 0
		? confirmedRework.reduce((s, r) => s + r.reworkRate, 0) / confirmedRework.length
		: 0;

	const avgCycle = analytics.cycleTimeBreakdown.length > 0
		? analytics.cycleTimeBreakdown.reduce((s, r) => s + r.phases.total, 0) / analytics.cycleTimeBreakdown.length
		: 0;

	const totalSpecs = analytics.cycleTimeBreakdown.length;

	const cards = [
		{ label: t("activity.avgCycleTime"), value: `${avgCycle.toFixed(1)}`, unit: t("activity.days"), color: "#628141" },
		{ label: t("activity.avgReworkRate"), value: `${(avgRework * 100).toFixed(0)}%`, unit: "", color: avgRework > 0.15 ? "#c0392b" : "#2d8b7a" },
		{ label: t("activity.totalSpecs"), value: String(totalSpecs), unit: "", color: "#40513b" },
	];

	return (
		<div className="grid gap-4 sm:grid-cols-3">
			{cards.map((card) => (
				<div
					key={card.label}
					className="rounded-organic border border-border/60 bg-card py-4 px-4"
				>
					<p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">{card.label}</p>
					<p className="mt-1 text-2xl font-bold" style={{ fontFamily: "var(--font-display)", color: card.color }}>
						{card.value}
						{card.unit && <span className="ml-1 text-sm font-normal text-muted-foreground">{card.unit}</span>}
					</p>
				</div>
			))}
		</div>
	);
}

// --- Rework Rate Chart (CSS-based bar chart) ---

function ReworkChart({ analytics }: { analytics: AnalyticsResponse }) {
	const { t } = useI18n();
	if (analytics.reworkRates.length === 0) return null;

	const maxRate = Math.max(...analytics.reworkRates.map((r) => r.reworkRate), 0.01);

	return (
		<div className="rounded-organic border border-border/60 bg-card py-4 px-4">
			<h3 className="text-sm font-semibold mb-3">{t("activity.rework.title")}</h3>
			<div className="space-y-3">
				{analytics.reworkRates.map((r) => {
					const pct = Math.round(r.reworkRate * 100);
					const width = Math.max((r.reworkRate / maxRate) * 100, 2);
					return (
						<div key={r.slug}>
							<div className="flex items-baseline justify-between mb-1">
								<span className="text-[11px] font-mono text-foreground/80">{r.slug}</span>
								<span className="text-[11px] font-mono text-muted-foreground">{pct}%</span>
							</div>
							<div className="h-4 bg-muted/30 rounded overflow-hidden">
								<div
									className="h-full rounded"
									style={{
										width: `${width}%`,
										backgroundColor: r.pending ? "#e67e22" : "#2d8b7a",
										opacity: r.pending ? 0.5 : 1,
									}}
								/>
							</div>
						</div>
					);
				})}
			</div>
			{analytics.reworkRates.some((r) => r.pending) && (
				<p className="text-[10px] text-muted-foreground mt-2">{t("activity.rework.pending")}</p>
			)}
		</div>
	);
}

// --- Cycle Time Chart (CSS-based stacked bar) ---

const PHASE_COLORS = {
	planning: "#628141",
	approval: "#e67e22",
	implementation: "#2d8b7a",
};

function CycleTimeChart({ analytics }: { analytics: AnalyticsResponse }) {
	const { t } = useI18n();
	if (analytics.cycleTimeBreakdown.length === 0) return null;

	const maxTotal = Math.max(...analytics.cycleTimeBreakdown.map((r) => r.phases.total), 0.1);

	return (
		<div className="rounded-organic border border-border/60 bg-card py-4 px-4">
			<h3 className="text-sm font-semibold mb-3">{t("activity.cycleTime.title")}</h3>
			<div className="space-y-3">
				{analytics.cycleTimeBreakdown.map((r) => {
					const p = r.phases;
					const planW = ((p.planning ?? 0) / maxTotal) * 100;
					const apprW = ((p.approvalWait ?? 0) / maxTotal) * 100;
					const implW = ((p.implementation ?? 0) / maxTotal) * 100;
					return (
						<div key={r.slug}>
							<div className="flex items-baseline justify-between mb-1">
								<span className="text-[11px] font-mono text-foreground/80">{r.slug}</span>
								<span className="text-[11px] font-mono text-muted-foreground">{p.total.toFixed(1)}d</span>
							</div>
							<div className="h-4 bg-muted/30 rounded overflow-hidden flex">
								{planW > 0 && (
									<div className="h-full" style={{ width: `${planW}%`, backgroundColor: PHASE_COLORS.planning }} title={`${t("activity.cycleTime.planning")}: ${p.planning?.toFixed(1)}d`} />
								)}
								{apprW > 0 && (
									<div className="h-full" style={{ width: `${apprW}%`, backgroundColor: PHASE_COLORS.approval }} title={`${t("activity.cycleTime.approval")}: ${p.approvalWait?.toFixed(1)}d`} />
								)}
								{implW > 0 && (
									<div className="h-full" style={{ width: `${implW}%`, backgroundColor: PHASE_COLORS.implementation }} title={`${t("activity.cycleTime.implementation")}: ${p.implementation?.toFixed(1)}d`} />
								)}
							</div>
						</div>
					);
				})}
			</div>
			<div className="flex gap-4 mt-3">
				{(["planning", "approval", "implementation"] as const).map((key) => (
					<span key={key} className="flex items-center gap-1 text-[10px] text-muted-foreground">
						<span className="size-2 rounded-sm" style={{ backgroundColor: PHASE_COLORS[key] }} />
						{t(`activity.cycleTime.${key}` as "activity.cycleTime.planning")}
					</span>
				))}
			</div>
		</div>
	);
}

// --- Audit Log Table (sticky header, scrollable body) ---

interface AuditEntry {
	timestamp: string;
	action: string;
	target: string;
	detail: string;
	actor: string;
	project_name?: string;
}

function AuditLogTable({
	entries,
	total,
	page,
	onPageChange,
}: {
	entries: AuditEntry[];
	total: number;
	page: number;
	onPageChange: (p: number) => void;
}) {
	const { t } = useI18n();
	const totalPages = Math.ceil(total / 50);

	return (
		<div className="rounded-organic border border-border/60 bg-card flex flex-col min-h-0 flex-1">
			<div className="flex items-center justify-between py-3 px-4 border-b border-border/30 shrink-0">
				<h3 className="text-sm font-semibold">{t("activity.log.title")}</h3>
				{totalPages > 1 && (
					<div className="flex items-center gap-2 text-[11px] text-muted-foreground">
						<span>{total} {t("activity.log.entries")}</span>
						<button
							type="button"
							disabled={page === 0}
							onClick={() => onPageChange(page - 1)}
							className="px-2 py-0.5 rounded border border-border/40 disabled:opacity-30"
						>
							{t("activity.log.prev")}
						</button>
						<span>{page + 1}/{totalPages}</span>
						<button
							type="button"
							disabled={page >= totalPages - 1}
							onClick={() => onPageChange(page + 1)}
							className="px-2 py-0.5 rounded border border-border/40 disabled:opacity-30"
						>
							{t("activity.log.next")}
						</button>
					</div>
				)}
			</div>
			{entries.length === 0 ? (
				<p className="text-sm text-muted-foreground py-8 text-center">{t("activity.noMetrics")}</p>
			) : (
				<div className="overflow-auto flex-1 min-h-0">
					<table className="w-full text-sm">
						<thead className="sticky top-0 bg-card z-10">
							<tr className="border-b border-border/40 text-left text-[11px] text-muted-foreground uppercase tracking-wider">
								<th className="py-2 px-4 whitespace-nowrap">{t("activity.log.time")}</th>
								<th className="py-2 pr-3 whitespace-nowrap">{t("activity.log.event")}</th>
								<th className="py-2 pr-3 whitespace-nowrap">{t("activity.log.slug")}</th>
								<th className="py-2 pr-3 whitespace-nowrap">{t("activity.log.actor")}</th>
								<th className="py-2 pr-4">{t("activity.log.detail")}</th>
							</tr>
						</thead>
						<tbody>
							{entries.map((e, i) => (
								<AuditRow key={i} entry={e} />
							))}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
}

// --- Event Badge ---

const EVENT_COLORS: Record<string, { bg: string; text: string }> = {
	"spec.init": { bg: "#40513b20", text: "#40513b" },
	"spec.complete": { bg: "#62814120", text: "#628141" },
	"review.submit": { bg: "#2d8b7a20", text: "#2d8b7a" },
	"gate.set": { bg: "#e67e2220", text: "#e67e22" },
	"gate.clear": { bg: "#62814120", text: "#628141" },
	"gate.fix": { bg: "#e67e2220", text: "#e67e22" },
	"first_commit": { bg: "#7b6b8d20", text: "#7b6b8d" },
	"task.status_change": { bg: "#44403c15", text: "#44403c" },
	"living-spec.update": { bg: "#2d8b7a15", text: "#2d8b7a" },
	"rework.checked": { bg: "#c0392b20", text: "#c0392b" },
};

function EventBadge({ event }: { event: string }) {
	const colors = EVENT_COLORS[event] ?? { bg: "#44403c10", text: "#44403c" };
	return (
		<span
			className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium font-mono whitespace-nowrap"
			style={{ backgroundColor: colors.bg, color: colors.text }}
		>
			{event}
		</span>
	);
}

function AuditRow({ entry: e }: { entry: AuditEntry }) {
	const [expanded, setExpanded] = useState(false);
	const isLong = e.detail.length > 50;

	return (
		<>
			<tr
				className={`border-b border-border/10 last:border-0 hover:bg-muted/20 ${isLong ? "cursor-pointer" : ""}`}
				onClick={() => isLong && setExpanded(!expanded)}
			>
				<td className="py-1.5 px-4 text-[11px] text-muted-foreground font-mono whitespace-nowrap">
					{formatTimestamp(e.timestamp)}
				</td>
				<td className="py-1.5 pr-3">
					<EventBadge event={e.action} />
				</td>
				<td className="py-1.5 pr-3 font-mono text-[11px]">{e.target}</td>
				<td className="py-1.5 pr-3 text-[11px] text-muted-foreground">{e.actor}</td>
				<td className="py-1.5 pr-4 text-[11px] text-muted-foreground">
					{expanded ? (
						<span className="whitespace-pre-wrap break-all">{e.detail}</span>
					) : (
						<span className="flex items-center gap-1">
							<span className="truncate max-w-[300px] inline-block align-bottom">{e.detail}</span>
							{isLong && <span className="text-muted-foreground/50 shrink-0">▸</span>}
						</span>
					)}
				</td>
			</tr>
			{expanded && (
				<tr className="bg-muted/10">
					<td colSpan={5} className="px-4 py-2 text-[11px] text-muted-foreground whitespace-pre-wrap break-all">
						{e.detail}
					</td>
				</tr>
			)}
		</>
	);
}

function formatTimestamp(ts: string): string {
	const d = new Date(ts);
	const month = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	const hours = String(d.getHours()).padStart(2, "0");
	const mins = String(d.getMinutes()).padStart(2, "0");
	return `${month}/${day} ${hours}:${mins}`;
}
