import ForceGraph2D from "react-force-graph-2d";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SUB_TYPE_COLORS } from "@/lib/types";
import type { GraphEdge } from "@/lib/types";
import { useI18n } from "@/lib/i18n";

export interface GraphNode {
	id: number;
	label: string;
	sub_type: string;
	hit_count: number;
}

interface KnowledgeGraphProps {
	nodes: GraphNode[];
	edges: GraphEdge[];
	method: "vector" | "keyword";
	truncated: boolean;
	onNodeClick: (node: GraphNode) => void;
	filterSubTypes?: Set<string>;
}

interface ForceNode {
	id: number;
	label: string;
	sub_type: string;
	hit_count: number;
	x?: number;
	y?: number;
}

interface ForceLink {
	source: number | ForceNode;
	target: number | ForceNode;
	score: number;
}

export function KnowledgeGraph({
	nodes,
	edges,
	method: _method,
	truncated: _truncated,
	onNodeClick,
	filterSubTypes,
}: KnowledgeGraphProps) {
	const { t } = useI18n();
	const containerRef = useRef<HTMLDivElement>(null);
	const [dimensions, setDimensions] = useState({ width: 800, height: 500 });
	const [themeColors, setThemeColors] = useState({ bg: "#ffffff", fg: "#1a1a1a" });

	// Sub-type filter toggles (local state)
	const [activeTypes, setActiveTypes] = useState<Set<string>>(
		() => filterSubTypes ?? new Set(["decision", "pattern", "rule"]),
	);

	// Read theme colors from CSS custom properties, re-read on dark mode change
	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;

		const readColors = () => {
			const styles = getComputedStyle(el);
			const bg = styles.getPropertyValue("--background")?.trim();
			const fg = styles.getPropertyValue("--foreground")?.trim();
			if (bg) setThemeColors((prev) => ({ ...prev, bg: `oklch(${bg})` }));
			if (fg) setThemeColors((prev) => ({ ...prev, fg: `oklch(${fg})` }));
		};
		readColors();

		const observer = new MutationObserver(readColors);
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
		return () => observer.disconnect();
	}, []);

	// Track container dimensions
	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;

		const observer = new ResizeObserver((entries) => {
			for (const entry of entries) {
				const { width } = entry.contentRect;
				if (width > 0) setDimensions({ width, height: 500 });
			}
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, []);

	// Filter nodes by active sub_types
	const filteredNodes = useMemo(() => {
		return nodes.filter((n) => activeTypes.has(n.sub_type));
	}, [nodes, activeTypes]);

	const filteredNodeIds = useMemo(() => {
		return new Set(filteredNodes.map((n) => n.id));
	}, [filteredNodes]);

	// Build graph data for react-force-graph-2d
	const graphData = useMemo(() => {
		const forceNodes: ForceNode[] = filteredNodes.map((n) => ({ ...n }));
		const forceLinks: ForceLink[] = edges
			.filter((e) => filteredNodeIds.has(e.source) && filteredNodeIds.has(e.target))
			.map((e) => ({ source: e.source, target: e.target, score: e.score }));
		return { nodes: forceNodes, links: forceLinks };
	}, [filteredNodes, filteredNodeIds, edges]);

	// Count connections per node for tooltip
	const connectionCounts = useMemo(() => {
		const counts = new Map<number, number>();
		for (const edge of graphData.links) {
			const srcId = typeof edge.source === "object" ? edge.source.id : edge.source;
			const tgtId = typeof edge.target === "object" ? edge.target.id : edge.target;
			counts.set(srcId, (counts.get(srcId) ?? 0) + 1);
			counts.set(tgtId, (counts.get(tgtId) ?? 0) + 1);
		}
		return counts;
	}, [graphData.links]);

	// Node size from hit_count (log scale)
	const nodeSize = useCallback((node: ForceNode) => {
		return 4 + Math.log2((node.hit_count || 0) + 1) * 3;
	}, []);

	// Custom node rendering
	const drawNode = useCallback(
		(node: ForceNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
			const size = nodeSize(node);
			const color = SUB_TYPE_COLORS[node.sub_type] ?? "#8b7d6b";
			const x = node.x ?? 0;
			const y = node.y ?? 0;

			// Circle
			ctx.beginPath();
			ctx.arc(x, y, size, 0, 2 * Math.PI);
			ctx.fillStyle = color;
			ctx.fill();

			// Border
			ctx.strokeStyle = `${color}40`;
			ctx.lineWidth = 1.5;
			ctx.stroke();

			// Label (only show when zoomed in enough)
			if (globalScale > 1.2) {
				const label = node.label.length > 24 ? `${node.label.slice(0, 22)}...` : node.label;
				const fontSize = Math.max(10 / globalScale, 3);
				ctx.font = `${fontSize}px sans-serif`;
				ctx.textAlign = "center";
				ctx.textBaseline = "top";
				ctx.fillStyle = themeColors.fg;
				ctx.globalAlpha = 0.8;
				ctx.fillText(label, x, y + size + 2);
				ctx.globalAlpha = 1;
			}
		},
		[nodeSize, themeColors.fg],
	);

	// Link color with opacity based on score (normalized 0→0.15, 1→0.6)
	const linkColor = useCallback((link: ForceLink) => {
		const clamped = Math.min(0.6, Math.max(0.15, 0.15 + link.score * 0.45));
		return `rgba(150, 150, 150, ${clamped})`;
	}, []);

	// Node tooltip
	const nodeLabel = useCallback(
		(node: ForceNode) => {
			const conns = connectionCounts.get(node.id) ?? 0;
			return `${node.label}\n${conns} ${t("knowledge.graphConnections")}`;
		},
		[connectionCounts, t],
	);

	const toggleType = (type: string) => {
		setActiveTypes((prev) => {
			const next = new Set(prev);
			if (next.has(type)) {
				if (next.size > 1) next.delete(type);
			} else {
				next.add(type);
			}
			return next;
		});
	};

	return (
		<div ref={containerRef} className="space-y-2">
			{/* Sub-type filter */}
			<div className="flex items-center gap-2">
				{(["decision", "pattern", "rule"] as const).map((type) => (
					<button
						key={type}
						type="button"
						onClick={() => toggleType(type)}
						className="flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition-colors"
						style={{
							backgroundColor: activeTypes.has(type)
								? `${SUB_TYPE_COLORS[type]}18`
								: "transparent",
							color: activeTypes.has(type)
								? SUB_TYPE_COLORS[type]
								: "var(--color-muted-foreground)",
							border: `1px solid ${activeTypes.has(type) ? `${SUB_TYPE_COLORS[type]}40` : "var(--color-border)"}`,
						}}
					>
						<span
							className="size-2 rounded-full"
							style={{
								backgroundColor: activeTypes.has(type)
									? SUB_TYPE_COLORS[type]
									: "var(--color-muted-foreground)",
							}}
						/>
						{type}
					</button>
				))}
				<span className="text-[10px] text-muted-foreground ml-2">
					{filteredNodes.length} nodes · {graphData.links.length} edges
				</span>
			</div>

			{/* Force graph */}
			<div className="rounded-xl border border-border overflow-hidden" style={{ height: 500 }}>
				<ForceGraph2D
					width={dimensions.width}
					height={500}
					graphData={graphData}
					nodeId="id"
					nodeCanvasObject={drawNode}
					nodePointerAreaPaint={(node: ForceNode, color, ctx) => {
						const size = nodeSize(node);
						ctx.beginPath();
						ctx.arc(node.x ?? 0, node.y ?? 0, size + 2, 0, 2 * Math.PI);
						ctx.fillStyle = color;
						ctx.fill();
					}}
					linkColor={linkColor}
					linkWidth={1.5}
					nodeLabel={nodeLabel}
					onNodeClick={(node: ForceNode) => onNodeClick(node)}
					backgroundColor="transparent"
					cooldownTicks={100}
					d3AlphaDecay={0.03}
					d3VelocityDecay={0.3}
				/>
			</div>
		</div>
	);
}
