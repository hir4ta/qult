import { Archive, ArchiveRestore } from "@animated-color-icons/lucide-react";
import Markdown from "react-markdown";
import { SUB_TYPE_ICONS, SUB_TYPE_LABEL_KEYS } from "@/components/knowledge-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { promoteKnowledge, useToggleEnabledMutation } from "@/lib/api";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { formatDate, formatLabel } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import type { KnowledgeEntry } from "@/lib/types";
import { SUB_TYPE_COLORS } from "@/lib/types";

/** Drawer content for Knowledge detail (used inside DetailDrawer). */
export function KnowledgeDrawerContent({
	entry,
	onClose,
}: {
	entry: KnowledgeEntry;
	onClose: () => void;
}) {
	const { t, locale } = useI18n();
	const toggleMutation = useToggleEnabledMutation();
	const queryClient = useQueryClient();
	const promoteMutation = useMutation({
		mutationFn: (id: number) => promoteKnowledge(id),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["knowledge"] });
			queryClient.invalidateQueries({ queryKey: ["knowledge-stats"] });
			queryClient.invalidateQueries({ queryKey: ["knowledge-candidates"] });
			onClose();
		},
	});
	const canPromote = entry.sub_type === "pattern" && (entry.hit_count ?? 0) >= 15;

	const { source } = formatLabel(entry.label);
	const color = SUB_TYPE_COLORS[entry.sub_type] ?? SUB_TYPE_COLORS.snapshot!;
	const icon = SUB_TYPE_ICONS[entry.sub_type] ?? SUB_TYPE_ICONS.snapshot;

	return (
		<>
			{/* Header metadata */}
			<div className="flex items-center gap-3">
				<div
					className="flex size-8 items-center justify-center rounded-lg"
					style={{ backgroundColor: `${color}18`, color }}
				>
					{icon}
				</div>
				<div className="flex items-center gap-2">
					<span className="text-xs font-semibold" style={{ color }}>
						{SUB_TYPE_LABEL_KEYS[entry.sub_type]
							? t(SUB_TYPE_LABEL_KEYS[entry.sub_type]!)
							: entry.sub_type}
					</span>
					{source && <span className="text-xs text-muted-foreground">· {source}</span>}
				</div>
			</div>

			{/* Metadata row with archive button */}
			<div className="flex items-center gap-3 text-xs text-muted-foreground">
				<div className="flex items-center flex-wrap gap-3 flex-1">
					<span>
						{t("knowledge.saved")} {formatDate(entry.saved_at ?? "", locale)}
					</span>
					<Tooltip>
						<TooltipTrigger asChild>
							<span className="cursor-help tabular-nums">
								{entry.hit_count} {t("knowledge.hits")}
							</span>
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
				</div>
				<Button
					size="sm"
					variant="ghost"
					className="h-7 gap-1.5 text-xs shrink-0"
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

			{/* Promote action (only when eligible) */}
			{canPromote && (
				<div className="flex items-center gap-2">
					<AlertDialog>
						<AlertDialogTrigger asChild>
							<Button size="sm" variant="outline" className="h-7 gap-1.5 text-xs" style={{ color: "#e67e22", borderColor: "rgba(230,126,34,0.3)" }}>
								{t("knowledge.promote")}
							</Button>
						</AlertDialogTrigger>
						<AlertDialogContent>
							<AlertDialogHeader>
								<AlertDialogTitle className="text-base">{t("knowledge.promoteTitle")}</AlertDialogTitle>
								<AlertDialogDescription>{t("knowledge.promoteDescription")}</AlertDialogDescription>
							</AlertDialogHeader>
							<AlertDialogFooter>
								<AlertDialogCancel>{t("task.cancel")}</AlertDialogCancel>
								<AlertDialogAction onClick={() => promoteMutation.mutate(entry.id)}>
									{t("knowledge.promote")}
								</AlertDialogAction>
							</AlertDialogFooter>
						</AlertDialogContent>
					</AlertDialog>
				</div>
			)}

			<Separator />

			{/* Body */}
			<KnowledgeBody content={entry.content} subType={entry.sub_type} />
		</>
	);
}

