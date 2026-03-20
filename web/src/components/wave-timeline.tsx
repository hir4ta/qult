import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { WaveInfo } from "@/lib/types";

interface WaveTimelineProps {
	waves: WaveInfo[];
}

// Color palette for wave states
const COLORS = {
	complete: { fill: "#2d8b7a", bg: "#2d8b7a20", stroke: "#2d8b7a" },
	current: { fill: "#e67e22", bg: "#e67e2220", stroke: "#e67e22" },
	pending: { fill: "var(--color-muted-foreground)", bg: "var(--color-accent)", stroke: "var(--color-border)" },
};

function getWaveColor(wave: WaveInfo, isComplete: boolean) {
	if (isComplete) return COLORS.complete;
	if (wave.isCurrent) return COLORS.current;
	return COLORS.pending;
}

// Organic node shape: slightly varied radii
function organicRx(i: number) {
	return 13 + ((i * 7 + 3) % 4); // 13-16
}
function organicRy(i: number) {
	return 12 + ((i * 5 + 1) % 3); // 12-14
}

export function WaveTimeline({ waves }: WaveTimelineProps) {
	if (waves.length === 0) return null;

	const nodeSpacing = 80;
	const nodeY = 30;
	const labelY = 58;
	const padding = 24;
	const totalWidth = (waves.length - 1) * nodeSpacing + padding * 2;
	const viewBoxWidth = Math.max(totalWidth, 100);
	const viewBoxHeight = 70;

	// Single wave: center it
	const startX = waves.length === 1 ? viewBoxWidth / 2 : padding;

	return (
		<div className={waves.length > 8 ? "overflow-x-auto" : ""}>
			<svg
				viewBox={`0 0 ${viewBoxWidth} ${viewBoxHeight}`}
				className="w-full"
				style={{ minWidth: waves.length > 8 ? waves.length * 70 : undefined }}
				role="img"
				aria-label="Wave progress timeline"
			>
				{/* Bezier curve connectors */}
				{waves.map((wave, i) => {
					if (i === 0) return null;
					const x1 = startX + (i - 1) * nodeSpacing;
					const x2 = startX + i * nodeSpacing;
					const cx1 = x1 + nodeSpacing * 0.4;
					const cx2 = x2 - nodeSpacing * 0.4;

					const prevComplete = (waves[i - 1]?.checked ?? 0) >= (waves[i - 1]?.total ?? 1) && (waves[i - 1]?.total ?? 0) > 0;
					const isComplete = wave.checked >= wave.total && wave.total > 0;
					const colors = getWaveColor(wave, isComplete);

					return (
						<path
							key={`conn-${wave.key}`}
							d={`M ${x1} ${nodeY} C ${cx1} ${nodeY - 6} ${cx2} ${nodeY + 6} ${x2} ${nodeY}`}
							fill="none"
							stroke={prevComplete || isComplete ? colors.stroke : "var(--color-border)"}
							strokeWidth="2"
							strokeLinecap="round"
							opacity={wave.isCurrent ? 0.8 : 0.5}
						/>
					);
				})}

				{/* Nodes */}
				{waves.map((wave, i) => {
					const x = startX + i * nodeSpacing;
					const isComplete = wave.checked >= wave.total && wave.total > 0;
					const colors = getWaveColor(wave, isComplete);
					const rx = organicRx(i);
					const ry = organicRy(i);
					const label = wave.key === "closing" ? "Closing" : `Wave ${wave.key}`;

					return (
						<Tooltip key={wave.key}>
							<TooltipTrigger asChild>
								<g className="cursor-help">
									{/* Node ellipse */}
									<ellipse
										cx={x}
										cy={nodeY}
										rx={rx}
										ry={ry}
										fill={colors.bg}
										stroke={colors.stroke}
										strokeWidth={wave.isCurrent ? 2.5 : 1.5}
									/>

									{/* Inner indicator */}
									{isComplete ? (
										<>
											<path
												d={`M ${x - 4} ${nodeY} l 3 3 l 5 -6`}
												fill="none"
												stroke={colors.fill}
												strokeWidth="2"
												strokeLinecap="round"
												strokeLinejoin="round"
											/>
										</>
									) : wave.isCurrent ? (
										<circle cx={x} cy={nodeY} r="3.5" fill={colors.fill} opacity="0.8" />
									) : (
										<circle cx={x} cy={nodeY} r="2.5" fill={colors.fill} opacity="0.4" />
									)}

									{/* Progress arc for current wave */}
									{wave.isCurrent && wave.total > 0 && (
										<circle
											cx={x}
											cy={nodeY}
											r={rx - 2}
											fill="none"
											stroke={colors.fill}
											strokeWidth="1.5"
											strokeDasharray={`${((wave.checked / wave.total) * 2 * Math.PI * (rx - 2)).toFixed(1)} ${(2 * Math.PI * (rx - 2)).toFixed(1)}`}
											strokeLinecap="round"
											transform={`rotate(-90 ${x} ${nodeY})`}
											opacity="0.5"
										/>
									)}

									{/* Label */}
									<text
										x={x}
										y={labelY}
										textAnchor="middle"
										fill={isComplete ? colors.fill : wave.isCurrent ? colors.fill : "var(--color-muted-foreground)"}
										fontSize="9"
										fontWeight="500"
										fontFamily="var(--font-display)"
									>
										{label}
									</text>
								</g>
							</TooltipTrigger>
							<TooltipContent>
								<p className="text-xs font-medium">{wave.title || label}</p>
								<p className="text-[10px] text-muted-foreground tabular-nums">
									{wave.checked}/{wave.total} tasks
								</p>
							</TooltipContent>
						</Tooltip>
					);
				})}
			</svg>
		</div>
	);
}
