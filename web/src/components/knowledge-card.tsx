import { Archive, ArchiveRestore, BookOpen, Gavel, Lightbulb, Shield } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useToggleEnabledMutation } from "@/lib/api";
import { contentPreview, formatDate, formatLabel } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import type { KnowledgeEntry } from "@/lib/types";
import { SUB_TYPE_COLORS } from "@/lib/types";
import { cn } from "@/lib/utils";

export const SUB_TYPE_ICONS: Record<string, React.ReactNode> = {
	rule: <Shield className="size-3.5" />,
	decision: <Gavel className="size-3.5" />,
	pattern: <Lightbulb className="size-3.5" />,
	snapshot: <BookOpen className="size-3.5" />,
};

export const SUB_TYPE_LABEL_KEYS: Record<
	string,
	"knowledge.rule" | "knowledge.decision" | "knowledge.pattern" | "knowledge.snapshot"
> = {
	rule: "knowledge.rule",
	decision: "knowledge.decision",
	pattern: "knowledge.pattern",
	snapshot: "knowledge.snapshot",
};

export function KnowledgeCard({
	entry,
	onSelect,
}: {
	entry: KnowledgeEntry;
	onSelect: () => void;
}) {
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
							{SUB_TYPE_LABEL_KEYS[entry.sub_type]
								? t(SUB_TYPE_LABEL_KEYS[entry.sub_type]!)
								: entry.sub_type}
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
