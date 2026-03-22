import { Link } from "@tanstack/react-router";
import { CircleCheck, CircleDot } from "@animated-color-icons/lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { StatusBadge } from "@/components/status-badge";
import { useI18n } from "@/lib/i18n";
import type { TaskDetail } from "@/lib/types";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

// Shimmer colors from brand palette — each task gets a unique color.
const SHIMMER_COLORS = [
	{ r: 45, g: 139, b: 122 }, // brand-pattern (teal)
	{ r: 98, g: 129, b: 65 }, // brand-decision (olive)
	{ r: 123, g: 107, b: 141 }, // brand-purple
	{ r: 230, g: 126, b: 34 }, // brand-rule (orange)
	{ r: 64, g: 81, b: 59 }, // brand-session (dark green)
];

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
	const c = SHIMMER_COLORS[colorIndex % SHIMMER_COLORS.length]!;
	const accentColor = `rgb(${c.r},${c.g},${c.b})`;

	return (
		<Link to="/tasks/$slug" params={{ slug: task.slug }} className="block">
			<Card
				className={cn(
					"al-icon-wrapper h-[140px] !gap-0 !py-0 border-stone-200 transition-[border-color,transform] duration-200 hover:border-stone-300 hover:-translate-y-0.5 dark:border-stone-700 dark:hover:border-stone-600",
					isCompleted && "opacity-60",
				)}
			>
				<CardContent className="flex-1 flex flex-col p-4 gap-1.5">
					{/* Row 1: Spec name */}
					<div className="flex items-center gap-2 min-w-0">
						{isCompleted ? (
							<CircleCheck className="size-4 shrink-0" style={{ color: "#2d8b7a" }} />
						) : (
							<CircleDot className="size-4 shrink-0" style={{ color: accentColor }} />
						)}
						<span className="text-sm font-semibold font-mono truncate">{task.slug}</span>
					</div>

					{/* Row 2: Project name, date */}
					<p className="text-[10px] text-muted-foreground truncate">
						{task.project_name}{task.project_name && task.started_at ? " · " : ""}{task.started_at ? formatDate(task.started_at) : ""}
					</p>

					{/* Row 3: Status + Size badges */}
					<div className="flex items-center gap-1.5 flex-wrap">
						<StatusBadge status={task.status ?? "pending"} />
						{task.size && (
							<Badge variant="outline" className="text-[10px] px-1.5 py-0 rounded-full">
								{task.size}
							</Badge>
						)}
						{task.spec_type && task.spec_type !== "feature" && (
							<Badge variant="outline" className="text-[10px] px-1.5 py-0" style={{ borderColor: "rgba(98,129,65,0.4)", color: "#628141" }}>
								{task.spec_type}
							</Badge>
						)}
					</div>

					{/* Row 4: Progress bar */}
					<div className="flex items-center gap-2.5 mt-auto">
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
