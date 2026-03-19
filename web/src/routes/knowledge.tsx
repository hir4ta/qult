import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Archive, ArchiveRestore, BookOpen, Gavel, Lightbulb, Search, Shield } from "lucide-react";
import { useState } from "react";
import Markdown from "react-markdown";
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
	knowledgeStatsQueryOptions,
	useToggleEnabledMutation,
} from "@/lib/api";
import { contentPreview, formatDate, formatLabel } from "@/lib/format";
import type { KnowledgeEntry, KnowledgeStats } from "@/lib/types";
import { SUB_TYPE_COLORS } from "@/lib/types";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/knowledge")({
	component: KnowledgePage,
});

function KnowledgePage() {
	const { t } = useI18n();
	const [localFilter, setLocalFilter] = useState("");
	const [selected, setSelected] = useState<KnowledgeEntry | null>(null);

	const { data: browseData, isLoading } = useQuery(knowledgeQueryOptions());
	const { data: statsData } = useQuery(knowledgeStatsQueryOptions());

	const entries = browseData?.entries ?? [];
	const filtered = localFilter
		? entries.filter(
				(e) =>
					e.label.toLowerCase().includes(localFilter.toLowerCase()) ||
					e.content.toLowerCase().includes(localFilter.toLowerCase()),
			)
		: entries;

	return (
		<div className="space-y-5">
			{/* Filter + stats */}
			<div className="flex items-center gap-4">
				<div className="relative flex-1 max-w-sm">
					<Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
					<Input
						placeholder={t("knowledge.filter")}
						value={localFilter}
						onChange={(e) => setLocalFilter(e.target.value)}
						className="pl-9"
					/>
				</div>
				{statsData && <StatsBar stats={statsData} />}
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
					<p className="text-sm text-muted-foreground">{t("knowledge.noMemories")}</p>
				</div>
			)}

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
					<div
						className="prose prose-sm prose-stone dark:prose-invert max-w-none py-3
						prose-headings:text-sm prose-headings:font-semibold
						prose-p:text-sm prose-p:leading-relaxed prose-p:my-1
						prose-li:text-sm prose-li:my-0.5
						prose-code:text-xs prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:rounded
						prose-strong:font-semibold"
					>
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
