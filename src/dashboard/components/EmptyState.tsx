/**
 * Shown when no active spec exists. We keep the dashboard alive (FR-1) so
 * the moment a spec appears the watcher transitions us into the live UI
 * automatically — no restart needed.
 */

import { Spinner } from "@inkjs/ui";
import { Box, Text } from "ink";
import { COLORS } from "../theme.ts";

export function EmptyState(): React.ReactElement {
	return (
		<Box flexDirection="column" padding={2} alignItems="center">
			<Box marginBottom={1}>
				<Spinner label="waiting for an active spec" />
			</Box>
			<Text color={COLORS.muted}>
				Run <Text color={COLORS.accent}>/qult:spec &lt;name&gt;</Text> to begin.
			</Text>
			<Text color={COLORS.muted}>
				This view will refresh as soon as a spec lands under{" "}
				<Text color={COLORS.primary}>.qult/specs/</Text>.
			</Text>
		</Box>
	);
}
