import { createCliRenderer } from "@opentui/core";
import { createRoot, useKeyboard, useRenderer } from "@opentui/react";
import { useState, useEffect, useCallback, createElement } from "react";
import { openDefaultCached } from "../store/index.js";
import { type TaskInfo, loadTasks, resolveProject } from "./data.js";

// --- Gruvbox Dark palette ---
const C = {
	fg: "#ebdbb2",         // primary text
	fgBright: "#fbf1c7",   // emphasized text
	fgMuted: "#a89984",    // secondary text
	fgDim: "#665c54",      // subtle / disabled
	accent: "#83a598",     // active items (blue)
	accentBright: "#b8d4c3", // shimmer highlight
	done: "#b8bb26",       // completed (green)
	progress: "#fabd2f",   // in-progress (yellow)
	border: "#504945",     // borders
	selectedBg: "#3c3836", // selected item bg
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

function ShimmerText({ text, baseColor = "#fe8019", brightColor = "#ffc07a", speed = 120, width = 3 }: {
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

function ProgressBar({ value, total, width = 20, showPercent = false }: { value: number; total: number; width?: number; showPercent?: boolean }) {
	const pct = total > 0 ? value / total : 0;
	const filled = Math.round(pct * width);
	const color = pct >= 1 ? C.done : C.progress;
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
				const waveLabel = wave.key === "closing" ? "Closing" : `Wave ${wave.key}`;
				const headerText = `${waveLabel}: ${wave.title}`;

				return (
					<box key={wave.key} style={{ flexDirection: "column" }}>
						{/* Wave header */}
						{isCur
							? <ShimmerText text={`▸ ${headerText}`} speed={100} width={4} />
							: <text content={`  ${headerText}`} fg={done ? C.done : C.fgMuted} />
						}
						{/* Wave progress */}
						<box style={{ paddingLeft: 4 }}>
							<ProgressBar value={wave.checked} total={wave.total} width={20} />
						</box>
						{/* Individual tasks */}
						{wave.tasks && wave.tasks.map((t) => {
							const icon = t.checked ? "✓" : isCur ? "○" : "·";
							const color = t.checked ? C.done : isCur ? C.fg : C.fgDim;
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

function App() {
	const [tasks, setTasks] = useState<TaskInfo[]>([]);
	const [selectedIdx, setSelectedIdx] = useState(0);
	const [projName, setProjName] = useState("");
	const [detailFocused, setDetailFocused] = useState(false);

	const refresh = useCallback(() => {
		const store = openDefaultCached();
		const proj = resolveProject(store);
		setProjName(proj.name);
		const allTasks = loadTasks(proj.path, proj.name);
		setTasks(allTasks.filter((t) => t.status === "active"));
	}, []);

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

// --- Entry point ---
const renderer = await createCliRenderer({
	exitOnCtrlC: true,
	onDestroy: () => {
		process.stdout.write("\x1b[?1000l\x1b[?1003l\x1b[?1006l");
	},
});

process.on("uncaughtException", (err) => {
	renderer.destroy();
	console.error(err);
	process.exit(1);
});
process.on("unhandledRejection", (err) => {
	renderer.destroy();
	console.error(err);
	process.exit(1);
});

createRoot(renderer).render(<App />);
