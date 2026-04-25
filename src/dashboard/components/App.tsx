/**
 * Wave 1 dashboard skeleton — confirms the Ink pipeline is wired end-to-end.
 *
 * Wave 3 replaces the body with the real Header / WavePanel / DetectorPanel /
 * ReviewPanel / EventLog composition. We keep this file so `qult dashboard`
 * is launchable and exit keys (q / Ctrl+C) are verified before we layer in
 * watcher + reducer plumbing.
 */

import { Box, Text } from "ink";
import { useExitKeys } from "../hooks/useExitKeys.ts";

declare const __QULT_VERSION__: string;
const VERSION = typeof __QULT_VERSION__ !== "undefined" ? __QULT_VERSION__ : "0.0.0-dev";

export function App(): React.ReactElement {
	useExitKeys();

	return (
		<Box flexDirection="column" padding={1}>
			<Box>
				<Text color="cyan" bold>
					qult
				</Text>
				<Text color="gray"> v{VERSION} </Text>
				<Text color="magenta">dashboard</Text>
			</Box>
			<Box marginTop={1}>
				<Text>Hello qult dashboard.</Text>
			</Box>
			<Box marginTop={1}>
				<Text color="gray">Press </Text>
				<Text color="yellow" bold>
					q
				</Text>
				<Text color="gray"> or </Text>
				<Text color="yellow" bold>
					Ctrl+C
				</Text>
				<Text color="gray"> to exit.</Text>
			</Box>
		</Box>
	);
}
