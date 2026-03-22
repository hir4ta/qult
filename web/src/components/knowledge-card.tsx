import { useState } from "react";
import { motion } from "motion/react";
import { Archive, ArchiveRestore, BookOpen, Gavel, Lightbulb, Shield } from "@animated-color-icons/lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useToggleEnabledMutation } from "@/lib/api";
import { contentPreview, formatDate, formatLabel } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import type { KnowledgeEntry } from "@/lib/types";
import { SUB_TYPE_COLORS } from "@/lib/types";
import { cn } from "@/lib/utils";
import { VerificationBadge } from "@/components/verification-badge";

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
	const [isRevealed, setIsRevealed] = useState(false);

	return (
		<Card
			className={cn(
				"al-icon-wrapper cursor-pointer rounded-organic border-stone-200 transition-[border-color,transform] duration-200 hover:border-stone-300 hover:-translate-y-0.5 dark:border-stone-700 dark:hover:border-stone-600",
				!entry.enabled && "opacity-60 saturate-50",
			)}
			tabIndex={0}
			onClick={onSelect}
			onMouseEnter={() => setIsRevealed(true)}
			onMouseLeave={() => setIsRevealed(false)}
			onFocus={() => setIsRevealed(true)}
			onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setIsRevealed(false); }}
		>
			<CardContent className="p-4 h-[88px] overflow-hidden relative">
				{/* Row 1: Sub-type icon + label + actions */}
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
					<div className="flex items-center gap-2">
						<VerificationBadge entry={entry} />
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

				{/* Row 2: Title */}
				<p className="text-sm font-medium leading-snug line-clamp-1 mt-1.5">{title}</p>

				{/* Hover reveal: preview + tags (replaces date area) */}
				<motion.div
					className="absolute bottom-0 left-0 right-0 px-4 pb-2 bg-card"
					initial={{ opacity: 0 }}
					animate={{ opacity: isRevealed ? 1 : 0 }}
					transition={{ type: "spring", damping: 25, stiffness: 200 }}
					aria-hidden={!isRevealed}
				>
					<p className="text-[11px] text-muted-foreground line-clamp-1">
						{contentPreview(entry.content, 80)}
					</p>
					{entry.tags && entry.tags.length > 0 && (
						<div className="flex flex-wrap gap-1 mt-0.5">
							{entry.tags.slice(0, 3).map((tag) => (
								<span key={tag} className="rounded-full border px-1.5 py-0 text-[10px] text-muted-foreground">{tag}</span>
							))}
							{entry.tags.length > 3 && (
								<span className="rounded-full border px-1.5 py-0 text-[10px] text-muted-foreground">+{entry.tags.length - 3}</span>
							)}
						</div>
					)}
				</motion.div>

				{/* Default: date (hidden on hover) */}
				<motion.div
					className="absolute bottom-0 left-0 right-0 px-4 pb-2"
					initial={{ opacity: 1 }}
					animate={{ opacity: isRevealed ? 0 : 1 }}
					transition={{ type: "spring", damping: 25, stiffness: 200 }}
					aria-hidden={isRevealed}
				>
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
				</motion.div>
			</CardContent>
		</Card>
	);
}
