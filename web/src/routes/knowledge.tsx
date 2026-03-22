import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { KnowledgeCard } from "@/components/knowledge-card";
import { KnowledgeListView } from "@/components/knowledge-list-view";
import { KnowledgeDrawerContent } from "@/components/knowledge-detail";
import { DetailDrawer } from "@/components/detail-drawer";
import { ButlerEmpty } from "@/components/butler-empty";
import { ViewSwitcher } from "@/components/view-switcher";
import { StaggerContainer } from "@/components/stagger-container";
import {
	Pagination,
	PaginationContent,
	PaginationItem,
	PaginationLink,
	PaginationNext,
	PaginationPrevious,
} from "@/components/ui/pagination";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
	knowledgeQueryOptions,
	knowledgeStatsQueryOptions,
	knowledgeGapsQueryOptions,
} from "@/lib/api";
import { formatLabel } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import { useViewMode } from "@/lib/use-view-mode";
import type { KnowledgeEntry, KnowledgeStats } from "@/lib/types";
import { SUB_TYPE_COLORS } from "@/lib/types";

export const Route = createFileRoute("/knowledge")({
	component: KnowledgePage,
});

function KnowledgePage() {
	const [selected, setSelected] = useState<KnowledgeEntry | null>(null);
	const [page, setPage] = useState(1);
	const [viewMode, setViewModeRaw] = useViewMode("knowledge", "card");
	const setViewMode = (mode: "list" | "card") => { setViewModeRaw(mode); setPage(1); };

	const search = useSearch({ strict: false }) as { project?: string };
	const projectId = search.project;
	const { data: browseData, isLoading } = useQuery(knowledgeQueryOptions(undefined, projectId));
	const { data: statsData } = useQuery(knowledgeStatsQueryOptions(projectId));

	const entries = browseData?.entries ?? [];

	const { data: gapsData } = useQuery(knowledgeGapsQueryOptions(projectId));

	return (
		<div className="space-y-5">
			{/* Stats + View Switcher */}
			<div className="flex items-center justify-between">
				<ViewSwitcher current={viewMode} onChange={setViewMode} />
				{statsData && <StatsBar stats={statsData} />}
			</div>

			{/* Content */}
			{(() => {
					const perPage = 9;
					const totalPages = Math.ceil(entries.length / perPage);
					const safePage = Math.min(page, Math.max(1, totalPages));
					const paged = entries.slice((safePage - 1) * perPage, safePage * perPage);
					return (
						<>
							{isLoading ? (
								<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
									{Array.from({ length: 9 }).map((_, i) => (
										<Skeleton key={i} className="h-28 rounded-xl" />
									))}
								</div>
							) : paged.length > 0 ? (
								<>
									{viewMode === "list" ? (
										<KnowledgeListView entries={paged} onSelect={(entry) => setSelected(entry)} />
									) : (
										<StaggerContainer className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
											{paged.map((entry) => (
												<KnowledgeCard
													key={entry.id}
													entry={entry}
													onSelect={() => setSelected(entry)}
												/>
											))}
										</StaggerContainer>
									)}
									{totalPages > 1 && (
										<Pagination>
											<PaginationContent>
												<PaginationItem>
													<PaginationPrevious
														onClick={() => setPage(Math.max(1, safePage - 1))}
														aria-disabled={safePage <= 1}
														className={
															safePage <= 1 ? "pointer-events-none opacity-50" : "cursor-pointer"
														}
													/>
												</PaginationItem>
												{Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
													<PaginationItem key={p}>
														<PaginationLink
															isActive={p === safePage}
															onClick={() => setPage(p)}
															className="cursor-pointer"
														>
															{p}
														</PaginationLink>
													</PaginationItem>
												))}
												<PaginationItem>
													<PaginationNext
														onClick={() => setPage(Math.min(totalPages, safePage + 1))}
														aria-disabled={safePage >= totalPages}
														className={
															safePage >= totalPages
																? "pointer-events-none opacity-50"
																: "cursor-pointer"
														}
													/>
												</PaginationItem>
											</PaginationContent>
										</Pagination>
									)}
								</>
							) : (
								<ButlerEmpty scene="bookshelf" messageKey="empty.noMemories" />
							)}
						</>
					);
				})()}

			{/* Gaps section */}
			{(gapsData?.entries?.length ?? 0) > 0 && (
				<GapsSection entries={gapsData!.entries} />
			)}

			{/* Detail drawer */}
			<DetailDrawer
				open={!!selected}
				onClose={() => setSelected(null)}
				title={selected ? formatLabel(selected.label).title : ""}
			>
				{selected && <KnowledgeDrawerContent entry={selected} onClose={() => setSelected(null)} />}
			</DetailDrawer>
		</div>
	);
}

function StatsBar({ stats }: { stats: KnowledgeStats }) {
	const { t } = useI18n();
	return (
		<div className="flex items-center gap-3 text-xs text-muted-foreground">
			<span>
				{stats.total} {t("knowledge.entries")}
			</span>
			<Separator orientation="vertical" className="h-3" />
			<StatDot
				count={stats.bySubType.decision ?? 0}
				color={SUB_TYPE_COLORS.decision!}
				label="decision"
			/>
			<StatDot
				count={stats.bySubType.pattern ?? 0}
				color={SUB_TYPE_COLORS.pattern!}
				label="pattern"
			/>
			<StatDot count={stats.bySubType.rule ?? 0} color={SUB_TYPE_COLORS.rule!} label="rule" />
		</div>
	);
}

function StatDot({ count, color, label }: { count: number; color: string; label: string }) {
	return (
		<span className="flex items-center gap-1">
			<span className="size-1.5 rounded-full" style={{ backgroundColor: color }} />
			<span>{count}</span>
			<span className="text-muted-foreground/60">{label}</span>
		</span>
	);
}

// --- Knowledge Gaps Section ---

import type { KnowledgeGapEntry } from "@/lib/api";

function GapsSection({ entries }: { entries: KnowledgeGapEntry[] }) {
	const { t } = useI18n();
	const [open, setOpen] = useState(false);

	return (
		<div className="rounded-organic border border-border/60 bg-card py-3 px-4">
			<button
				type="button"
				onClick={() => setOpen(!open)}
				className="flex w-full items-center justify-between text-sm font-semibold"
			>
				<span>{t("knowledge.gaps.title")} ({entries.length})</span>
				<span className="text-muted-foreground text-xs">{open ? "▲" : "▼"}</span>
			</button>
			{open && (
				<div className="mt-3 space-y-1.5">
					{entries.slice(0, 20).map((g, i) => (
						<div key={i} className="flex items-center gap-3 text-[11px] border-b border-border/20 last:border-0 py-1">
							<span className="text-muted-foreground font-mono w-10 shrink-0">{g.best_score.toFixed(2)}</span>
							<span className="truncate flex-1">{g.query}</span>
							<span className="text-muted-foreground/60 shrink-0">{new Date(g.timestamp).toLocaleDateString()}</span>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
