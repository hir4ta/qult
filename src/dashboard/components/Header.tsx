/**
 * Top banner: an ASCII-shadow "qult" wordmark on the left and version /
 * spec / elapsed metadata stacked on the right. Single flex row with
 * `marginBottom` so the panels below have air.
 *
 * On narrow terminals (< 60 cols) the banner is replaced with a compact
 * single-line title to avoid wrapping the artwork.
 */

import { Badge } from "@inkjs/ui";
import { Box, Text, useStdout } from "ink";
import { COLORS } from "../theme.ts";
import type { ActiveSpec, SpecPhase } from "../types.ts";

interface Props {
	version: string;
	activeSpec: ActiveSpec | null;
	startedAt: number;
	now: number;
}

const PHASE_COLORS: Record<SpecPhase, string> = {
	requirements: "yellow",
	design: "cyan",
	tasks: "magenta",
	implementation: "green",
	archived: "gray",
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

export function Header({ version, activeSpec, startedAt, now }: Props): React.ReactElement {
	const elapsed = formatElapsed(Math.max(0, now - startedAt));
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
				<MetaCompact activeSpec={activeSpec} elapsed={elapsed} />
			</Box>
		);
	}

	return (
		<Box marginBottom={1} flexDirection="row" gap={2}>
			<Box flexDirection="column">
				{QULT_BANNER.map((line, i) => (
					<Text
						// biome-ignore lint/suspicious/noArrayIndexKey: banner lines are static
						key={i}
						color={i < 3 ? COLORS.primary : COLORS.accent}
						bold
					>
						{line}
					</Text>
				))}
			</Box>
			<Box flexDirection="column" justifyContent="center">
				<Box gap={1}>
					<Text color={COLORS.muted}>v{version}</Text>
					<Text color={COLORS.accent} bold>
						dashboard
					</Text>
				</Box>
				<Box marginTop={1} gap={1}>
					{activeSpec ? (
						<>
							<Text color={COLORS.muted}>spec</Text>
							<Text bold>{activeSpec.name}</Text>
							<Badge color={PHASE_COLORS[activeSpec.phase]}>{activeSpec.phase}</Badge>
						</>
					) : (
						<Text color={COLORS.muted}>no active spec</Text>
					)}
				</Box>
				<Box marginTop={1}>
					<Text color={COLORS.muted}>elapsed </Text>
					<Text color={COLORS.warning} bold>
						{elapsed}
					</Text>
				</Box>
			</Box>
		</Box>
	);
}

function MetaCompact({
	activeSpec,
	elapsed,
}: {
	activeSpec: ActiveSpec | null;
	elapsed: string;
}): React.ReactElement {
	return (
		<Box gap={1}>
			{activeSpec ? (
				<>
					<Text color={COLORS.muted}>spec</Text>
					<Text bold>{activeSpec.name}</Text>
					<Badge color={PHASE_COLORS[activeSpec.phase]}>{activeSpec.phase}</Badge>
				</>
			) : (
				<Text color={COLORS.muted}>no active spec</Text>
			)}
			<Text color={COLORS.muted}>{elapsed}</Text>
		</Box>
	);
}

function formatElapsed(ms: number): string {
	const totalSec = Math.floor(ms / 1000);
	const h = Math.floor(totalSec / 3600);
	const m = Math.floor((totalSec % 3600) / 60);
	const s = totalSec % 60;
	if (h > 0) return `${h}h${pad(m)}m${pad(s)}s`;
	if (m > 0) return `${m}m${pad(s)}s`;
	return `${s}s`;
}

function pad(n: number): string {
	return String(n).padStart(2, "0");
}
