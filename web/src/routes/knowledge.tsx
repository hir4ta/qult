import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
	knowledgeQueryOptions,
	knowledgeSearchQueryOptions,
	knowledgeStatsQueryOptions,
	useToggleEnabledMutation,
} from "@/lib/api";
import { contentPreview, formatDate, formatLabel } from "@/lib/format";
import type { KnowledgeEntry, KnowledgeStats } from "@/lib/types";
import { SUB_TYPE_COLORS } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Archive, ArchiveRestore, BookOpen, Flame, Gavel, Lightbulb, Search, Shield } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";

export const Route = createFileRoute("/knowledge")({
	component: KnowledgePage,
});

function KnowledgePage() {
	const [searchInput, setSearchInput] = useState("");
	const [debouncedSearch, setDebouncedSearch] = useState("");
	const [localFilter, setLocalFilter] = useState("");
	const [selected, setSelected] = useState<KnowledgeEntry | null>(null);
	const timerRef = useRef<ReturnType<typeof setTimeout>>(null);
	const isSearching = debouncedSearch.length > 0;

	const handleSearchChange = useCallback((value: string) => {
		setSearchInput(value);
		if (timerRef.current) clearTimeout(timerRef.current);
		timerRef.current = setTimeout(() => setDebouncedSearch(value), 300);
	}, []);

	useEffect(() => {
		return () => {
			if (timerRef.current) clearTimeout(timerRef.current);
		};
	}, []);

	const { data: browseData, isLoading: browseLoading } = useQuery(knowledgeQueryOptions());
	const { data: searchData, isLoading: searchLoading } = useQuery(
		knowledgeSearchQueryOptions(debouncedSearch),
	);
	const { data: statsData } = useQuery(knowledgeStatsQueryOptions());

	const entries = isSearching ? (searchData?.entries ?? []) : (browseData?.entries ?? []);
	const filtered = localFilter
		? entries.filter(
				(e) =>
					e.label.toLowerCase().includes(localFilter.toLowerCase()) ||
					e.content.toLowerCase().includes(localFilter.toLowerCase()),
			)
		: entries;
	const isLoading = isSearching ? searchLoading : browseLoading;

	return (
		<div className="space-y-5">
			{/* Search + stats */}
			<div className="flex items-center gap-4">
				<div className="relative flex-1 max-w-sm">
					<Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
					<Input
						placeholder="Semantic search..."
						value={searchInput}
						onChange={(e) => handleSearchChange(e.target.value)}
						className="pl-9"
					/>
				</div>
				<Input
					placeholder="Filter..."
					value={localFilter}
					onChange={(e) => setLocalFilter(e.target.value)}
					className="w-32"
				/>
				{statsData && (
					<StatsBar stats={statsData} isSearching={isSearching} searchData={searchData} />
				)}
			</div>

			{/* Grid */}
			{isLoading ? (
				<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
					{Array.from({ length: 9 }).map((_, i) => (
						<Skeleton key={i} className="h-28 rounded-xl" />
					))}
				</div>
			) : filtered.length > 0 ? (
				<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
					{filtered.map((entry) => (
						<KnowledgeCard key={entry.id} entry={entry} onSelect={() => setSelected(entry)} />
					))}
				</div>
			) : (
				<div className="flex h-40 items-center justify-center">
					<p className="text-sm text-muted-foreground">
						{isSearching ? "No results found." : "No memories yet."}
					</p>
				</div>
			)}

			{/* Detail dialog */}
			<KnowledgeDialog entry={selected} onClose={() => setSelected(null)} />
		</div>
	);
}

function StatsBar({
	stats,
	isSearching,
	searchData,
}: {
	stats: KnowledgeStats;
	isSearching: boolean;
	searchData?: { entries: KnowledgeEntry[]; method: string; partial: boolean };
}) {
	return (
		<div className="flex items-center gap-3 text-xs text-muted-foreground">
			{isSearching && searchData ? (
				<>
					<span>
						{searchData.entries.length} results via {searchData.method}
					</span>
					{searchData.partial && <span style={{ color: "#e67e22" }}>(timeout)</span>}
				</>
			) : (
				<>
					<span>{stats.total} memories</span>
					<Separator orientation="vertical" className="h-3" />
					<StatDot count={stats.bySubType.decision ?? 0} color={SUB_TYPE_COLORS.decision!} />
					<StatDot count={stats.bySubType.pattern ?? 0} color={SUB_TYPE_COLORS.pattern!} />
					<StatDot count={stats.bySubType.rule ?? 0} color={SUB_TYPE_COLORS.rule!} />
					<StatDot count={stats.bySubType.general ?? 0} color={SUB_TYPE_COLORS.general!} />
				</>
			)}
		</div>
	);
}

