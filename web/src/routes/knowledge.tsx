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
import { Eye, EyeOff, Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

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

	return (
		<Card
			className={cn(
				"cursor-pointer border-stone-200 transition-all hover:border-stone-300 hover:shadow-md dark:border-stone-700 dark:hover:border-stone-600",
				!entry.enabled && "opacity-40",
			)}
			onClick={onSelect}
		>
			<CardContent className="p-4 space-y-2">
				<div className="flex items-start justify-between gap-2">
					<Badge
						variant="outline"
						className="shrink-0 rounded-full text-[10px] px-1.5 py-0"
						style={{ borderColor: `${color}50`, color }}
					>
						{entry.sub_type}
					</Badge>
					<div className="flex items-center gap-1.5">
						{entry.score ? (
							<span className="text-[10px] tabular-nums text-muted-foreground">
								{entry.score.toFixed(2)}
							</span>
						) : null}
						<Tooltip>
							<TooltipTrigger asChild>
								<button
									type="button"
									onClick={(e) => {
										e.stopPropagation();
										toggleMutation.mutate({ id: entry.id, enabled: !entry.enabled });
									}}
									className="text-muted-foreground hover:text-foreground transition-colors"
								>
									{entry.enabled ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
								</button>
							</TooltipTrigger>
							<TooltipContent>{entry.enabled ? "Disable" : "Enable"}</TooltipContent>
						</Tooltip>
					</div>
				</div>
				<p className="text-sm font-medium leading-snug line-clamp-2">{title}</p>
				<p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">
					{contentPreview(entry.content, 100)}
				</p>
				<div className="flex items-center gap-2 text-[10px] text-muted-foreground pt-1">
					{source && <span className="truncate max-w-[120px]">{source}</span>}
					{source && <span>·</span>}
					<span>{formatDate(entry.saved_at ?? "")}</span>
					{entry.hit_count > 0 && (
						<>
							<span>·</span>
							<span>{entry.hit_count} hits</span>
						</>
					)}
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
	const fields = parseDecisionFields(entry.content);
	const toggleMutation = useToggleEnabledMutation();

	return (
		<Dialog open={!!entry} onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
				<DialogHeader>
					<div className="flex items-center gap-2 mb-1">
						<Badge
							variant="outline"
							className="rounded-full text-xs"
							style={{ borderColor: `${color}50`, color }}
						>
							{entry.sub_type}
						</Badge>
						{source && <span className="text-xs text-muted-foreground">{source}</span>}
					</div>
					<DialogTitle
						className="text-lg leading-snug"
						style={{ fontFamily: "var(--font-display)" }}
					>
						{title}
					</DialogTitle>
					<DialogDescription asChild>
						<div className="flex items-center gap-4 text-xs text-muted-foreground">
							<span>Saved {formatDate(entry.saved_at ?? "")}</span>
							<span>{entry.hit_count} hits</span>
							<span>{entry.enabled ? "Active" : "Disabled"}</span>
							<Button
								size="sm"
								variant="ghost"
								className="ml-auto h-7 gap-1 text-xs"
								onClick={() => toggleMutation.mutate({ id: entry.id, enabled: !entry.enabled })}
							>
								{entry.enabled ? (
									<>
										<EyeOff className="size-3.5" /> Disable
									</>
								) : (
									<>
										<Eye className="size-3.5" /> Enable
									</>
								)}
							</Button>
						</div>
					</DialogDescription>
				</DialogHeader>

				<Separator />

				<ScrollArea className="flex-1 -mx-6 px-6">
					{fields.length > 0 ? (
						<div className="space-y-4 py-2">
							{fields.map((f) => (
								<div key={f.key}>
									<p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-1">
										{f.key}
									</p>
									<p className="text-sm leading-relaxed">{f.value}</p>
								</div>
							))}
						</div>
					) : (
						<pre className="whitespace-pre-wrap break-words text-sm leading-relaxed font-sans py-2">
							{cleanContent(entry.content)}
						</pre>
					)}
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
				!l.startsWith("<!-- confidence") &&
				!l.match(/^-\s*\*\*Status\*\*/),
		)
		.join("\n")
		.trim();
}
