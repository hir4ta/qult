/**
 * 4-stage review summary: Spec / Quality / Security / Adversarial. Each row
 * shows a colored Badge (pass / below / pending) and the score over 20.
 * Mirrors qult's "AI self-review doesn't work — independent review required"
 * principle by surfacing each stage independently rather than a single total.
 */

import { Badge } from "@inkjs/ui";
import { Box, Text } from "ink";
import { COLORS } from "../theme.ts";
import type { ReviewStageEntry, ReviewStageSummary } from "../types.ts";
import { PanelFrame } from "./PanelFrame.tsx";

interface Props {
	reviews: ReviewStageSummary;
	flexGrow?: number;
	flexBasis?: number | string;
	minWidth?: number;
}

const STAGE_LABELS: Array<[keyof ReviewStageSummary, string]> = [
	["spec", "Spec"],
	["quality", "Quality"],
	["security", "Security"],
	["adversarial", "Adversarial"],
];

export function ReviewPanel({ reviews, flexGrow, flexBasis, minWidth }: Props): React.ReactElement {
	return (
		<PanelFrame
			title="Review (4 stages)"
			titleColor={COLORS.accent}
			flexGrow={flexGrow}
			flexBasis={flexBasis}
			minWidth={minWidth}
		>
			{STAGE_LABELS.map(([key, label]) => (
				<ReviewRow key={key} label={label} entry={reviews[key]} />
			))}
		</PanelFrame>
	);
}

function ReviewRow({
	label,
	entry,
}: {
	label: string;
	entry: ReviewStageEntry;
}): React.ReactElement {
	const { color, text } = badgeFor(entry);
	return (
		<Box gap={1}>
			<Box width={14}>
				<Text>{label}</Text>
			</Box>
			<Badge color={color}>{text}</Badge>
			<Box flexGrow={1} />
			<Text color={COLORS.muted}>
				{entry.score === null ? "—" : `${entry.score}/20`} (≥{entry.threshold})
			</Text>
		</Box>
	);
}

function badgeFor(entry: ReviewStageEntry): { color: string; text: string } {
	if (entry.score === null) return { color: COLORS.muted, text: "pending" };
	return entry.passed
		? { color: COLORS.success, text: "pass" }
		: { color: COLORS.warning, text: "below" };
}
