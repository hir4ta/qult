import { createCliRenderer } from "@opentui/core";
import { createRoot, useKeyboard, useRenderer } from "@opentui/react";
import { useState, useEffect, useCallback, createElement } from "react";
import { openDefaultCached } from "../store/index.js";
import { type TaskInfo, loadTasks, resolveProject } from "./data.js";

// --- Everforest Dark palette ---
const C = {
	fg: "#d3c6aa",         // primary text
	fgBright: "#e6ddc4",   // emphasized text
	fgMuted: "#9da9a0",    // secondary text
	fgDim: "#5c6a72",      // subtle / disabled
	accent: "#7fbbb3",     // aqua — active items, focused borders
	accentBright: "#a7d4cb", // shimmer highlight
	green: "#a7c080",      // completed tasks
	yellow: "#dbbc7f",     // in-progress
	orange: "#e69875",     // wave headers
	red: "#e67e80",        // closing wave
	purple: "#d699b6",     // review tasks
	blue: "#7fbbb3",       // progress bar filled
	border: "#414b50",     // borders
	selectedBg: "#343f44", // selected item bg
};

// --- Shimmer ---

function useShimmer(speed = 150) {
	const [frame, setFrame] = useState(0);
	useEffect(() => {
		const id = setInterval(() => setFrame((f) => f + 1), speed);
		return () => clearInterval(id);
	}, [speed]);
	return frame;
}

function ShimmerText({ text, baseColor = "#e69875", brightColor = "#f0c5a0", speed = 120, width = 3 }: {
	text: string; baseColor?: string; brightColor?: string; speed?: number; width?: number;
}) {
	const frame = useShimmer(speed);
	const len = text.length;
	const cycle = len + width + 4;
	const pos = frame % cycle;
	const hlStart = Math.max(0, pos - width);
	const hlEnd = Math.min(len, pos);
	const before = text.slice(0, hlStart);
	const highlight = text.slice(hlStart, hlEnd);
	const after = text.slice(hlEnd);

	return (
		<box style={{ flexDirection: "row", height: 1 }}>
			{before && <text content={before} fg={baseColor} />}
			{highlight && <text content={highlight} fg={brightColor} />}
			{after && <text content={after} fg={baseColor} />}
		</box>
	);
}

// --- Components ---

function ProgressBar({ value, total, width = 20, showPercent = false, color: overrideColor }: { value: number; total: number; width?: number; showPercent?: boolean; color?: string }) {
	const pct = total > 0 ? value / total : 0;
	const filled = Math.round(pct * width);
	const color = overrideColor ?? (pct >= 1 ? C.green : C.blue);
	const label = showPercent ? `${Math.round(pct * 100)}%` : `${value}/${total}`;

	return (
		<text>
			<span fg={color}>{"━".repeat(filled)}</span>
			<span fg={C.fgDim}>{"─".repeat(width - filled)}</span>
			<span fg={C.fgMuted}> {label}</span>
		</text>
	);
}

// --- Spec List (left panel) ---

function SpecList({ tasks, selectedIdx }: { tasks: TaskInfo[]; selectedIdx: number }) {
	if (tasks.length === 0) {
		return (
			<box style={{ padding: 1 }}>
				<text fg={C.fgMuted}>No active specs.</text>
			</box>
		);
	}

	return (
		<box style={{ borderStyle: "rounded", borderColor: C.border, flexDirection: "column", flexGrow: 1, overflow: "hidden" }}>
			{tasks.map((task, i) => {
				const isSelected = i === selectedIdx;
				const bg = isSelected ? C.selectedBg : undefined;
				const indicator = isSelected ? "▸ " : "  ";

				return (
					<box key={task.slug} style={{ paddingX: 1, paddingY: 1, backgroundColor: bg, flexDirection: "column" }}>
						<text content={`${indicator}${task.slug}`} fg={isSelected ? C.fgBright : C.fg} />
						<text content={`  Size: ${task.size}`} fg={C.fgDim} />
						<box style={{ paddingLeft: 2 }}>
							<ProgressBar value={task.completed} total={task.total} width={15} showPercent />
						</box>
					</box>
				);
			})}
		</box>
	);
}

// --- Spec Detail (right panel) ---

