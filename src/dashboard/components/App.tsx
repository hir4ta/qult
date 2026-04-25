/**
 * Dashboard root. Wraps everything in `ThemeProvider`, runs the watcher /
 * reducer hook, and lays out the four panels (Wave / Detector / Review /
 * EventLog) below the Header. Wave 4 will swap the static `flexDirection`
 * for layout-tier-driven row/column switching.
 */

import { ThemeProvider } from "@inkjs/ui";
import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import { useDashboardState } from "../hooks/useDashboardState.ts";
import { useExitKeys } from "../hooks/useExitKeys.ts";
import { COLORS, qultTheme } from "../theme.ts";
import { DetectorPanel } from "./DetectorPanel.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { EventLog } from "./EventLog.tsx";
import { Header } from "./Header.tsx";
import { ReviewPanel } from "./ReviewPanel.tsx";
import { WavePanel } from "./WavePanel.tsx";

const STARTED_AT = Date.now();

export function App(): React.ReactElement {
	useExitKeys();
	const [now, setNow] = useState(STARTED_AT);
	useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(id);
	}, []);

	const state = useDashboardState({
		startedAt: STARTED_AT,
		terminal: { columns: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 },
	});

	const showEmpty = state.activeSpec === null;

	return (
		<ThemeProvider theme={qultTheme}>
			<Box flexDirection="column" padding={1}>
				<Header
					version={state.qultVersion}
					activeSpec={state.activeSpec}
					startedAt={STARTED_AT}
					now={now}
				/>
				{showEmpty ? (
					<EmptyState />
				) : (
					<Box flexDirection="column" gap={1}>
						<Box flexDirection="row" gap={1}>
							<WavePanel waves={state.waves} flexGrow={1} minWidth={28} />
							<DetectorPanel detectors={state.detectors} flexGrow={1} minWidth={28} />
							<ReviewPanel reviews={state.reviews} flexGrow={1} minWidth={28} />
						</Box>
						<EventLog events={state.events} maxLines={8} flexGrow={1} />
					</Box>
				)}
				{state.errors.length > 0 && (
					<Box marginTop={1}>
						<Text color={COLORS.error}>{state.errors[state.errors.length - 1]}</Text>
					</Box>
				)}
				<Box marginTop={1}>
					<Text color={COLORS.muted}>press </Text>
					<Text color={COLORS.warning} bold>
						q
					</Text>
					<Text color={COLORS.muted}> or </Text>
					<Text color={COLORS.warning} bold>
						Ctrl+C
					</Text>
					<Text color={COLORS.muted}> to exit</Text>
				</Box>
			</Box>
		</ThemeProvider>
	);
}
