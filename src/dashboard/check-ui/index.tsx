/**
 * Entry point for the Ink-rendered `qult check --detect` UI. The CLI
 * command lazy-imports this module so the dashboard bundle (and ink/react
 * footprint) stays out of the cold path of `qult check` without `--detect`.
 */

import { ThemeProvider } from "@inkjs/ui";
import { render } from "ink";
import type { DetectorResult } from "../../detector/index.ts";
import { qultTheme } from "../theme.ts";
import { DetectRunner, type DetectRunSummary } from "./DetectRunner.tsx";

export interface RunDetectUIOptions {
	files: string[];
	cwd: string;
}

export interface RunDetectUIResult {
	results: DetectorResult[];
	totalFixes: number;
	high: number;
}

export async function runDetectUI(opts: RunDetectUIOptions): Promise<RunDetectUIResult> {
	let captured: DetectorResult[] = [];
	let summary: DetectRunSummary = { totalFixes: 0, high: 0 };
	const onComplete = (results: DetectorResult[], s: DetectRunSummary): void => {
		captured = results;
		summary = s;
	};
	const { waitUntilExit } = render(
		<ThemeProvider theme={qultTheme}>
			<DetectRunner files={opts.files} cwd={opts.cwd} onComplete={onComplete} />
		</ThemeProvider>,
	);
	await waitUntilExit();
	return { results: captured, totalFixes: summary.totalFixes, high: summary.high };
}