function StatDot({ count, color }: { count: number; color: string }) {
	return (
		<span className="flex items-center gap-1">
			<span className="size-1.5 rounded-full" style={{ backgroundColor: color }} />
			{count}
		</span>
	);
}

const SUB_TYPE_ICONS: Record<string, React.ReactNode> = {
	rule: <Shield className="size-3.5" />,
	decision: <Gavel className="size-3.5" />,
	pattern: <Lightbulb className="size-3.5" />,
	general: <BookOpen className="size-3.5" />,
	project: <Flame className="size-3.5" />,
};

const SUB_TYPE_LABELS: Record<string, string> = {
	rule: "Rule",
	decision: "Decision",
	pattern: "Pattern",
	general: "General",
	project: "Project",
};

function KnowledgeCard({
	entry,
	onSelect,
}: {
	entry: KnowledgeEntry;
	onSelect: () => void;
}) {
	const { title, source } = formatLabel(entry.label);
	const color = SUB_TYPE_COLORS[entry.sub_type] ?? SUB_TYPE_COLORS.general!;
	const toggleMutation = useToggleEnabledMutation();
	const icon = SUB_TYPE_ICONS[entry.sub_type] ?? SUB_TYPE_ICONS.general;

	return (
		<Card
			className={cn(
				"cursor-pointer border-stone-200 transition-all hover:border-stone-300 hover:shadow-md dark:border-stone-700 dark:hover:border-stone-600",
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
							{SUB_TYPE_LABELS[entry.sub_type] ?? entry.sub_type}
						</span>
					</div>
					<div className="flex items-center gap-3">
						{entry.hit_count > 0 && (
							<span className="text-[10px] tabular-nums text-muted-foreground">
								{entry.hit_count} hits
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
									{entry.enabled ? <Archive className="size-3.5" /> : <ArchiveRestore className="size-3.5" />}
								</button>
							</TooltipTrigger>
							<TooltipContent>{entry.enabled ? "Archive (exclude from search)" : "Restore to search"}</TooltipContent>
						</Tooltip>
					</div>
				</div>
				<p className="text-sm font-medium leading-snug line-clamp-2">{title}</p>
				<p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">
					{contentPreview(entry.content, 100)}
				</p>
				<div className="flex items-center gap-2 text-[10px] text-muted-foreground">
					{source && <span className="truncate max-w-[140px]">{source}</span>}
					{source && <span>·</span>}
					<span>{formatDate(entry.saved_at ?? "")}</span>
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
	if (!entry) return null;

	const { title, source } = formatLabel(entry.label);
	const color = SUB_TYPE_COLORS[entry.sub_type] ?? SUB_TYPE_COLORS.general!;
	const icon = SUB_TYPE_ICONS[entry.sub_type] ?? SUB_TYPE_ICONS.general;
	const fields = parseDecisionFields(entry.content);
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
								{SUB_TYPE_LABELS[entry.sub_type] ?? entry.sub_type}
							</span>
							{source && (
								<span className="text-xs text-muted-foreground">· {source}</span>
							)}
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
							<span>Saved {formatDate(entry.saved_at ?? "")}</span>
							<Tooltip>
								<TooltipTrigger asChild>
									<span className="cursor-help tabular-nums">{entry.hit_count} hits</span>
								</TooltipTrigger>
								<TooltipContent>Search result appearances (5+: pattern candidate, 15+: rule candidate)</TooltipContent>
							</Tooltip>
							<Badge
								variant="outline"
								className="text-[10px] px-1.5 py-0 rounded-full"
								style={{
									borderColor: entry.enabled ? "rgba(45,139,122,0.3)" : "rgba(107,114,128,0.3)",
									color: entry.enabled ? "#2d8b7a" : "#6b7280",
								}}
							>
								{entry.enabled ? "Active" : "Archived"}
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
										<Archive className="size-3.5" /> Archive
									</>
								) : (
									<>
										<ArchiveRestore className="size-3.5" /> Restore
									</>
								)}
							</Button>
						</div>
					</DialogDescription>
				</DialogHeader>

				<Separator />

				<ScrollArea className="flex-1 -mx-6 px-6">
					<div className="prose prose-sm prose-stone dark:prose-invert max-w-none py-3
						prose-headings:text-sm prose-headings:font-semibold
						prose-p:text-sm prose-p:leading-relaxed prose-p:my-1
						prose-li:text-sm prose-li:my-0.5
						prose-code:text-xs prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:rounded
						prose-strong:font-semibold">
						<Markdown>{cleanContent(entry.content)}</Markdown>
					</div>
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

function cleanContent(content: string): string {
	return content
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
}
