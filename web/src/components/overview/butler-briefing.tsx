import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useI18n } from "@/lib/i18n";
import type { BriefingResponse } from "@/lib/api";

export function ButlerBriefing({
	data,
	isLoading,
}: {
	data?: BriefingResponse;
	isLoading: boolean;
}) {
	const { t } = useI18n();

	if (isLoading) {
		return (
			<Card className="border-stone-200 dark:border-stone-700">
				<CardContent className="py-4">
					<Skeleton className="h-5 w-3/4 mb-2" />
					<Skeleton className="h-4 w-1/2" />
				</CardContent>
			</Card>
		);
	}

	const lines: string[] = [];

	if (!data || data.activeSpecs.length === 0) {
		lines.push(t("briefing.noTasks"));
	} else if (data.activeSpecs.length === 1) {
		const spec = data.activeSpecs[0]!;
		lines.push(
			t("briefing.greeting"),
			t("briefing.waveProgress", {
				slug: spec.slug,
				current: spec.currentWave,
				total: spec.totalWaves,
				remaining: spec.remainingTasks,
			}),
		);
	} else {
		lines.push(
			t("briefing.greeting"),
			t("briefing.multiSpec", { count: data.activeSpecs.length }),
		);
		for (const spec of data.activeSpecs) {
			lines.push(
				`• ${t("briefing.waveProgress", {
					slug: spec.slug,
					current: spec.currentWave,
					total: spec.totalWaves,
					remaining: spec.remainingTasks,
				})}`,
			);
		}
	}

	if (data && data.completedToday > 0) {
		lines.push(t("briefing.completedToday", { count: data.completedToday }));
	}

	if (data && data.overdueVerifications > 0) {
		lines.push(t("briefing.overdueKnowledge", { count: data.overdueVerifications }));
	}

	if (data && data.knowledgeTotal > 0 && data.activeSpecs.length > 0) {
		lines.push(t("briefing.knowledgeTotal", { total: data.knowledgeTotal }));
	}

	return (
		<Card className="border-stone-200 dark:border-stone-700">
			<CardContent className="py-4">
				<p
					className="text-base leading-relaxed text-foreground"
					style={{ fontFamily: "var(--font-display)" }}
				>
					{lines.map((line, i) => (
						<span key={i}>
							{i > 0 && " "}
							{line}
						</span>
					))}
				</p>
			</CardContent>
		</Card>
	);
}
