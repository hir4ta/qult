/**
 * Single-line header: qult version + spec name + phase Badge. Compact
 * on every terminal width — the ASCII banner experiment caused first-paint
 * artifacts in some terminals (Ghostty, others) so we keep things flat.
 */

import { Badge } from "@inkjs/ui";
import { Box, Text } from "ink";
import { COLORS } from "../theme.ts";
import type { ActiveSpec, SpecPhase } from "../types.ts";

interface Props {
	version: string;
	activeSpec: ActiveSpec | null;
	/** Reserved — kept so App's useTerminalSize wiring stays uniform. */
	columns?: number;
}

const PHASE_COLORS: Record<SpecPhase, string> = {
	requirements: COLORS.warning,
	design: COLORS.primary,
	tasks: COLORS.accent,
	implementation: COLORS.success,
	archived: COLORS.muted,
};

export function Header({ version, activeSpec }: Props): React.ReactElement {
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
