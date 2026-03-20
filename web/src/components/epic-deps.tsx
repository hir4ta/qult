import { ArrowRight } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { EpicSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

export function EpicDependencies({ epic }: { epic: EpicSummary }) {
	const { t } = useI18n();
	const tasks = epic.tasks ?? [];
	const hasDeps = tasks.some((task) => (task.depends_on?.length ?? 0) > 0);

	if (!hasDeps) return null;

	return (
		<div className="mt-2 space-y-1">
			<p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
				{t("epic.dependencies")}
			</p>
			<div className="flex flex-wrap gap-x-4 gap-y-1">
				{tasks
					.filter((task) => (task.depends_on?.length ?? 0) > 0)
					.map((task) => (
						<div key={task.slug} className="flex items-center gap-1 text-xs">
							{task.depends_on!.map((dep, i) => (
								<span key={dep} className="flex items-center gap-1">
									{i > 0 && <span className="text-muted-foreground">+</span>}
									<span
										className={cn(
											"rounded-full px-1.5 py-0 border text-[10px]",
											tasks.find((t) => t.slug === dep)?.status === "completed"
												? "border-green-300 text-green-700 dark:border-green-800 dark:text-green-400"
												: "border-border text-muted-foreground",
										)}
									>
										{dep}
									</span>
								</span>
							))}
							<ArrowRight className="size-3 text-muted-foreground" />
							<span
								className={cn(
									"rounded-full px-1.5 py-0 border text-[10px] font-medium",
									task.status === "completed"
										? "border-green-300 text-green-700 dark:border-green-800 dark:text-green-400"
										: "border-border text-foreground",
								)}
							>
								{task.slug}
							</span>
						</div>
					))}
			</div>
		</div>
	);
}
