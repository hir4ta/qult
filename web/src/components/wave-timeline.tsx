import { Check, Circle, CircleDot } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { WaveInfo } from "@/lib/types";

interface WaveTimelineProps {
	waves: WaveInfo[];
}

export function WaveTimeline({ waves }: WaveTimelineProps) {
	if (waves.length === 0) return null;

	return (
		<div className="flex items-start gap-0 overflow-x-auto pb-1">
			{waves.map((wave, i) => {
				const isComplete = wave.checked >= wave.total && wave.total > 0;
				const isCurrent = wave.isCurrent;
				const prevComplete = i > 0 && (waves[i - 1]?.checked ?? 0) >= (waves[i - 1]?.total ?? 1) && (waves[i - 1]?.total ?? 0) > 0;
				const label = wave.key === "closing" ? "Closing" : `Wave ${wave.key}`;

				return (
					<div key={wave.key} className="flex items-start">
						{/* Connector — aligned to circle center (size-7 = 28px, center = 14px) */}
						{i > 0 && (
							<div className="flex items-center shrink-0" style={{ height: "28px" }}>
								<div
									className="w-6 overflow-hidden"
									style={{ height: "2px" }}
								>
									{isCurrent ? (
										<div
											className="h-full w-full animate-shimmer"
											style={{
												background: "linear-gradient(90deg, #2d8b7a, #e67e22, #2d8b7a)",
												backgroundSize: "200% 100%",
											}}
										/>
									) : (
										<div
											className="h-full w-full"
											style={{
												backgroundColor: isComplete || prevComplete ? "#2d8b7a" : "var(--color-border)",
											}}
										/>
									)}
								</div>
							</div>
						)}

						{/* Step */}
						<Tooltip>
							<TooltipTrigger asChild>
								<div className="flex flex-col items-center gap-1 shrink-0 cursor-help">
									<div
										className="flex size-7 items-center justify-center rounded-full transition-colors"
										style={{
											backgroundColor: isComplete
												? "#2d8b7a18"
												: isCurrent
													? "#e67e2218"
													: "var(--color-accent)",
											border: `2px solid ${isComplete ? "#2d8b7a" : isCurrent ? "#e67e22" : "var(--color-border)"}`,
										}}
									>
										{isComplete ? (
											<Check className="size-3.5" style={{ color: "#2d8b7a" }} />
										) : isCurrent ? (
											<CircleDot className="size-3.5 animate-pulse" style={{ color: "#e67e22" }} />
										) : (
											<Circle className="size-3.5 text-muted-foreground" />
										)}
									</div>
									<span
										className="text-[10px] font-medium whitespace-nowrap"
										style={{
											color: isComplete
												? "#2d8b7a"
												: isCurrent
													? "#e67e22"
													: "var(--color-muted-foreground)",
										}}
									>
										{label}
									</span>
								</div>
							</TooltipTrigger>
							<TooltipContent>
								<p className="text-xs font-medium">{wave.title || label}</p>
								<p className="text-[10px] text-muted-foreground tabular-nums">
									{wave.checked}/{wave.total} tasks
								</p>
							</TooltipContent>
						</Tooltip>
					</div>
				);
			})}
		</div>
	);
}
