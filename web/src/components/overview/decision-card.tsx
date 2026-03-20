import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { useI18n } from "@/lib/i18n";
import type { DecisionEntry } from "@/lib/types";

export function RecentDecisionsCard({ decisions }: { decisions?: DecisionEntry[] }) {
	const { t } = useI18n();
	if (!decisions || decisions.length === 0) return null;
	return (
		<Card className="border-stone-200 dark:border-stone-700">
			<CardHeader className="pb-3">
				<CardTitle className="text-sm font-semibold" style={{ fontFamily: "var(--font-display)" }}>
					{t("overview.recentDecisions")}
				</CardTitle>
			</CardHeader>
			<CardContent>
				<div className="space-y-3">
					{decisions.map((dec, i) => {
						let chosen: string | undefined;
						try {
							const parsed = JSON.parse(dec.content);
							chosen = parsed.decision;
						} catch { /* raw content */ }
						return (
							<div key={`${dec.id}-${i}`}>
								{i > 0 && <Separator className="mb-3" />}
								<div className="flex items-start gap-3">
									<div
										className="mt-1.5 size-2 shrink-0 rounded-full"
										style={{ backgroundColor: "#628141" }}
									/>
									<div className="min-w-0 flex-1">
										<p className="text-sm font-medium leading-snug">{dec.label}</p>
										{chosen && (
											<p className="mt-0.5 text-xs text-muted-foreground line-clamp-1">
												{chosen}
											</p>
										)}
									</div>
									{dec.project_name && (
										<Badge variant="outline" className="shrink-0 text-[10px] rounded-full">
											{dec.project_name}
										</Badge>
									)}
								</div>
							</div>
						);
					})}
				</div>
			</CardContent>
		</Card>
	);
}
