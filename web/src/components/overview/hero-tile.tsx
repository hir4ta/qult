import { Link } from "@tanstack/react-router";
import { CircleDot } from "@animated-color-icons/lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/status-badge";
import { WaveTimeline } from "@/components/wave-timeline";
import { useI18n } from "@/lib/i18n";
import type { TaskDetail } from "@/lib/types";

export function HeroTile({ task }: { task: TaskDetail }) {
	const { t } = useI18n();
	const progress = (task.total ?? 0) > 0 ? ((task.completed ?? 0) / (task.total ?? 1)) * 100 : 0;

	return (
		<Link to="/tasks/$slug" params={{ slug: task.slug }} className="block">
			<Card className="al-icon-wrapper border-stone-200 transition-[border-color,transform] duration-200 hover:border-stone-300 hover:-translate-y-0.5 dark:border-stone-700 dark:hover:border-stone-600">
				<CardContent className="py-4 space-y-3">
					{/* Header */}
					<div className="flex items-center gap-2 min-w-0">
						<CircleDot className="size-5 shrink-0" style={{ color: "#40513b" }} />
						<span
							className="text-lg font-bold font-mono truncate"
							style={{ fontFamily: "var(--font-display)" }}
						>
							{task.slug}
						</span>
						<div className="flex items-center gap-1.5 ml-auto shrink-0">
							<StatusBadge status={task.status ?? "pending"} />
							{task.size && (
								<Badge variant="outline" className="text-[10px] px-1.5 py-0 rounded-full">
									{task.size}
								</Badge>
							)}
						</div>
					</div>

					{/* Wave Timeline */}
					{task.waves && task.waves.length > 0 && (
						<WaveTimeline waves={task.waves} />
					)}

					{/* Progress */}
					<div className="flex items-center gap-2.5">
						<Progress value={progress} className="flex-1" />
						<span className="text-xs tabular-nums text-muted-foreground">
							{task.completed}/{task.total} {t("overview.tasks").toLowerCase()}
						</span>
					</div>

					{/* Focus */}
					{task.focus && (
						<p className="text-[11px] text-muted-foreground">
							{t("task.focus")}: {task.focus}
						</p>
					)}
				</CardContent>
			</Card>
		</Link>
	);
}
