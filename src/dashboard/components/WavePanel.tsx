/**
 * Per-wave progress: status Badge, completion ratio, and an inline
 * ProgressBar from `@inkjs/ui`. Empty state renders a Spinner so the
 * panel never looks dead even when no waves exist yet.
 */

import { Badge, ProgressBar, Spinner } from "@inkjs/ui";
import { Box, Text } from "ink";
import { COLORS } from "../theme.ts";
import type { WaveStatus, WaveSummary } from "../types.ts";
import { PanelFrame } from "./PanelFrame.tsx";

interface Props {
	waves: WaveSummary[];
	flexGrow?: number;
	flexBasis?: number | string;
	minWidth?: number;
}

const STATUS_COLOR: Record<WaveStatus, string> = {
	todo: COLORS.muted,
	"in-progress": COLORS.primary,
	done: COLORS.success,
};

export function WavePanel({ waves, flexGrow, flexBasis, minWidth }: Props): React.ReactElement {
	return (
		<PanelFrame
			title="Waves"
			titleColor={COLORS.primary}
			flexGrow={flexGrow}
			flexBasis={flexBasis}
			minWidth={minWidth}
		>
			{waves.length === 0 ? (
				<Spinner label="awaiting waves" />
			) : (
				waves.map((w) => <WaveRow key={w.number} wave={w} />)
			)}
		</PanelFrame>
	);
}

function WaveRow({ wave }: { wave: WaveSummary }): React.ReactElement {
	const pct = wave.tasksTotal === 0 ? 0 : Math.round((wave.tasksDone / wave.tasksTotal) * 100);
	return (
		<Box flexDirection="column" marginBottom={1}>
			<Box gap={1}>
				<Text color={COLORS.muted}>#{String(wave.number).padStart(2, "0")}</Text>
				<Badge color={STATUS_COLOR[wave.status]}>{wave.status}</Badge>
				<Text>
					{wave.tasksDone}/{wave.tasksTotal}
				</Text>
				<Box flexGrow={1} />
				<Text color={COLORS.muted}>{pct}%</Text>
			</Box>
			<Box>
				<ProgressBar value={pct} />
			</Box>
		</Box>
	);
}
