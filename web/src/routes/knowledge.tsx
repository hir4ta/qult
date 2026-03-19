import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Grid3x3, Network, Search } from "lucide-react";
import { useState } from "react";
import { KnowledgeCard } from "@/components/knowledge-card";
import { KnowledgeDialog } from "@/components/knowledge-detail";
import { KnowledgeGraph } from "@/components/knowledge-graph";
import { Input } from "@/components/ui/input";
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
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
	graphEdgesQueryOptions,
	knowledgeQueryOptions,
	knowledgeStatsQueryOptions,
} from "@/lib/api";
import { formatLabel } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import type { KnowledgeEntry, KnowledgeStats } from "@/lib/types";
import { SUB_TYPE_COLORS } from "@/lib/types";

export const Route = createFileRoute("/knowledge")({
	component: KnowledgePage,
});

function KnowledgePage() {
	const { t } = useI18n();
	const [localFilter, setLocalFilter] = useState("");
	const [selected, setSelected] = useState<KnowledgeEntry | null>(null);
	const [view, setView] = useState<"grid" | "graph">("grid");
	const [page, setPage] = useState(1);

	const { data: browseData, isLoading } = useQuery(knowledgeQueryOptions());
	const { data: statsData } = useQuery(knowledgeStatsQueryOptions());
	const {
		data: graphData,
		isLoading: graphLoading,
		isError: graphError,
	} = useQuery({
		...graphEdgesQueryOptions(),
		enabled: view === "graph",
	});

	const entries = browseData?.entries ?? [];
	const filtered = localFilter
		? entries.filter(
				(e) =>
					e.label.toLowerCase().includes(localFilter.toLowerCase()) ||
					e.content.toLowerCase().includes(localFilter.toLowerCase()),
			)
		: entries;

	const showGraph = view === "graph";
	const minEntriesForGraph = 5;
	const hasEnoughEntries = entries.length >= minEntriesForGraph;

	return (
		<div className="space-y-5">
			{/* Filter + stats + view toggle */}
			<div className="flex items-center gap-4">
				{!showGraph && (
					<div className="relative flex-1 max-w-sm">
						<Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
						<Input
							placeholder={t("knowledge.filter")}
							value={localFilter}
							onChange={(e) => {
								setLocalFilter(e.target.value);
								setPage(1);
							}}
							className="pl-9"
						/>
					</div>
				)}
				<div className="flex-1" />
				{statsData && <StatsBar stats={statsData} />}
				<ToggleGroup
					type="single"
					value={view}
					onValueChange={(v) => {
						if (v) setView(v as "grid" | "graph");
					}}
					className="h-8"
				>
					<ToggleGroupItem
						value="grid"
						aria-label={t("knowledge.viewGrid")}
						className="h-8 px-2.5 gap-1.5 text-xs"
					>
						<Grid3x3 className="size-3.5" />
						{t("knowledge.viewGrid")}
					</ToggleGroupItem>
					<ToggleGroupItem
						value="graph"
						aria-label={t("knowledge.viewGraph")}
						className="h-8 px-2.5 gap-1.5 text-xs"
					>
						<Network className="size-3.5" />
						{t("knowledge.viewGraph")}
					</ToggleGroupItem>
				</ToggleGroup>
			</div>

			{/* Graph view */}
			{showGraph &&
				(!hasEnoughEntries ? (
					<div className="flex h-[70vh] items-center justify-center rounded-xl border border-dashed border-border">
						<p className="text-sm text-muted-foreground">{t("knowledge.graphMinEntries")}</p>
					</div>
				) : graphLoading ? (
					<div className="flex h-[70vh] items-center justify-center rounded-xl border border-dashed border-border">
						<p className="text-sm text-muted-foreground">{t("knowledge.graphLoading")}</p>
					</div>
				) : graphError ? (
					<div className="flex h-[70vh] items-center justify-center rounded-xl border border-dashed border-border">
						<p className="text-sm text-muted-foreground">{t("knowledge.graphError")}</p>
					</div>
				) : graphData ? (
					<div className="space-y-2">
						<KnowledgeGraph
							nodes={entries.map((e) => ({
								id: e.id,
								label: formatLabel(e.label).title,
								sub_type: e.sub_type,
								hit_count: e.hit_count,
							}))}
							edges={graphData.edges}
							onNodeClick={(node) => {
								const entry = entries.find((e) => e.id === node.id);
								if (entry) setSelected(entry);
							}}
						/>
						<div className="flex items-center gap-3 text-[10px] text-muted-foreground">
							<span>
								{t("knowledge.graphMethod")} {graphData.method}
							</span>
							{graphData.truncated && (
								<>
									<Separator orientation="vertical" className="h-3" />
									<span>{t("knowledge.graphTruncated")}</span>
								</>
							)}
						</div>
					</div>
				) : null)}

			{/* Grid view */}
			{!showGraph &&
				(() => {
					const perPage = 9;
					const totalPages = Math.ceil(filtered.length / perPage);
					const safePage = Math.min(page, Math.max(1, totalPages));
					const paged = filtered.slice((safePage - 1) * perPage, safePage * perPage);
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
									<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
										{paged.map((entry) => (
											<KnowledgeCard
												key={entry.id}
												entry={entry}
												onSelect={() => setSelected(entry)}
											/>
										))}
									</div>
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
								<div className="flex h-40 items-center justify-center">
									<p className="text-sm text-muted-foreground">{t("knowledge.noMemories")}</p>
								</div>
							)}
						</>
					);
				})()}

			{/* Detail dialog */}
			<KnowledgeDialog entry={selected} onClose={() => setSelected(null)} />
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
