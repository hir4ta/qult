/**
 * Dashboard root. Wraps everything in `ThemeProvider`, runs the watcher /
 * reducer hook, and lays out the four panels (Wave / Detector / Review /
 * EventLog) below the Header. Layout switches between three tiers based on
 * terminal columns/rows; `useTerminalSize` handles debounced resize +
 * hysteresis so the UI doesn't flicker when the user drags a corner.
 */

import { ThemeProvider } from "@inkjs/ui";
import { Box, Text } from "ink";
import React from "react";
import { useDashboardState } from "../hooks/useDashboardState.ts";
import { useDetectorScan } from "../hooks/useDetectorScan.ts";
import { useExitKeys } from "../hooks/useExitKeys.ts";
import { useTerminalSize } from "../hooks/useTerminalSize.ts";
import { COLORS, qultTheme } from "../theme.ts";
import { DetectorPanel } from "./DetectorPanel.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { ErrorBanner } from "./ErrorBanner.tsx";
import { EventLog } from "./EventLog.tsx";
import { Header } from "./Header.tsx";
import { ReviewPanel } from "./ReviewPanel.tsx";
import { WavePanel } from "./WavePanel.tsx";

const STARTED_AT = Date.now();

export function App(): React.ReactElement {
	useExitKeys();
	const { size, layout } = useTerminalSize();
	const state = useDashboardState({
		startedAt: STARTED_AT,
		terminal: size,
	});
	// Live detector status — runs once on mount, in-memory only.
	// Replaces the snapshot-derived detectors so the panel never sits at
	// `never-run` when the user just opened the dashboard.
	const scan = useDetectorScan();

	// We always render the panel grid — even with empty data — so the
	// frame height is stable across the snapshot transition. An initial
	// "EmptyState"-only frame is short, and when state arrives the new
	// taller frame appended below leaving the original banner stuck at
	// the top of the scrollback.
	const tier = layout.tier;

	return (
		<ThemeProvider theme={qultTheme}>
			<Box flexDirection="column" padding={1}>
				<Header version={state.qultVersion} activeSpec={state.activeSpec} columns={size.columns} />
				<Box flexDirection="column" gap={1}>
					<PanelGrid tier={tier}>
						<WavePanel waves={state.waves} flexGrow={1} minWidth={28} />
						<DetectorPanel detectors={scan.detectors} flexGrow={1} minWidth={28} />
						<ReviewPanel reviews={state.reviews} flexGrow={1} minWidth={28} />
					</PanelGrid>
					{state.activeSpec === null && (
						<Box paddingX={2}>
							<EmptyState />
						</Box>
					)}
					{tier !== "narrow" && (
						<EventLog events={state.events} maxLines={layout.eventLogLines} flexGrow={1} />
					)}
				</Box>
				<ErrorBanner errors={state.errors} />
				<Box marginTop={1}>
					<Text color={COLORS.muted}>press </Text>
					<Text color={COLORS.warning} bold>
						q
					</Text>
					<Text color={COLORS.muted}> or </Text>
					<Text color={COLORS.warning} bold>
						Ctrl+C
					</Text>
					<Text color={COLORS.muted}> to exit · {tier} layout</Text>
				</Box>
			</Box>
		</ThemeProvider>
	);
}

interface GridProps {
	tier: "wide" | "medium" | "narrow";
	children: React.ReactNode;
}

/**
 * Translate the layout tier into a grid arrangement of the three primary
 * panels. Wide → row of 3, Medium → wave on top + (detector | review) row,
 * Narrow → all stacked vertically.
 */
function PanelGrid({ tier, children }: GridProps): React.ReactElement {
	const panels = React.Children.toArray(children);
	const [waves, detectors, reviews] = [panels[0], panels[1], panels[2]];

	if (tier === "wide") {
		return (
			<Box flexDirection="row" gap={1}>
				{waves}
				{detectors}
				{reviews}
			</Box>
		);
	}
	if (tier === "medium") {
		return (
			<Box flexDirection="column" gap={1}>
				{waves}
				<Box flexDirection="row" gap={1}>
					{detectors}
					{reviews}
				</Box>
			</Box>
		);
	}
	return (
		<Box flexDirection="column" gap={1}>
			{waves}
			{detectors}
			{reviews}
		</Box>
	);
}
