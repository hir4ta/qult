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
	onNodeClick,
	filterSubTypes,
}: KnowledgeGraphProps) {
	const { t } = useI18n();
	const containerRef = useRef<HTMLDivElement>(null);
	// biome-ignore lint/suspicious/noExplicitAny: react-force-graph-2d ref type is complex
	const fgRef = useRef<any>(null);
	const [dimensions, setDimensions] = useState({ width: 800, height: Math.floor(window.innerHeight * 0.7) });

	// Sub-type filter toggles (local state)
	const [activeTypes, setActiveTypes] = useState<Set<string>>(
		() => filterSubTypes ?? new Set(["decision", "pattern", "rule"]),
	);

	// Track container width + window height
	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;

		const updateHeight = () => setDimensions((prev) => ({ ...prev, height: Math.floor(window.innerHeight * 0.7) }));
		window.addEventListener("resize", updateHeight);

		const observer = new ResizeObserver((entries) => {
			for (const entry of entries) {
				const { width } = entry.contentRect;
				if (width > 0) setDimensions((prev) => ({ ...prev, width }));
			}
		});
		observer.observe(el);
		return () => {
			window.removeEventListener("resize", updateHeight);
			observer.disconnect();
		};
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

	// Adjust d3 force parameters for better node spacing
	useEffect(() => {
		const fg = fgRef.current;
		if (!fg) return;
		fg.d3Force("charge")?.strength(-200);
		fg.d3Force("link")?.distance(120);
	}, [graphData]);

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

	// Custom node rendering — circle only, label via tooltip
	const drawNode = useCallback(
		(node: ForceNode, ctx: CanvasRenderingContext2D) => {
			const size = nodeSize(node);
			const color = SUB_TYPE_COLORS[node.sub_type] ?? "#8b7d6b";
			const x = node.x ?? 0;
			const y = node.y ?? 0;

			ctx.beginPath();
			ctx.arc(x, y, size, 0, 2 * Math.PI);
			ctx.fillStyle = color;
			ctx.fill();

			ctx.strokeStyle = `${color}60`;
			ctx.lineWidth = 1.5;
			ctx.stroke();
		},
		[nodeSize],
	);

	// Node color lookup for link coloring
	const nodeColorMap = useMemo(() => {
		const map = new Map<number, string>();
		for (const n of filteredNodes) {
			map.set(n.id, SUB_TYPE_COLORS[n.sub_type] ?? "#8b7d6b");
		}
		return map;
	}, [filteredNodes]);

	// Link color — blend source node color with opacity based on score
	const linkColor = useCallback((link: ForceLink) => {
		const srcId = typeof link.source === "object" ? link.source.id : link.source;
		const color = nodeColorMap.get(srcId) ?? "#8b7d6b";
		const opacity = Math.min(0.7, Math.max(0.2, 0.2 + link.score * 0.5));
		// Convert hex to rgba
		const r = parseInt(color.slice(1, 3), 16);
		const g = parseInt(color.slice(3, 5), 16);
		const b = parseInt(color.slice(5, 7), 16);
		return `rgba(${r}, ${g}, ${b}, ${opacity})`;
	}, [nodeColorMap]);

	// Link tooltip — show similarity score
	const linkLabel = useCallback((link: ForceLink) => {
		return `similarity: ${(link.score * 100).toFixed(0)}%`;
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
			<div className="rounded-xl border border-border overflow-hidden" style={{ height: "70vh" }}>
				<ForceGraph2D
					width={dimensions.width}
					height={dimensions.height}
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
					linkWidth={(link: ForceLink) => Math.max(1, link.score * 3)}
					linkLabel={linkLabel}
					nodeLabel={nodeLabel}
					onNodeClick={(node: ForceNode) => onNodeClick(node)}
					backgroundColor="transparent"
					cooldownTicks={100}
					d3AlphaDecay={0.02}
					d3VelocityDecay={0.25}
					ref={fgRef}
				/>
			</div>
		</div>
	);
}
