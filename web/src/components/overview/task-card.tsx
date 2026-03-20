import { Link } from "@tanstack/react-router";
import { CircleCheck, CircleDot } from "@animated-color-icons/lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/lib/i18n";
import type { TaskDetail } from "@/lib/types";
import { cn } from "@/lib/utils";

// Shimmer colors from brand palette — each task gets a unique color.
const SHIMMER_COLORS = [
	{ r: 45, g: 139, b: 122 }, // brand-pattern (teal)
	{ r: 98, g: 129, b: 65 }, // brand-decision (olive)
	{ r: 123, g: 107, b: 141 }, // brand-purple
	{ r: 230, g: 126, b: 34 }, // brand-rule (orange)
	{ r: 64, g: 81, b: 59 }, // brand-session (dark green)
];

function shimmerGradient(index: number) {
	const c = SHIMMER_COLORS[index % SHIMMER_COLORS.length]!;
	return `linear-gradient(90deg, rgba(${c.r},${c.g},${c.b},0.04) 0%, rgba(${c.r},${c.g},${c.b},0.12) 50%, rgba(${c.r},${c.g},${c.b},0.04) 100%)`;
}

const SIZE_LABEL_KEYS: Record<string, TranslationKey> = {
	S: "size.S",
	M: "size.M",
	L: "size.L",
	XL: "size.XL",
	D: "size.D",
};

/** Derive the next action from task state for display on the card. */
function deriveNextAction(task: TaskDetail, t: (key: TranslationKey) => string): string | null {
	const isCompleted = task.status === "completed" || task.status === "done" || task.status === "cancelled";
	if (isCompleted) return null;
	if (task.review_status === "changes_requested") return t("action.changesRequested");
	if (task.review_status === "pending" && ["M", "L", "XL"].includes(task.size ?? ""))
		return t("action.awaitingReview");
	if (task.focus) return t("action.implementing");
	return t("action.specCreation");
}

export function TaskCard({
	task,
	colorIndex,
}: {
	task: TaskDetail;
	colorIndex: number;
}) {
	const { t } = useI18n();
	const progress = (task.total ?? 0) > 0 ? ((task.completed ?? 0) / (task.total ?? 1)) * 100 : 0;
	const isCompleted = task.status === "completed" || task.status === "done" || task.status === "cancelled";
	const currentWave = task.waves?.find((w) => w.isCurrent);
	const c = SHIMMER_COLORS[colorIndex % SHIMMER_COLORS.length]!;
	const accentColor = `rgb(${c.r},${c.g},${c.b})`;
	const nextAction = deriveNextAction(task, t);

	return (
		<Link to="/tasks/$slug" params={{ slug: task.slug }} className="block">
			<Card
				className={cn(
					"al-icon-wrapper h-[140px] !gap-0 !py-0 border-stone-200 transition-[border-color,transform] duration-200 hover:border-stone-300 hover:-translate-y-0.5 dark:border-stone-700 dark:hover:border-stone-600",
					isCompleted && "opacity-60",
				)}
			>
				<CardContent className="flex-1 flex flex-col p-4 gap-1.5">
					{/* Header */}
					<div className="flex items-center justify-between gap-2">
						<div className="flex items-center gap-2 min-w-0">
							{isCompleted ? (
								<CircleCheck className="size-4 shrink-0" style={{ color: "#2d8b7a" }} />
							) : (
								<CircleDot className="size-4 shrink-0" style={{ color: accentColor }} />
							)}
							<span className="text-sm font-semibold font-mono truncate">{task.slug}</span>
						</div>
						<div className="flex shrink-0 gap-1.5">
							{task.size && (
								<Tooltip>
									<TooltipTrigger asChild>
										<Badge
											variant="outline"
											className="text-[10px] px-1.5 py-0 rounded-full cursor-help"
										>
											{task.size}
										</Badge>
									</TooltipTrigger>
									<TooltipContent>{SIZE_LABEL_KEYS[task.size] ? t(SIZE_LABEL_KEYS[task.size]!) : task.size}</TooltipContent>
								</Tooltip>
							)}
						</div>
					</div>

					{/* Current wave + shimmer + next action */}
					<div className="flex-1 flex flex-col justify-center gap-1">
						{task.project_name && (
							<p className="text-[10px] font-medium text-muted-foreground">
								{task.project_name}
							</p>
						)}
						{currentWave && !isCompleted ? (
							<div className="relative overflow-hidden rounded-md px-2 py-1">
								<div
									className="absolute inset-0 animate-shimmer"
									style={{ background: shimmerGradient(colorIndex), backgroundSize: "200% 100%" }}
								/>
								<p className="relative text-[11px] line-clamp-1" style={{ color: accentColor }}>
									→ {currentWave.key === "closing" ? "Closing" : `Wave ${currentWave.key}`}: {currentWave.title} ({currentWave.checked}/{currentWave.total})
								</p>
							</div>
						) : nextAction ? (
							<p className="text-[11px] text-muted-foreground">{nextAction}</p>
						) : null}
					</div>

					{/* Progress */}
					<div className="flex items-center gap-2.5">
						<Progress value={progress} className="flex-1" />
						<span className="text-[11px] tabular-nums text-muted-foreground">
							{task.completed}/{task.total}
						</span>
					</div>
				</CardContent>
			</Card>
		</Link>
	);
}