function KnowledgeSection({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="space-y-1">
			<p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
				{label}
			</p>
			<div className="text-sm leading-relaxed">{children}</div>
		</div>
	);
}

function KnowledgeBody({ content, subType }: { content: string; subType: string }) {
	let data: Record<string, unknown> | null = null;
	try {
		const parsed = JSON.parse(content);
		if (typeof parsed === "object" && parsed !== null) data = parsed;
	} catch {
		/* not JSON */
	}

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
						<Badge
							key={tag}
							variant="outline"
							className="text-[10px] px-2 py-0 rounded-full font-normal"
						>
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
	const alts = Array.isArray(data.alternatives)
		? (data.alternatives as string[])
		: data.alternatives
			? [String(data.alternatives)]
			: [];
	return (
		<>
			{data.context && (
				<KnowledgeSection label={t("knowledge.detail.context")}>
					<p>{String(data.context)}</p>
				</KnowledgeSection>
			)}
			{data.decision && (
				<KnowledgeSection label={t("knowledge.detail.decision")}>
					<p className="font-medium" style={{ color: SUB_TYPE_COLORS.decision }}>
						{String(data.decision)}
					</p>
				</KnowledgeSection>
			)}
			{data.reasoning && (
				<KnowledgeSection label={t("knowledge.detail.reasoning")}>
					<p>{String(data.reasoning)}</p>
				</KnowledgeSection>
			)}
			{alts.length > 0 && (
				<KnowledgeSection label={t("knowledge.detail.alternatives")}>
					<ul className="list-disc pl-4 space-y-0.5 text-muted-foreground">
						{alts.map((a, i) => (
							<li key={i}>{a}</li>
						))}
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
			{data.context && (
				<KnowledgeSection label={t("knowledge.detail.context")}>
					<p>{String(data.context)}</p>
				</KnowledgeSection>
			)}
			{patternType && (
				<div>
					<Badge
						variant="outline"
						className="text-[10px] px-2 py-0 rounded-full"
						style={{
							borderColor:
								patternType === "good"
									? "#2d8b7a40"
									: patternType === "bad"
										? "#c0392b40"
										: "#e67e2240",
							color:
								patternType === "good" ? "#2d8b7a" : patternType === "bad" ? "#c0392b" : "#e67e22",
						}}
					>
						{patternType}
					</Badge>
				</div>
			)}
			{data.pattern && (
				<KnowledgeSection label={t("knowledge.detail.pattern")}>
					<p className="font-medium" style={{ color: SUB_TYPE_COLORS.pattern }}>
						{String(data.pattern)}
					</p>
				</KnowledgeSection>
			)}
			{data.applicationConditions && (
				<KnowledgeSection label={t("knowledge.detail.whenToApply")}>
					<p>{String(data.applicationConditions)}</p>
				</KnowledgeSection>
			)}
			{data.expectedOutcomes && (
				<KnowledgeSection label={t("knowledge.detail.expectedOutcomes")}>
					<p>{String(data.expectedOutcomes)}</p>
				</KnowledgeSection>
			)}
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
					<p className="font-medium" style={{ color: SUB_TYPE_COLORS.rule }}>
						{String(data.text)}
					</p>
				</KnowledgeSection>
			)}
			{data.rationale && (
				<KnowledgeSection label={t("knowledge.detail.rationale")}>
					<p>{String(data.rationale)}</p>
				</KnowledgeSection>
			)}
			<div className="flex items-center gap-3">
				{data.category ? (
					<Badge variant="outline" className="text-[10px] px-2 py-0 rounded-full font-normal">
						{String(data.category)}
					</Badge>
				) : null}
				{priority && (
					<Badge
						variant="outline"
						className="text-[10px] px-2 py-0 rounded-full font-medium"
						style={{
							borderColor:
								priority === "p0" ? "#c0392b40" : priority === "p1" ? "#e67e2240" : "#2d8b7a40",
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
				return (
					<KnowledgeSection key={key} label={key}>
						<p>{val}</p>
					</KnowledgeSection>
				);
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
