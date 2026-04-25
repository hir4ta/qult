/**
 * Entry point for the Ink-rendered `qult check --detect` UI. The CLI
 * command lazy-imports this module so the dashboard bundle (and ink/react
 * footprint) stays out of the cold path of `qult check` without `--detect`.
 */

import { ThemeProvider } from "@inkjs/ui";
import { render } from "ink";
import type { DetectorResult } from "../../detector/index.ts";
import { qultTheme } from "../theme.ts";
import { DetectRunner } from "./DetectRunner.tsx";

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
	const onComplete = (results: DetectorResult[]): void => {
		captured = results;
	};
	const { waitUntilExit } = render(
		<ThemeProvider theme={qultTheme}>
			<DetectRunner files={opts.files} cwd={opts.cwd} onComplete={onComplete} />
		</ThemeProvider>,
	);
	await waitUntilExit();
	const totalFixes = captured.reduce((acc, r) => acc + r.fixes.length, 0);
	const high = captured.reduce(
		(acc, r) => acc + r.fixes.filter((f) => (f.errors?.length ?? 0) > 0).length,
		0,
	);
	return { results: captured, totalFixes, high };
}
