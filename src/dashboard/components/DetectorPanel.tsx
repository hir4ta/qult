/**
 * Detector strip: one row per Tier-1 detector with a status Badge and
 * pending-fix count. Critical / high counts trigger an Alert at the top
 * to draw the eye even when the panel is small.
 */

import { Alert, Badge, Spinner } from "@inkjs/ui";
import { Box, Text } from "ink";
import { COLORS } from "../theme.ts";
import type { DetectorStatus, DetectorSummary } from "../types.ts";
import { PanelFrame } from "./PanelFrame.tsx";

interface Props {
	detectors: DetectorSummary[];
	flexGrow?: number;
	flexBasis?: number | string;
	minWidth?: number;
}

const STATUS_COLOR: Record<DetectorStatus, string> = {
	pass: COLORS.success,
	warn: COLORS.warning,
	fail: COLORS.error,
	skipped: COLORS.muted,
	"never-run": COLORS.muted,
	running: COLORS.primary,
	idle: COLORS.muted,
};

export function DetectorPanel({
	detectors,
	flexGrow,
	flexBasis,
	minWidth,
}: Props): React.ReactElement {
	const totalFixes = detectors.reduce((acc, d) => acc + d.pendingFixes, 0);
	return (
		<PanelFrame
			title="Detectors"
			titleColor={COLORS.warning}
			flexGrow={flexGrow}
			flexBasis={flexBasis}
			minWidth={minWidth}
		>
			{totalFixes > 0 && (
				<Box marginBottom={1}>
					<Alert variant="warning">{totalFixes} pending fixes</Alert>
				</Box>
			)}
			{detectors.map((d) => (
				<Box key={d.id} gap={1}>
					<Box width={20}>
						<Text>{d.id}</Text>
					</Box>
					{d.status === "running" ? (
						<Spinner label="scanning" />
					) : (
						<Badge color={STATUS_COLOR[d.status]}>{d.status}</Badge>
					)}
					{d.pendingFixes > 0 && (
						<Text color={COLORS.warning}>
							{d.pendingFixes} fix{d.pendingFixes === 1 ? "" : "es"}
						</Text>
					)}
					{d.pendingFixes === 0 && d.filesScanned !== null && d.status !== "running" && (
						<Text color={COLORS.muted}>
							({d.filesScanned} file{d.filesScanned === 1 ? "" : "s"})
						</Text>
					)}
				</Box>
			))}
		</PanelFrame>
	);
}
