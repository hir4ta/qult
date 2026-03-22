import { ButlerEmpty } from "@/components/butler-empty";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { VerificationBadge } from "@/components/verification-badge";
import { Badge } from "@/components/ui/badge";
import type { KnowledgeEntry } from "@/lib/types";
import { SUB_TYPE_COLORS } from "@/lib/types";
import { formatLabel, formatDate } from "@/lib/format";
import { useI18n } from "@/lib/i18n";

const HEIGHTS: Record<string, number> = { rule: 240, decision: 270, pattern: 220, snapshot: 200 };

const SPINE_COLORS = [
	"#8fbc8f", "#b0c4de", "#deb887", "#d4a574", "#a0b89e",
	"#c4a882", "#b8a9c9", "#d4927a", "#9cb4b0", "#c9b99a",
];

function darken(hex: string): string {
	const r = Math.max(0, parseInt(hex.slice(1, 3), 16) - 30);
	const g = Math.max(0, parseInt(hex.slice(3, 5), 16) - 30);
	const b = Math.max(0, parseInt(hex.slice(5, 7), 16) - 30);
	return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

function BookSpine({ entry, onClick }: { entry: KnowledgeEntry; onClick: () => void }) {
	const { locale } = useI18n();
	const color = SPINE_COLORS[entry.id % SPINE_COLORS.length]!;
	const edge = darken(color);
	const h = HEIGHTS[entry.sub_type] ?? 210;
	const { title } = formatLabel(entry.label);
	const subColor = SUB_TYPE_COLORS[entry.sub_type] ?? "#44403c";
	const w = entry.content.length > 300 ? 64 : entry.content.length > 100 ? 56 : 48;

	return (
		<HoverCard openDelay={300} closeDelay={100}>
			<HoverCardTrigger asChild>
				<button
					type="button"
					onClick={onClick}
					className="relative flex flex-col items-center justify-between rounded-[2px] cursor-pointer shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
					style={{
						width: w,
						height: h,
						backgroundColor: color,
						boxShadow: "3px 1px 8px rgba(0,0,0,0.12), inset 1px 0 0 rgba(255,255,255,0.08)",
						transition: "transform 0.25s cubic-bezier(0.22,1,0.36,1), box-shadow 0.25s ease",
					}}
					aria-label={title}
					onMouseEnter={(e) => {
						e.currentTarget.style.transform = "translateY(-6px)";
						e.currentTarget.style.boxShadow = "6px 8px 20px rgba(0,0,0,0.18), inset 1px 0 0 rgba(255,255,255,0.08)";
					}}
					onMouseLeave={(e) => {
						e.currentTarget.style.transform = "translateY(0)";
						e.currentTarget.style.boxShadow = "3px 1px 8px rgba(0,0,0,0.12), inset 1px 0 0 rgba(255,255,255,0.08)";
					}}
				>
					<div className="absolute inset-y-0 left-0 w-[3px] rounded-l-[2px]" style={{ backgroundColor: edge }} />
					<div className="pt-3 px-1.5 shrink-0">
						{entry.verification_due ? (
							<VerificationBadge entry={entry} />
						) : (
							<div className="w-5 h-[2px] bg-black/10 rounded-full mx-auto" />
						)}
					</div>
					<div className="flex-1" />
					<div className="pb-2.5 px-1.5 shrink-0">
						{(entry.hit_count ?? 0) > 0 ? (
							<span className="text-[9px] text-black/30 font-mono tabular-nums">{entry.hit_count}</span>
						) : (
							<div className="w-4 h-4 rounded-full border border-black/10 flex items-center justify-center">
								<span className="text-[7px] text-black/30 font-bold uppercase">{entry.sub_type.charAt(0)}</span>
							</div>
						)}
					</div>
				</button>
			</HoverCardTrigger>
			<HoverCardContent side="top" className="w-72 p-3">
				<div className="space-y-1.5">
					<p className="text-sm font-semibold leading-snug" style={{ fontFamily: "var(--font-display)" }}>
						{title}
					</p>
					<div className="flex items-center gap-2">
						<Badge variant="outline" className="text-[10px] px-1.5 py-0 rounded-full" style={{ borderColor: `${subColor}40`, color: subColor }}>
							{entry.sub_type}
						</Badge>
						{entry.saved_at && (
							<span className="text-[10px] text-muted-foreground">{formatDate(entry.saved_at, locale)}</span>
						)}
						{(entry.hit_count ?? 0) > 0 && (
							<span className="text-[10px] text-muted-foreground tabular-nums">{entry.hit_count} hits</span>
						)}
					</div>
				</div>
			</HoverCardContent>
		</HoverCard>
	);
}

export function BookshelfView({ entries, onSelect }: { entries: KnowledgeEntry[]; onSelect: (e: KnowledgeEntry) => void }) {
	if (entries.length === 0) return <ButlerEmpty scene="bookshelf" messageKey="empty.noMemories" />;

	return (
		<div className="relative">
			{/* Horizontal scroll shelf */}
			<div
				className="flex items-end gap-[3px] px-3 pt-8 pb-0 overflow-x-auto"
				style={{ scrollbarWidth: "thin" }}
			>
				{entries.map((e) => (
					<BookSpine key={e.id} entry={e} onClick={() => onSelect(e)} />
				))}
			</div>

			{/* Shelf plank */}
			<div
				className="h-3 relative z-10"
				style={{
					background: "linear-gradient(to bottom, #3d4a37 0%, #2a3425 60%, #232d1f 100%)",
					boxShadow: "0 3px 10px rgba(0,0,0,0.12), inset 0 1px 0 rgba(255,255,255,0.05)",
				}}
			/>
			<div className="h-2 bg-gradient-to-b from-black/[0.04] to-transparent" />

			{/* Scroll fade hints */}
			<div className="absolute top-0 right-0 bottom-5 w-8 bg-gradient-to-l from-background to-transparent pointer-events-none" />
			<div className="absolute top-0 left-0 bottom-5 w-8 bg-gradient-to-r from-background to-transparent pointer-events-none" />
		</div>
	);
}
