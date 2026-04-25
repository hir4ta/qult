/**
 * Top banner: qult version, active spec name + phase Badge, elapsed time.
 * Renders in a single flex row with marginBottom so panels below have air.
 */

import { Badge } from "@inkjs/ui";
import { Box, Text } from "ink";
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

export function Header({ version, activeSpec, startedAt, now }: Props): React.ReactElement {
	const elapsed = formatElapsed(Math.max(0, now - startedAt));
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
			{activeSpec ? (
				<Box gap={1}>
					<Text color={COLORS.muted}>spec</Text>
					<Text bold>{activeSpec.name}</Text>
					<Badge color={PHASE_COLORS[activeSpec.phase]}>{activeSpec.phase}</Badge>
				</Box>
			) : (
				<Text color={COLORS.muted}>no active spec</Text>
			)}
			<Box marginLeft={2}>
				<Text color={COLORS.muted}>{elapsed}</Text>
			</Box>
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