function SpecDetail({ task, focused }: { task: TaskInfo; focused: boolean }) {
	return (
		<box style={{ borderStyle: "rounded", borderColor: focused ? C.accent : C.border, flexDirection: "column", flexGrow: 1 }}>
		<scrollbox focused={focused} style={{ contentOptions: { flexDirection: "column", padding: 1, gap: 1 } }}>
			{task.waves.map((wave) => {
				const done = wave.total > 0 && wave.checked === wave.total;
				const isCur = wave.isCurrent;
				const isClosing = wave.key === "closing";
				const waveLabel = isClosing ? "Closing" : `Wave ${wave.key}`;
				const headerText = `${waveLabel}: ${wave.title}`;
				// Color per wave type
				const waveColor = isClosing ? C.red : done ? C.green : isCur ? C.orange : C.fgMuted;
				const barColor = isClosing ? C.red : done ? C.green : C.blue;

				return (
					<box key={wave.key} style={{ flexDirection: "column" }}>
						{/* Wave header */}
						{isCur
							? <ShimmerText text={`▸ ${headerText}`} speed={100} width={4} />
							: <text content={`  ${headerText}`} fg={waveColor} />
						}
						{/* Wave progress */}
						<box style={{ paddingLeft: 4 }}>
							<ProgressBar value={wave.checked} total={wave.total} width={20} color={barColor} />
						</box>
						{/* Individual tasks */}
						{wave.tasks && wave.tasks.map((t) => {
							const isReview = /T-\d+\.R\b/i.test(t.id) || /review|レビュー/i.test(t.label);
							let icon: string;
							let color: string;
							if (t.checked) {
								icon = "✓";
								color = isClosing ? C.red : isReview ? C.purple : C.green;
							} else if (isCur) {
								icon = "○";
								color = isReview ? C.purple : C.fg;
							} else {
								icon = "·";
								color = C.fgDim;
							}
							return (
								<box key={t.id} style={{ paddingLeft: 4 }}>
									<text content={`${icon} ${t.label}`} fg={color} />
								</box>
							);
						})}
					</box>
				);
			})}
		</scrollbox>
		</box>
	);
}

// --- App (exported for cli.ts integration) ---

export { App };

function App({ showAll = false }: { showAll?: boolean }) {
	const [tasks, setTasks] = useState<TaskInfo[]>([]);
	const [selectedIdx, setSelectedIdx] = useState(0);
	const [projName, setProjName] = useState("");
	const [detailFocused, setDetailFocused] = useState(false);

	const refresh = useCallback(() => {
		const store = openDefaultCached();
		const proj = resolveProject(store);
		setProjName(proj.name);
		const allTasks = loadTasks(proj.path, proj.name, { showAll });
		setTasks(showAll ? allTasks : allTasks.filter((t) => t.status !== "done" && t.status !== "completed" && t.status !== "cancelled"));
	}, [showAll]);

	useEffect(() => {
		refresh();
		const interval = setInterval(refresh, 3000);
		return () => clearInterval(interval);
	}, [refresh]);

	const renderer = useRenderer();
	useKeyboard((key) => {
		if (key.ctrl && key.name === "c") {
			renderer.destroy();
			process.exit(0);
		}
		if (detailFocused) {
			if (key.name === "escape") {
				setDetailFocused(false);
			}
			return;
		}
		if (key.name === "j" || key.name === "down") {
			setSelectedIdx((prev) => Math.min(prev + 1, tasks.length - 1));
		} else if (key.name === "k" || key.name === "up") {
			setSelectedIdx((prev) => Math.max(prev - 1, 0));
		} else if (key.name === "return" && tasks.length > 0) {
			setDetailFocused(true);
		}
	});

	const selected = tasks[selectedIdx];

	return (
		<box style={{ flexDirection: "column", width: "100%", height: "100%" }}>
			{/* Header */}
			<box style={{ flexDirection: "row", paddingX: 1, height: 1 }}>
				<text>
					<span fg={C.accent}>alfred</span>
					<span fg={C.fgDim}> · {projName} · </span>
					<span fg={C.fgMuted}>{tasks.length} active</span>
					<span fg={C.fgDim}> │ {detailFocused ? "↑↓ scroll · esc back" : "j/k navigate · enter detail"} · ctrl+c quit</span>
				</text>
			</box>

			{/* 2-column layout */}
			<box style={{ flexGrow: 1, paddingX: 1, paddingBottom: 1, flexDirection: "row", gap: 1 }}>
				<box style={{ width: "30%", flexDirection: "column" }}>
					<SpecList tasks={tasks} selectedIdx={selectedIdx} />
				</box>
				<box style={{ width: "70%", flexDirection: "column" }}>
					{selected
						? <SpecDetail task={selected} focused={detailFocused} />
						: <box style={{ padding: 1 }}><text fg={C.fgMuted}>No active specs.</text></box>
					}
				</box>
			</box>
		</box>
	);
}

// --- Entry point (exported for cli.ts integration) ---
export function runTui(opts?: { showAll?: boolean }) {
	const showAll = opts?.showAll ?? false;
	return new Promise<void>((resolve, reject) => {
		createCliRenderer({
			exitOnCtrlC: true,
			onDestroy: () => {
				process.stdout.write("\x1b[?1000l\x1b[?1003l\x1b[?1006l");
				resolve();
			},
		}).then((renderer) => {
			process.once("uncaughtException", (err) => {
				renderer.destroy();
				console.error(err);
				process.exit(1);
			});
			process.once("unhandledRejection", (err) => {
				renderer.destroy();
				console.error(err);
				process.exit(1);
			});

			createRoot(renderer).render(<App showAll={showAll} />);
		}).catch(reject);
	});
}

// Auto-run when executed directly (e.g. `bun src/tui/main.tsx --all`)
if (import.meta.main) {
	const showAll = process.argv.includes("--all");
	runTui({ showAll });
}
