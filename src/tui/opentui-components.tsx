/**
 * OpenTUI Component Showcase — all 15 components in one TUI.
 * Run: bun src/tui/opentui-components.tsx
 *
 * Navigation: Tab/Shift+Tab to switch sections, j/k to scroll, q to quit.
 */
import { createCliRenderer } from "@opentui/core";
import { createRoot, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { createElement, useState } from "react";

// --- Palette ---
const C = {
	bg: "#1c1917",
	fg: "#d3c6aa",
	dim: "#5c6a72",
	accent: "#7fbbb3",
	green: "#a7c080",
	yellow: "#dbbc7f",
	orange: "#e69875",
	red: "#e67e80",
	purple: "#d699b6",
	border: "#414b50",
	selectedBg: "#343f44",
};

// --- Section definitions ---
const SECTIONS = [
	"text+span",
	"box",
	"scrollbox",
	"input",
	"textarea",
	"select",
	"tab-select",
	"slider",
	"ascii-font",
	"code",
	"markdown",
	"diff",
	"frame-buffer",
] as const;

type SectionKey = (typeof SECTIONS)[number];

// --- Section Components ---

function TextDemo() {
	return (
		<box style={{ flexDirection: "column", gap: 1, padding: 1 }}>
			<text content="1. Text + Span" fg={C.orange} />
			<text>
				<span fg={C.fg}>Normal </span>
				<strong fg={C.accent}>Bold </strong>
				<em fg={C.green}>Italic </em>
				<u fg={C.yellow}>Underline </u>
				<span fg={C.red}>Red </span>
				<span fg={C.purple}>Purple</span>
			</text>
			<text content="Styled text with fg/bg:" fg={C.dim} />
			<text content="  Inverted " fg={C.bg} bg={C.accent} />
			<text content="  Dim text " fg={C.dim} />
			<text>
				<span fg={C.green}>Mixed: </span>
				<b fg={C.orange}>bold</b>
				<span fg={C.fg}> + </span>
				<i fg={C.purple}>italic</i>
				<span fg={C.fg}> + </span>
				<u fg={C.yellow}>underline</u>
			</text>
		</box>
	);
}

function BoxDemo() {
	return (
		<box style={{ flexDirection: "column", gap: 1, padding: 1 }}>
			<text content="2. Box (borders, titles, layout)" fg={C.orange} />
			<box style={{ flexDirection: "row", gap: 1 }}>
				<box
					style={{ borderStyle: "single", borderColor: C.accent, width: 20, height: 5, padding: 1 }}
					title="single"
				>
					<text content="single border" fg={C.fg} />
				</box>
				<box
					style={{ borderStyle: "double", borderColor: C.green, width: 20, height: 5, padding: 1 }}
					title="double"
				>
					<text content="double border" fg={C.fg} />
				</box>
				<box
					style={{
						borderStyle: "rounded",
						borderColor: C.yellow,
						width: 20,
						height: 5,
						padding: 1,
					}}
					title="rounded"
				>
					<text content="rounded border" fg={C.fg} />
				</box>
				<box
					style={{ borderStyle: "heavy", borderColor: C.red, width: 20, height: 5, padding: 1 }}
					title="heavy"
				>
					<text content="heavy border" fg={C.fg} />
				</box>
			</box>
			<box style={{ flexDirection: "row", gap: 2 }}>
				<box
					style={{
						borderStyle: "rounded",
						borderColor: C.border,
						width: 30,
						height: 4,
						padding: 1,
						justifyContent: "center",
						alignItems: "center",
					}}
				>
					<text content="centered content" fg={C.accent} />
				</box>
				<box
					style={{
						borderStyle: "rounded",
						borderColor: C.border,
						width: 30,
						height: 4,
						flexDirection: "row",
						gap: 1,
						padding: 1,
					}}
				>
					<text content="[A]" fg={C.green} />
					<text content="[B]" fg={C.yellow} />
					<text content="[C]" fg={C.red} />
					<text content="← row" fg={C.dim} />
				</box>
			</box>
		</box>
	);
}

function ScrollboxDemo() {
	const lines = Array.from(
		{ length: 30 },
		(_, i) => `Line ${i + 1}: ${i % 3 === 0 ? "important" : "normal"} content`,
	);
	return (
		<box style={{ flexDirection: "column", gap: 1, padding: 1 }}>
			<text content="3. ScrollBox (scroll with arrows/j/k when focused)" fg={C.orange} />
			<box
				style={{ borderStyle: "rounded", borderColor: C.border, width: 50, height: 10 }}
				title="scrollbox"
			>
				<scrollbox style={{ contentOptions: { flexDirection: "column", padding: 1 } }}>
					{lines.map((line, i) => (
						<text key={i} content={line} fg={i % 3 === 0 ? C.accent : C.fg} />
					))}
				</scrollbox>
			</box>
		</box>
	);
}

function InputDemo() {
	return (
		<box style={{ flexDirection: "column", gap: 1, padding: 1 }}>
			<text content="4. Input (single-line text input)" fg={C.orange} />
			<text content="Props: width, value, placeholder, maxLength, backgroundColor," fg={C.dim} />
			<text content="       focusedBackgroundColor, textColor, cursorColor" fg={C.dim} />
			<text content="Events: INPUT (keystroke), CHANGE (blur/enter), ENTER" fg={C.dim} />
			<box
				style={{ borderStyle: "rounded", borderColor: C.border, width: 40, height: 3, padding: 1 }}
				title="input preview"
			>
				<text content="Name: [Type here...          ]" fg={C.fg} />
			</box>
			<text
				content="Usage: <input width={25} placeholder='...' textColor={C.fg} />"
				fg={C.accent}
			/>
		</box>
	);
}

function TextareaDemo() {
	return (
		<box style={{ flexDirection: "column", gap: 1, padding: 1 }}>
			<text content="5. Textarea (multi-line text input)" fg={C.orange} />
			<text content="Props: width, height, initialValue, placeholder, wrapMode," fg={C.dim} />
			<text content="       textColor, cursorColor, selectionBg, keyBindings" fg={C.dim} />
			<text content="Events: onSubmit, onContentChange, onCursorChange" fg={C.dim} />
			<box
				style={{ borderStyle: "rounded", borderColor: C.border, width: 50, height: 6, padding: 1 }}
				title="textarea preview"
			>
				<text content="// Write code here" fg={C.green} />
				<text content="function hello() {" fg={C.fg} />
				<text content="  console.log('world');" fg={C.fg} />
				<text content="}" fg={C.fg} />
			</box>
		</box>
	);
}

function SelectDemo() {
	return (
		<box style={{ flexDirection: "column", gap: 1, padding: 1 }}>
			<text content="6. Select (dropdown list)" fg={C.orange} />
			<text content="Props: width, height, options[], selectedIndex, wrapSelection," fg={C.dim} />
			<text content="       textColor, selectedBackgroundColor, showDescription" fg={C.dim} />
			<text content="Events: ITEM_SELECTED, SELECTION_CHANGED" fg={C.dim} />
			<box
				style={{ borderStyle: "rounded", borderColor: C.border, width: 45, height: 7, padding: 1 }}
				title="select preview"
			>
				<text content="▸ brief       Planning & spec creation" fg={C.accent} bg={C.selectedBg} />
				<text content="  attend      Full autopilot implementation" fg={C.fg} />
				<text content="  mend        Bug fix workflow" fg={C.fg} />
				<text content="  tdd         Test-driven development" fg={C.fg} />
				<text content="  inspect     Multi-perspective code review" fg={C.fg} />
			</box>
		</box>
	);
}

function TabSelectDemo() {
	return (
		<box style={{ flexDirection: "column", gap: 1, padding: 1 }}>
			<text content="7. TabSelect (tab navigation)" fg={C.orange} />
			<text content="Props: width, tabWidth, options[], showDescription," fg={C.dim} />
			<text content="       showScrollArrows, showUnderline, wrapSelection" fg={C.dim} />
			<text content="Events: itemSelected, selectionChanged" fg={C.dim} />
			<box style={{ flexDirection: "row", height: 1 }}>
				<text content=" Overview " fg={C.bg} bg={C.accent} />
				<text content=" Tasks " fg={C.fg} />
				<text content=" Knowledge " fg={C.fg} />
				<text content=" Settings " fg={C.fg} />
			</box>
			<text content="────────────────────────────────────────" fg={C.accent} />
		</box>
	);
}

function SliderDemo() {
	return (
		<box style={{ flexDirection: "column", gap: 1, padding: 1 }}>
			<text content="8. Slider (horizontal & vertical)" fg={C.orange} />
			<text content="Props: orientation, value, min, max, viewPortSize," fg={C.dim} />
			<text content="       foregroundColor, backgroundColor, onChange" fg={C.dim} />
			<box style={{ flexDirection: "row", gap: 2 }}>
				<box style={{ flexDirection: "column", gap: 1 }}>
					<text content="Horizontal:" fg={C.dim} />
					<text content="━━━━━━━━━━━━━━━━━━━━───────────" fg={C.accent} />
					<text content="                    ^ 65/100" fg={C.dim} />
				</box>
				<box style={{ flexDirection: "column", gap: 1 }}>
					<text content="Vertical:" fg={C.dim} />
					<text content="  ┃" fg={C.border} />
					<text content="  ┃" fg={C.border} />
					<text content="  █" fg={C.green} />
					<text content="  █" fg={C.green} />
					<text content="  ┃" fg={C.border} />
					<text content="  ┃" fg={C.border} />
				</box>
			</box>
		</box>
	);
}

function AsciiFontDemo() {
	return (
		<box style={{ flexDirection: "column", gap: 1, padding: 1 }}>
			<text content="9. ASCIIFont (large text art)" fg={C.orange} />
			<ascii-font text="alfred" font="tiny" color={C.accent} />
			<ascii-font text="BUTLER" font="block" color={C.green} />
		</box>
	);
}

function CodeDemo() {
	const code = `import { Store } from "./store";

export function main() {
  const store = Store.openDefault();
  const tasks = store.listTasks();
  console.log(\`Found \${tasks.length} tasks\`);
}`;
	return (
		<box style={{ flexDirection: "column", gap: 1, padding: 1 }}>
			<text content="10. Code (syntax highlighting)" fg={C.orange} />
			<box
				style={{ borderStyle: "rounded", borderColor: C.border, width: 50, height: 10 }}
				title="code"
			>
				<code content={code} filetype="typescript" fg={C.fg} bg={C.selectedBg} />
			</box>
		</box>
	);
}

function MarkdownDemo() {
	const md = `# alfred
**Development butler** for Claude Code.

## Features
- Spec-driven development
- Knowledge persistence
- Self-review at every boundary

\`\`\`bash
alfred dashboard
\`\`\`

> Takes longer. Ships better.`;
	return (
		<box style={{ flexDirection: "column", gap: 1, padding: 1 }}>
			<text content="11. Markdown (rich rendering)" fg={C.orange} />
			<box style={{ borderStyle: "rounded", borderColor: C.border, width: 50, height: 14 }}>
				<markdown content={md} fg={C.fg} />
			</box>
		</box>
	);
}

function DiffDemo() {
	const diffStr = `diff --git a/src/types.ts b/src/types.ts
--- a/src/types.ts
+++ b/src/types.ts
@@ -47,8 +47,7 @@
 export interface TasksFile {
   slug: string;
-  waves: SpecWave[];
-  closing: SpecWave;
+  waves: SpecWave[]; // includes closing wave
   dependency_graph?: Record<string, string[]>;
 }`;
	return (
		<box style={{ flexDirection: "column", gap: 1, padding: 1 }}>
			<text content="12. Diff (unified/split)" fg={C.orange} />
			<box style={{ borderStyle: "rounded", borderColor: C.border, width: 60, height: 10 }}>
				<diff diff={diffStr} view="unified" filetype="typescript" fg={C.fg} />
			</box>
		</box>
	);
}

function FrameBufferDemo() {
	return (
		<box style={{ flexDirection: "column", gap: 1, padding: 1 }}>
			<text content="13. FrameBuffer (pixel-level drawing)" fg={C.orange} />
			<text content="  Low-level canvas for custom graphics." fg={C.dim} />
			<text content="  Methods: setCell, drawText, fillRect, drawFrameBuffer" fg={C.dim} />
			<text content="  Best used via Renderable API (not JSX)." fg={C.dim} />
			<box
				style={{ borderStyle: "rounded", borderColor: C.border, width: 30, height: 5, padding: 1 }}
			>
				<text content="████████████████████" fg={C.red} />
				<text content="████████████████████" fg={C.orange} />
				<text content="████████████████████" fg={C.yellow} />
			</box>
		</box>
	);
}

// --- Main App ---

const SECTION_COMPONENTS: Record<SectionKey, () => JSX.Element> = {
	"text+span": TextDemo,
	box: BoxDemo,
	scrollbox: ScrollboxDemo,
	input: InputDemo,
	textarea: TextareaDemo,
	select: SelectDemo,
	"tab-select": TabSelectDemo,
	slider: SliderDemo,
	"ascii-font": AsciiFontDemo,
	code: CodeDemo,
	markdown: MarkdownDemo,
	diff: DiffDemo,
	"frame-buffer": FrameBufferDemo,
};

function App() {
	const [sectionIdx, setSectionIdx] = useState(0);
	const renderer = useRenderer();

	useKeyboard((key) => {
		if (key.ctrl && key.name === "c") {
			renderer.destroy();
			process.exit(0);
		}
		if (key.name === "q") {
			renderer.destroy();
			process.exit(0);
		}
		// Navigate sections: h/l, left/right, j/k, up/down
		if (key.name === "l" || key.name === "right" || key.name === "j" || key.name === "down") {
			setSectionIdx((i) => (i + 1) % SECTIONS.length);
		}
		if (key.name === "h" || key.name === "left" || key.name === "k" || key.name === "up") {
			setSectionIdx((i) => (i - 1 + SECTIONS.length) % SECTIONS.length);
		}
		// Number keys for direct jump (1-9, 0=10)
		const num = parseInt(key.name ?? "", 10);
		if (!isNaN(num)) {
			const idx = num === 0 ? 9 : num - 1;
			if (idx < SECTIONS.length) setSectionIdx(idx);
		}
	});

	const currentSection = SECTIONS[sectionIdx];
	const SectionComponent = SECTION_COMPONENTS[currentSection];

	return (
		<box style={{ flexDirection: "column", width: "100%", height: "100%" }}>
			{/* Header */}
			<box style={{ flexDirection: "row", paddingX: 1, height: 1 }}>
				<text>
					<span fg={C.accent}>OpenTUI Components</span>
					<span fg={C.dim}>
						{" "}
						({sectionIdx + 1}/{SECTIONS.length}){" "}
					</span>
					<span fg={C.yellow}>{currentSection}</span>
					<span fg={C.dim}> | h/l or ←/→ navigate | 1-9 jump | q quit</span>
				</text>
			</box>

			{/* Section tabs */}
			<box style={{ flexDirection: "row", paddingX: 1, height: 1, gap: 1 }}>
				{SECTIONS.map((s, i) => (
					<text
						key={s}
						content={` ${s} `}
						fg={i === sectionIdx ? C.bg : C.dim}
						bg={i === sectionIdx ? C.accent : undefined}
					/>
				))}
			</box>

			{/* Content */}
			<box style={{ flexGrow: 1, paddingX: 1, paddingBottom: 1 }}>
				<scrollbox style={{ contentOptions: { flexDirection: "column" } }}>
					<SectionComponent />
				</scrollbox>
			</box>
		</box>
	);
}

// --- Entry ---
async function main() {
	const renderer = await createCliRenderer({
		exitOnCtrlC: true,
		onDestroy: () => {
			process.stdout.write("\x1b[?1000l\x1b[?1003l\x1b[?1006l");
		},
	});
	createRoot(renderer).render(<App />);
}

main();
