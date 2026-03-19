import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Archive, ArchiveRestore, BookOpen, Gavel, Grid3x3, Lightbulb, Network, Search, Shield } from "lucide-react";
import { useState } from "react";
import Markdown from "react-markdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
	Pagination,
	PaginationContent,
	PaginationItem,
	PaginationLink,
	PaginationNext,
	PaginationPrevious,
} from "@/components/ui/pagination";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
	graphEdgesQueryOptions,
	knowledgeQueryOptions,
	knowledgeStatsQueryOptions,
	useToggleEnabledMutation,
} from "@/lib/api";
import { contentPreview, formatDate, formatLabel } from "@/lib/format";
import type { KnowledgeEntry, KnowledgeStats } from "@/lib/types";
import { SUB_TYPE_COLORS } from "@/lib/types";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { KnowledgeGraph } from "@/components/knowledge-graph";

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
	const { data: graphData, isLoading: graphLoading, isError: graphError } = useQuery({
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
							onChange={(e) => { setLocalFilter(e.target.value); setPage(1); }}
							className="pl-9"
						/>
					</div>
				)}
				<div className="flex-1" />
				{statsData && <StatsBar stats={statsData} />}
				<ToggleGroup
					type="single"
					value={view}
					onValueChange={(v) => { if (v) setView(v as "grid" | "graph"); }}
					className="h-8"
				>
					<ToggleGroupItem value="grid" aria-label={t("knowledge.viewGrid")} className="h-8 px-2.5 gap-1.5 text-xs">
						<Grid3x3 className="size-3.5" />
						{t("knowledge.viewGrid")}
					</ToggleGroupItem>
					<ToggleGroupItem value="graph" aria-label={t("knowledge.viewGraph")} className="h-8 px-2.5 gap-1.5 text-xs">
						<Network className="size-3.5" />
						{t("knowledge.viewGraph")}
					</ToggleGroupItem>
				</ToggleGroup>
			</div>

			{/* Graph view */}
			{showGraph && (
				<>
					{!hasEnoughEntries ? (
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
								<span>{t("knowledge.graphMethod")} {graphData.method}</span>
								{graphData.truncated && (
									<>
										<Separator orientation="vertical" className="h-3" />
										<span>{t("knowledge.graphTruncated")}</span>
									</>
								)}
							</div>
						</div>
					) : null}
				</>
			)}

			{/* Grid view */}
			{!showGraph && (() => {
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
										<KnowledgeCard key={entry.id} entry={entry} onSelect={() => setSelected(entry)} />
									))}
								</div>
								{totalPages > 1 && (
									<Pagination>
										<PaginationContent>
											<PaginationItem>
												<PaginationPrevious
													onClick={() => setPage(Math.max(1, safePage - 1))}
													aria-disabled={safePage <= 1}
													className={safePage <= 1 ? "pointer-events-none opacity-50" : "cursor-pointer"}
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
													className={safePage >= totalPages ? "pointer-events-none opacity-50" : "cursor-pointer"}
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
			<span>{stats.total} {t("knowledge.entries")}</span>
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

const SUB_TYPE_ICONS: Record<string, React.ReactNode> = {
	rule: <Shield className="size-3.5" />,
	decision: <Gavel className="size-3.5" />,
	pattern: <Lightbulb className="size-3.5" />,
	snapshot: <BookOpen className="size-3.5" />,
};

const SUB_TYPE_LABEL_KEYS: Record<string, "knowledge.rule" | "knowledge.decision" | "knowledge.pattern" | "knowledge.snapshot"> = {
	rule: "knowledge.rule",
	decision: "knowledge.decision",
	pattern: "knowledge.pattern",
	snapshot: "knowledge.snapshot",
};

function KnowledgeCard({ entry, onSelect }: { entry: KnowledgeEntry; onSelect: () => void }) {
	const { t, locale } = useI18n();
	const { title } = formatLabel(entry.label);
	const color = SUB_TYPE_COLORS[entry.sub_type] ?? SUB_TYPE_COLORS.snapshot!;
	const toggleMutation = useToggleEnabledMutation();
	const icon = SUB_TYPE_ICONS[entry.sub_type] ?? SUB_TYPE_ICONS.snapshot;

	return (
		<Card
			className={cn(
				"cursor-pointer border-stone-200 transition-[border-color,transform] duration-200 hover:border-stone-300 hover:-translate-y-0.5 dark:border-stone-700 dark:hover:border-stone-600",
				!entry.enabled && "opacity-40",
			)}
			onClick={onSelect}
		>
			<CardContent className="p-4 space-y-2.5">
				<div className="flex items-center justify-between gap-2">
					<div className="flex items-center gap-2">
						<div
							className="flex size-6 items-center justify-center rounded-md"
							style={{ backgroundColor: `${color}18`, color }}
						>
							{icon}
						</div>
						<span className="text-[11px] font-medium" style={{ color }}>
							{SUB_TYPE_LABEL_KEYS[entry.sub_type] ? t(SUB_TYPE_LABEL_KEYS[entry.sub_type]) : entry.sub_type}
						</span>
					</div>
					<div className="flex items-center gap-3">
						{entry.hit_count > 0 && (
							<span className="text-[10px] tabular-nums text-muted-foreground">
								{entry.hit_count} {t("knowledge.hits")}
							</span>
						)}
						<Tooltip>
							<TooltipTrigger asChild>
								<button
									type="button"
									onClick={(e) => {
										e.stopPropagation();
										toggleMutation.mutate({ id: entry.id, enabled: !entry.enabled });
									}}
									className="transition-colors hover:opacity-70"
									style={{ color: "#7b6b8d" }}
								>
									{entry.enabled ? (
										<Archive className="size-3.5" />
									) : (
										<ArchiveRestore className="size-3.5" />
									)}
								</button>
							</TooltipTrigger>
							<TooltipContent>
								{entry.enabled ? t("knowledge.archiveHint") : t("knowledge.restoreHint")}
							</TooltipContent>
						</Tooltip>
					</div>
				</div>
				<p className="text-sm font-medium leading-snug line-clamp-2">{title}</p>
				<p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">
					{contentPreview(entry.content, 100)}
				</p>
				<div className="flex items-center gap-2 text-[10px] text-muted-foreground">
					{entry.project_name && (
						<>
							<span className="font-medium" style={{ color: "#40513b" }}>
								{entry.project_name}
							</span>
							<span>·</span>
						</>
					)}
					<span>{formatDate(entry.saved_at ?? "", locale)}</span>
				</div>
			</CardContent>
		</Card>
	);
}

function KnowledgeDialog({
	entry,
	onClose,
}: {
	entry: KnowledgeEntry | null;
	onClose: () => void;
}) {
	const { t, locale } = useI18n();
	if (!entry) return null;

	const { title, source } = formatLabel(entry.label);
	const color = SUB_TYPE_COLORS[entry.sub_type] ?? SUB_TYPE_COLORS.snapshot!;
	const icon = SUB_TYPE_ICONS[entry.sub_type] ?? SUB_TYPE_ICONS.snapshot;
	const _fields = parseDecisionFields(entry.content);
	const toggleMutation = useToggleEnabledMutation();

	return (
		<Dialog open={!!entry} onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
				<DialogHeader>
					<div className="flex items-center gap-3 mb-2">
						<div
							className="flex size-8 items-center justify-center rounded-lg"
							style={{ backgroundColor: `${color}18`, color }}
						>
							{icon}
						</div>
						<div className="flex items-center gap-2">
							<span className="text-xs font-semibold" style={{ color }}>
								{SUB_TYPE_LABEL_KEYS[entry.sub_type] ? t(SUB_TYPE_LABEL_KEYS[entry.sub_type]) : entry.sub_type}
							</span>
							{source && <span className="text-xs text-muted-foreground">· {source}</span>}
						</div>
					</div>
					<DialogTitle
						className="text-lg leading-snug"
						style={{ fontFamily: "var(--font-display)" }}
					>
						{title}
					</DialogTitle>
					<DialogDescription asChild>
						<div className="flex items-center gap-4 text-xs text-muted-foreground mt-1">
							<span>{t("knowledge.saved")} {formatDate(entry.saved_at ?? "", locale)}</span>
							<Tooltip>
								<TooltipTrigger asChild>
									<span className="cursor-help tabular-nums">{entry.hit_count} {t("knowledge.hits")}</span>
								</TooltipTrigger>
								<TooltipContent className="text-left">
									<p>{t("knowledge.searchAppearances")}</p>
									<p className="opacity-75">{t("knowledge.patternCandidate")}</p>
									<p className="opacity-75">{t("knowledge.ruleCandidate")}</p>
								</TooltipContent>
							</Tooltip>
							<Badge
								variant="outline"
								className="text-[10px] px-1.5 py-0 rounded-full"
								style={{
									borderColor: entry.enabled ? "rgba(45,139,122,0.3)" : "rgba(107,114,128,0.3)",
									color: entry.enabled ? "#2d8b7a" : "#6b7280",
								}}
							>
								{entry.enabled ? t("knowledge.active") : t("knowledge.archived")}
							</Badge>
							<Button
								size="sm"
								variant="ghost"
								className="ml-auto h-7 gap-1.5 text-xs"
								style={{ color: "#7b6b8d" }}
								onClick={() => toggleMutation.mutate({ id: entry.id, enabled: !entry.enabled })}
							>
								{entry.enabled ? (
									<>
										<Archive className="size-3.5" /> {t("knowledge.archive")}
									</>
								) : (
									<>
										<ArchiveRestore className="size-3.5" /> {t("knowledge.restore")}
									</>
								)}
							</Button>
						</div>
					</DialogDescription>
				</DialogHeader>

				<Separator />

				<ScrollArea className="flex-1 -mx-6 px-6">
					<KnowledgeBody content={entry.content} subType={entry.sub_type} />
				</ScrollArea>
			</DialogContent>
		</Dialog>
	);
}

function parseDecisionFields(content: string): { key: string; value: string }[] {
	const fields: { key: string; value: string }[] = [];
	for (const line of content.split("\n")) {
		const match = line.match(/^-\s*\*\*([^*]+)\*\*:?\s*(.+)/);
		if (match?.[1] && match[2]) {
			fields.push({ key: match[1], value: match[2] });
		}
	}
	return fields;
}

function KnowledgeSection({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="space-y-1">
			<p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">{label}</p>
			<div className="text-sm leading-relaxed">{children}</div>
		</div>
	);
}

function KnowledgeBody({ content, subType }: { content: string; subType: string }) {
	let data: Record<string, unknown> | null = null;
	try {
		const parsed = JSON.parse(content);
		if (typeof parsed === "object" && parsed !== null) data = parsed;
	} catch { /* not JSON */ }

	if (!data) {
		return (
			<div className="prose prose-sm prose-stone dark:prose-invert max-w-none py-3 prose-p:text-sm prose-p:leading-relaxed">
				<Markdown>{cleanContent(content)}</Markdown>
			</div>
		);
	}

	const tags = Array.isArray(data.tags) ? (data.tags as string[]) : [];

	return (
		<div className="space-y-4 py-3">
			{subType === "decision" && <DecisionBody data={data} />}
			{subType === "pattern" && <PatternBody data={data} />}
			{subType === "rule" && <RuleBody data={data} />}
			{!["decision", "pattern", "rule"].includes(subType) && <GenericBody data={data} />}

			{tags.length > 0 && (
				<div className="flex flex-wrap gap-1.5 pt-1">
					{tags.map((tag) => (
						<Badge key={tag} variant="outline" className="text-[10px] px-2 py-0 rounded-full font-normal">
							{tag}
						</Badge>
					))}
				</div>
			)}
		</div>
	);
}

function DecisionBody({ data }: { data: Record<string, unknown> }) {
	const { t } = useI18n();
	const alts = Array.isArray(data.alternatives) ? data.alternatives as string[] : data.alternatives ? [String(data.alternatives)] : [];
	return (
		<>
			{data.context && <KnowledgeSection label={t("knowledge.detail.context")}><p>{String(data.context)}</p></KnowledgeSection>}
			{data.decision && (
				<KnowledgeSection label={t("knowledge.detail.decision")}>
					<p className="font-medium" style={{ color: SUB_TYPE_COLORS.decision }}>{String(data.decision)}</p>
				</KnowledgeSection>
			)}
			{data.reasoning && <KnowledgeSection label={t("knowledge.detail.reasoning")}><p>{String(data.reasoning)}</p></KnowledgeSection>}
			{alts.length > 0 && (
				<KnowledgeSection label={t("knowledge.detail.alternatives")}>
					<ul className="list-disc pl-4 space-y-0.5 text-muted-foreground">
						{alts.map((a, i) => <li key={i}>{a}</li>)}
					</ul>
				</KnowledgeSection>
			)}
		</>
	);
}

function PatternBody({ data }: { data: Record<string, unknown> }) {
	const { t } = useI18n();
	const patternType = data.type ? String(data.type) : null;
	return (
		<>
			{data.context && <KnowledgeSection label={t("knowledge.detail.context")}><p>{String(data.context)}</p></KnowledgeSection>}
			{patternType && (
				<div>
					<Badge
						variant="outline"
						className="text-[10px] px-2 py-0 rounded-full"
						style={{
							borderColor: patternType === "good" ? "#2d8b7a40" : patternType === "bad" ? "#c0392b40" : "#e67e2240",
							color: patternType === "good" ? "#2d8b7a" : patternType === "bad" ? "#c0392b" : "#e67e22",
						}}
					>
						{patternType}
					</Badge>
				</div>
			)}
			{data.pattern && (
				<KnowledgeSection label={t("knowledge.detail.pattern")}>
					<p className="font-medium" style={{ color: SUB_TYPE_COLORS.pattern }}>{String(data.pattern)}</p>
				</KnowledgeSection>
			)}
			{data.applicationConditions && <KnowledgeSection label={t("knowledge.detail.whenToApply")}><p>{String(data.applicationConditions)}</p></KnowledgeSection>}
			{data.expectedOutcomes && <KnowledgeSection label={t("knowledge.detail.expectedOutcomes")}><p>{String(data.expectedOutcomes)}</p></KnowledgeSection>}
		</>
	);
}

function RuleBody({ data }: { data: Record<string, unknown> }) {
	const { t } = useI18n();
	const priority = data.priority ? String(data.priority) : null;
	return (
		<>
			{data.text && (
				<KnowledgeSection label={t("knowledge.detail.rule")}>
					<p className="font-medium" style={{ color: SUB_TYPE_COLORS.rule }}>{String(data.text)}</p>
				</KnowledgeSection>
			)}
			{data.rationale && <KnowledgeSection label={t("knowledge.detail.rationale")}><p>{String(data.rationale)}</p></KnowledgeSection>}
			<div className="flex items-center gap-3">
				{data.category && (
					<Badge variant="outline" className="text-[10px] px-2 py-0 rounded-full font-normal">
						{String(data.category)}
					</Badge>
				)}
				{priority && (
					<Badge
						variant="outline"
						className="text-[10px] px-2 py-0 rounded-full font-medium"
						style={{
							borderColor: priority === "p0" ? "#c0392b40" : priority === "p1" ? "#e67e2240" : "#2d8b7a40",
							color: priority === "p0" ? "#c0392b" : priority === "p1" ? "#e67e22" : "#2d8b7a",
						}}
					>
						{priority}
					</Badge>
				)}
			</div>
		</>
	);
}

function GenericBody({ data }: { data: Record<string, unknown> }) {
	const skipKeys = new Set(["id", "title", "createdAt", "status", "lang", "tags"]);
	return (
		<>
			{Object.entries(data).map(([key, val]) => {
				if (skipKeys.has(key) || typeof val !== "string" || !val) return null;
				return <KnowledgeSection key={key} label={key}><p>{val}</p></KnowledgeSection>;
			})}
		</>
	);
}

function cleanContent(content: string): string {
	const cleaned = content
		.split("\n")
		.filter(
			(l) =>
				!l.startsWith("# ") &&
				!l.startsWith("## ") &&
				!l.startsWith("<!-- ") &&
				!l.match(/^-\s*\*\*Status\*\*/),
		)
		.map((l) => {
			// Convert bare `- content` (single item, not a list) to plain text.
			if (l.match(/^-\s+/) && !l.match(/^-\s+\*\*/)) {
				return l.replace(/^-\s+/, "");
			}
			return l;
		})
		.join("\n")
		.trim();

	// Break long single-line content at sentence boundaries for readability.
	// Only applies when the entire content is a single paragraph (no existing newlines).
	if (!cleaned.includes("\n") && cleaned.length > 120) {
		return cleaned.replace(/。/g, "。\n\n").replace(/\.\s+/g, ".\n\n");
	}
	return cleaned;
}
