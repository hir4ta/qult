/**
 * Top banner: an ASCII-shadow "qult" wordmark on the left and version /
 * spec metadata stacked on the right. Single flex row with `marginBottom`
 * so the panels below have air.
 *
 * On narrow terminals (< 70 cols) the banner is replaced with a compact
 * single-line title to avoid wrapping the artwork.
 */

import { Badge } from "@inkjs/ui";
import { Box, Text, useStdout } from "ink";
import { COLORS, GRADIENTS, sampleGradient } from "../theme.ts";
import type { ActiveSpec, SpecPhase } from "../types.ts";

interface Props {
	version: string;
	activeSpec: ActiveSpec | null;
}

const PHASE_COLORS: Record<SpecPhase, string> = {
	requirements: COLORS.warning,
	design: COLORS.primary,
	tasks: COLORS.accent,
	implementation: COLORS.success,
	archived: COLORS.muted,
};

// "ANSI Shadow"-style block lettering for "qult". Pre-rendered so we don't
// pull a figlet dep into the bundle. Width ≈ 35 cols, height = 6 rows.
const QULT_BANNER: readonly string[] = [
	" ██████╗ ██╗   ██╗██╗     ████████╗",
	"██╔═══██╗██║   ██║██║     ╚══██╔══╝",
	"██║   ██║██║   ██║██║        ██║   ",
	"██║▄▄ ██║██║   ██║██║        ██║   ",
	"╚██████╔╝╚██████╔╝███████╗   ██║   ",
	" ╚══▀▀═╝  ╚═════╝ ╚══════╝   ╚═╝   ",
];

const COMPACT_THRESHOLD_COLS = 70;

export function Header({ version, activeSpec }: Props): React.ReactElement {
	const { stdout } = useStdout();
	const cols = stdout.columns ?? 80;
	const compact = cols < COMPACT_THRESHOLD_COLS;

	if (compact) {
		return (
			<Box marginBottom={1} flexDirection="row" gap={1}>
				<Text color={COLORS.primary} bold>
					▍qult
				</Text>
				<Text color={COLORS.muted}>v{version}</Text>
				<Text color={COLORS.accent} bold>
					dashboard
				</Text>
				<Box flexGrow={1} />
				<SpecMeta activeSpec={activeSpec} />
			</Box>
		);
	}

	const bannerW = QULT_BANNER[0]?.length ?? 1;
	const bannerH = QULT_BANNER.length;

	return (
		<Box marginBottom={1} flexDirection="row" gap={2}>
			<Box flexDirection="column">
				{QULT_BANNER.map((line, row) => (
					<Box
						// biome-ignore lint/suspicious/noArrayIndexKey: banner lines are static
						key={row}
					>
						{[...line].map((ch, col) => {
							// 2-axis sampling: vertical position contributes 70%
							// (slow drift through the gradient), horizontal 30%
							// (subtle shimmer across each row).
							const t =
								(row / Math.max(1, bannerH - 1)) * 0.7 + (col / Math.max(1, bannerW - 1)) * 0.3;
							const color = sampleGradient(GRADIENTS.aurora, t);
							return (
								<Text
									// biome-ignore lint/suspicious/noArrayIndexKey: cells are positional
									key={col}
									color={color}
									bold
								>
									{ch}
								</Text>
							);
						})}
					</Box>
				))}
			</Box>
			<Box flexDirection="column" justifyContent="center">
				<Box gap={1}>
					<Text color={COLORS.muted}>v{version}</Text>
					<Text color={COLORS.accent} bold>
						dashboard
					</Text>
				</Box>
				<Box marginTop={1}>
					<SpecMeta activeSpec={activeSpec} />
				</Box>
			</Box>
		</Box>
	);
}

function SpecMeta({ activeSpec }: { activeSpec: ActiveSpec | null }): React.ReactElement {
	if (!activeSpec) {
		return <Text color={COLORS.muted}>no active spec</Text>;
	}
	return (
		<Box gap={1}>
			<Text color={COLORS.muted}>spec</Text>
			<Text bold>{activeSpec.name}</Text>
			<Badge color={PHASE_COLORS[activeSpec.phase]}>{activeSpec.phase}</Badge>
		</Box>
	);
}
