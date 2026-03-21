import { Check, Circle, CircleDot } from "@animated-color-icons/lucide-react";
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
				const completeColor = "#7b6b8d"; // purple for completed waves

				// Connector type: flowing dots when connecting complete→current
				const showFlowingDots = isCurrent && prevComplete;

				return (
					<div key={wave.key} className="flex items-start">
						{/* Connector */}
						{i > 0 && (
							<div className="flex items-center shrink-0" style={{ height: "28px" }}>
								{showFlowingDots ? (
									<div className="w-8 flex items-center justify-between px-0.5">
										<div className="size-1 rounded-full animate-flow-dot-1" style={{ backgroundColor: completeColor }} />
										<div className="size-1 rounded-full animate-flow-dot-2" style={{ background: `linear-gradient(to right, ${completeColor} 50%, #e67e22 50%)` }} />
										<div className="size-1 rounded-full animate-flow-dot-3" style={{ backgroundColor: "#e67e22" }} />
									</div>
								) : (
									<div
										className="w-6 overflow-hidden"
										style={{ height: "2px" }}
									>
										<div
											className="h-full w-full"
											style={{
												backgroundColor: isComplete || prevComplete ? completeColor : "var(--color-border)",
											}}
										/>
									</div>
								)}
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
												? `${completeColor}18`
												: isCurrent
													? "#e67e2218"
													: "var(--color-accent)",
											border: `2px solid ${isComplete ? completeColor : isCurrent ? "#e67e22" : "var(--color-border)"}`,
										}}
									>
										{isComplete ? (
											<Check className="size-3.5" style={{ color: completeColor }} />
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
												? completeColor
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
								<p className="text-[10px] text-white/70 tabular-nums">
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
