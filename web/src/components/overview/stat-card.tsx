import { AnimatedCounter } from "@/components/animated-counter";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export function StatCard({
	label,
	value,
	icon,
	loading,
}: {
	label: string;
	value: number;
	icon: React.ReactNode;
	loading?: boolean;
}) {
	return (
		<Card className="border-stone-200 dark:border-stone-700">
			<CardContent className="flex items-center gap-4 py-4">
				<div className="flex size-10 items-center justify-center rounded-lg bg-accent/80">
					{icon}
				</div>
				<div>
					{loading ? (
						<Skeleton className="h-7 w-12" />
					) : (
						<AnimatedCounter value={value} className="text-2xl font-bold" style={{ fontFamily: "var(--font-display)" }} />
					)}
					<p className="text-xs text-muted-foreground">{label}</p>
				</div>
			</CardContent>
		</Card>
	);
}
