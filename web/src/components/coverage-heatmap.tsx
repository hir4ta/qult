import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useI18n } from "@/lib/i18n";
import type { ValidationCheck } from "@/lib/types";

export function CoverageHeatmap({ checks }: { checks: ValidationCheck[] }) {
	const { t } = useI18n();
	if (checks.length === 0) return null;

	const passed = checks.filter((c) => c.status === "pass").length;
	const failed = checks.filter((c) => c.status === "fail").length;

	return (
		<div className="rounded-xl border border-border bg-card">
			<div className="px-4 py-2.5 flex items-center justify-between">
				<h3 className="text-sm font-semibold" style={{ fontFamily: "var(--font-display)" }}>
					{t("task.coverage")}
				</h3>
				<span className="text-[10px] text-muted-foreground tabular-nums">
					{passed} {t("task.passed")} / {failed} {t("task.failed")}
				</span>
			</div>
			<div className="border-t px-4 py-3">
				<div className="grid grid-cols-7 gap-1.5">
					{checks.map((check) => (
						<Tooltip key={check.name}>
							<TooltipTrigger asChild>
								<div
									className="h-6 rounded-md cursor-help transition-colors"
									style={{
										backgroundColor: check.status === "pass"
											? "rgba(45, 139, 122, 0.25)"
											: check.status === "fail"
												? "rgba(192, 57, 43, 0.25)"
												: "rgba(107, 114, 128, 0.15)",
										border: `1px solid ${check.status === "pass" ? "rgba(45,139,122,0.4)" : check.status === "fail" ? "rgba(192,57,43,0.4)" : "rgba(107,114,128,0.2)"}`,
									}}
								/>
							</TooltipTrigger>
							<TooltipContent>
								<p className="text-xs font-medium text-white">{check.name}</p>
								{check.message && <p className="text-[10px] text-white/70">{check.message}</p>}
								<p className="text-[10px] font-medium" style={{ color: check.status === "pass" ? "#6ee7b7" : "#fca5a5" }}>
									{check.status}
								</p>
							</TooltipContent>
						</Tooltip>
					))}
				</div>
			</div>
		</div>
	);
}
