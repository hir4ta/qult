/**
 * Top banner: an ASCII-shadow "qult" wordmark on the left and version /
 * spec metadata stacked on the right. Single flex row with `marginBottom`
 * so the panels below have air.
 *
 * On narrow terminals (< 70 cols) the banner is replaced with a compact
 * single-line title to avoid wrapping the artwork.
 */

import { Badge } from "@inkjs/ui";
import { Box, Text } from "ink";
import { COLORS, GRADIENTS, sampleGradient } from "../theme.ts";
import type { ActiveSpec, SpecPhase } from "../types.ts";

interface Props {
	version: string;
	activeSpec: ActiveSpec | null;
	/** Current terminal width — owned by App via `useTerminalSize`. */
	columns: number;
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

export function Header({ version, activeSpec, columns }: Props): React.ReactElement {
	const compact = columns < COMPACT_THRESHOLD_COLS;

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

	const bannerH = QULT_BANNER.length;
	const bannerW = QULT_BANNER[0]?.length ?? 0;

	return (
		<Box marginBottom={1} flexDirection="row" gap={2}>
			<Box flexDirection="column" width={bannerW} flexShrink={0}>
				{QULT_BANNER.map((line, row) => {
					// One <Text> per line — gradient walks vertically. The
					// per-character variant flickered on first paint because
					// Ink reconciled 200+ leaf nodes in a single pass.
					const t = row / Math.max(1, bannerH - 1);
					const color = sampleGradient(GRADIENTS.aurora, t);
					return (
						<Text
							// biome-ignore lint/suspicious/noArrayIndexKey: banner lines are static
							key={row}
							color={color}
							bold
						>
							{line}
						</Text>
					);
				})}
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
