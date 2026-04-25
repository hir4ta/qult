/**
 * Live UI for `qult check --detect`. Renders a row per detector with a
 * Spinner while running, a Badge (pass / warn / fail / skipped) when done,
 * a global ProgressBar, and an Alert summary on completion.
 *
 * The actual detector orchestration runs outside React (`runAllDetectors`
 * with the `onProgress` callback); this component just reflects state.
 */

import { Alert, Badge, ProgressBar, Spinner } from "@inkjs/ui";
import { Box, Text, useApp } from "ink";
import { useEffect, useState } from "react";
import {
	type DetectorName,
	type DetectorProgressEvent,
	type DetectorResult,
	runAllDetectors,
} from "../../detector/index.ts";
import { COLORS } from "../theme.ts";

const DETECTOR_ORDER: DetectorName[] = [
	"security-check",
	"dep-vuln-check",
	"hallucinated-package-check",
	"test-quality-check",
	"export-check",
];

type RowStatus = "pending" | "running" | "pass" | "warn" | "fail" | "skipped";

interface Row {
	detector: DetectorName;
	status: RowStatus;
	count: number;
	skipReason?: string;
	durationMs?: number;
}

export interface DetectRunSummary {
	totalFixes: number;
	high: number;
}

interface RunnerProps {
	files: string[];
	cwd: string;
	onComplete: (results: DetectorResult[], summary: DetectRunSummary) => void;
}

export function DetectRunner({ files, cwd, onComplete }: RunnerProps): React.ReactElement {
	const { exit } = useApp();
	const [rows, setRows] = useState<Row[]>(
		DETECTOR_ORDER.map((d) => ({ detector: d, status: "pending", count: 0 })),
	);
	const [completed, setCompleted] = useState(0);
	const [done, setDone] = useState(false);
	const [summary, setSummary] = useState<{ totalFixes: number; high: number } | null>(null);

	useEffect(() => {
		let cancelled = false;
		const startedAt = new Map<DetectorName, number>();
		const onProgress = (e: DetectorProgressEvent): void => {
			if (cancelled) return;
			if (e.kind === "start") {
				startedAt.set(e.detector, Date.now());
				setRows((prev) =>
					prev.map((r) => (r.detector === e.detector ? { ...r, status: "running" } : r)),
				);
			} else {
				const result = e.result;
				const duration = Date.now() - (startedAt.get(e.detector) ?? Date.now());
				const status: RowStatus = !result
					? "fail"
					: result.skipped
						? "skipped"
						: result.fixes.length === 0
							? "pass"
							: result.fixes.some((f) => (f.errors?.length ?? 0) > 0)
								? "fail"
								: "warn";
				setRows((prev) =>
					prev.map((r) =>
						r.detector === e.detector
							? {
									...r,
									status,
									count: result?.fixes.length ?? 0,
									skipReason: result?.skipReason,
									durationMs: duration,
								}
							: r,
					),
				);
				setCompleted((n) => n + 1);
			}
		};

		(async () => {
			try {
				const results = await runAllDetectors(files, { cwd, onProgress });
				if (cancelled) return;
				const totalFixes = results.reduce((acc, r) => acc + r.fixes.length, 0);
				const high = results.reduce(
					(acc, r) => acc + r.fixes.filter((f) => (f.errors?.length ?? 0) > 0).length,
					0,
				);
				const summary = { totalFixes, high };
				setSummary(summary);
				setDone(true);
				onComplete(results, summary);
				// Give Ink a tick to flush the final frame before unmounting.
				setTimeout(() => exit(), 100);
			} catch (err) {
				if (cancelled) return;
				setRows((prev) =>
					prev.map((r) => ({ ...r, status: r.status === "running" ? "fail" : r.status })),
				);
				const summary = { totalFixes: 0, high: 0 };
				setSummary(summary);
				setDone(true);
				onComplete([], summary);
				setTimeout(() => exit(err instanceof Error ? err : new Error(String(err))), 100);
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [files, cwd, exit, onComplete]);

	const pct = Math.round((completed / DETECTOR_ORDER.length) * 100);

	return (
		<Box flexDirection="column" padding={1}>
			<Box marginBottom={1} gap={1}>
				<Text color={COLORS.primary} bold>
					qult check --detect
				</Text>
				<Text color={COLORS.muted}>·</Text>
				<Text color={COLORS.accent}>
					{completed}/{DETECTOR_ORDER.length} detectors
				</Text>
				<Box flexGrow={1} />
				<Text color={COLORS.muted}>{pct}%</Text>
			</Box>
			<Box marginBottom={1}>
				<ProgressBar value={pct} />
			</Box>
			<Box flexDirection="column" gap={0}>
				{rows.map((row) => (
					<DetectorRow key={row.detector} row={row} />
				))}
			</Box>
			{done && summary && (
				<Box marginTop={1}>
					<Alert
						variant={summary.high > 0 ? "error" : summary.totalFixes > 0 ? "warning" : "success"}
					>
						{summary.high > 0
							? `${summary.high} high-severity finding${summary.high === 1 ? "" : "s"} (total ${summary.totalFixes} pending fix${summary.totalFixes === 1 ? "" : "es"})`
							: summary.totalFixes > 0
								? `${summary.totalFixes} pending fix${summary.totalFixes === 1 ? "" : "es"} — no high severity`
								: "all clear — no findings"}
					</Alert>
				</Box>
			)}
		</Box>
	);
}

function DetectorRow({ row }: { row: Row }): React.ReactElement {
	return (
		<Box gap={1}>
			<Box width={28}>
				<Text>{row.detector}</Text>
			</Box>
			<RowStatusIndicator row={row} />
			<Box flexGrow={1} />
			{row.durationMs !== undefined && (
				<Text color={COLORS.muted}>{Math.round(row.durationMs)}ms</Text>
			)}
		</Box>
	);
}

function RowStatusIndicator({ row }: { row: Row }): React.ReactElement {
	switch (row.status) {
		case "pending":
			return <Text color={COLORS.muted}>queued</Text>;
		case "running":
			return <Spinner label="running" />;
		case "pass":
			return <Badge color={COLORS.success}>pass</Badge>;
		case "warn":
			return (
				<Box gap={1}>
					<Badge color={COLORS.warning}>warn</Badge>
					<Text color={COLORS.warning}>
						{row.count} fix{row.count === 1 ? "" : "es"}
					</Text>
				</Box>
			);
		case "fail":
			return (
				<Box gap={1}>
					<Badge color={COLORS.error}>fail</Badge>
					<Text color={COLORS.error}>
						{row.count} fix{row.count === 1 ? "" : "es"}
					</Text>
				</Box>
			);
		case "skipped":
			return (
				<Box gap={1}>
					<Badge color={COLORS.muted}>skipped</Badge>
					{row.skipReason && <Text color={COLORS.muted}>{row.skipReason}</Text>}
				</Box>
			);
	}
}
