/**
 * Recent events stream. Shows the most recent N events as colored rows
 * (newest on top), trimmed to whatever vertical space we have. The
 * `maxLines` prop is computed by the layout hook based on terminal rows.
 */

import { StatusMessage } from "@inkjs/ui";
import { Box, Text } from "ink";
import { COLORS, severityColor } from "../theme.ts";
import type { DashboardEvent, EventVariant } from "../types.ts";
import { PanelFrame } from "./PanelFrame.tsx";

interface Props {
	events: DashboardEvent[];
	maxLines: number;
	flexGrow?: number;
}

export function EventLog({ events, maxLines, flexGrow }: Props): React.ReactElement {
	const tail = events.slice(-maxLines).reverse();
	return (
		<PanelFrame title="Recent events" titleColor={COLORS.success} flexGrow={flexGrow}>
			{tail.length === 0 ? (
				<Text color={COLORS.muted}>(idle — waiting for state changes)</Text>
			) : (
				tail.map((e) => <EventRow key={e.id} event={e} />)
			)}
		</PanelFrame>
	);
}

function EventRow({ event }: { event: DashboardEvent }): React.ReactElement {
	const ts = new Date(event.ts).toISOString().slice(11, 19);
	return (
		<Box gap={1}>
			<Text color={COLORS.muted}>{ts}</Text>
			<StatusMessage variant={inkVariant(event.variant)}>{event.message}</StatusMessage>
		</Box>
	);
}

function inkVariant(v: EventVariant): "success" | "warning" | "error" | "info" {
	// StatusMessage from @inkjs/ui supports the same 4 variants; we just
	// keep the local alias type so callers don't import their enum.
	void severityColor; // ensure tree-shaking keeps the helper for theme tests
	return v;
}
