/**
 * Surface the most recent watcher / parse error without taking the dashboard
 * down. Hidden when no errors are recorded in the reducer state.
 */

import { Alert } from "@inkjs/ui";
import { Box } from "ink";

interface Props {
	errors: string[];
}

export function ErrorBanner({ errors }: Props): React.ReactElement | null {
	if (errors.length === 0) return null;
	return (
		<Box marginTop={1}>
			<Alert variant="error" title="dashboard error (UI continues)">
				{errors[errors.length - 1] ?? ""}
			</Alert>
		</Box>
	);
}
