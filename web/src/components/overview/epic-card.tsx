import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { useI18n } from "@/lib/i18n";
import type { EpicSummary } from "@/lib/types";

export function EpicProgressCard({ epics }: { epics?: EpicSummary[] }) {
	const { t } = useI18n();
	if (!epics || epics.length === 0) return null;
	return (
		<Card className="border-stone-200 dark:border-stone-700">
			<CardHeader className="pb-3">
				<CardTitle className="text-sm font-semibold" style={{ fontFamily: "var(--font-display)" }}>
					{t("overview.epics")}
				</CardTitle>
			</CardHeader>
			<CardContent className="space-y-3">
				{epics.map((epic) => {
					const progress = epic.total > 0 ? (epic.completed / epic.total) * 100 : 0;
					return (
						<div key={epic.slug} className="space-y-1.5">
							<div className="flex items-center justify-between gap-2">
								<span className="text-sm font-medium truncate">{epic.name}</span>
								<span className="text-xs tabular-nums text-muted-foreground shrink-0">
									{epic.completed}/{epic.total}
								</span>
							</div>
							<Progress value={progress} className="" />
						</div>
					);
				})}
			</CardContent>
		</Card>
	);
}
