import { BookOpen, Gavel, Lightbulb, Shield } from "@animated-color-icons/lucide-react";
import { useI18n } from "@/lib/i18n";
import { formatDate, formatLabel } from "@/lib/format";
import type { KnowledgeEntry } from "@/lib/types";
import { SUB_TYPE_COLORS } from "@/lib/types";
import { cn } from "@/lib/utils";

const SUB_TYPE_ICONS: Record<string, React.ReactNode> = {
	rule: <Shield className="size-3" />,
	decision: <Gavel className="size-3" />,
	pattern: <Lightbulb className="size-3" />,
	snapshot: <BookOpen className="size-3" />,
};

export function KnowledgeListView({
	entries,
	onSelect,
}: {
	entries: KnowledgeEntry[];
	onSelect: (entry: KnowledgeEntry) => void;
}) {
	const { t, locale } = useI18n();

	return (
		<div className="space-y-0.5">
			{entries.map((entry) => {
				const { title } = formatLabel(entry.label);
				const color = SUB_TYPE_COLORS[entry.sub_type] ?? SUB_TYPE_COLORS.snapshot!;
				const icon = SUB_TYPE_ICONS[entry.sub_type] ?? SUB_TYPE_ICONS.snapshot;

				return (
					<button
						key={entry.id}
						type="button"
						onClick={() => onSelect(entry)}
						className={cn(
							"flex items-center gap-3 w-full h-10 px-3 rounded-organic border border-transparent text-left transition-colors hover:bg-accent/50",
							!entry.enabled && "opacity-60",
						)}
					>
						<div
							className="flex size-5 items-center justify-center rounded shrink-0"
							style={{ backgroundColor: `${color}18`, color }}
						>
							{icon}
						</div>
						<span className="text-sm truncate min-w-0 flex-1">{title}</span>
						<span className="text-[10px] tabular-nums text-muted-foreground shrink-0 w-6 text-right">
							{entry.hit_count}
						</span>
						<span className="text-[10px] text-muted-foreground shrink-0 w-16 text-right">
							{formatDate(entry.saved_at ?? "", locale)}
						</span>
					</button>
				);
			})}
		</div>
	);
}
