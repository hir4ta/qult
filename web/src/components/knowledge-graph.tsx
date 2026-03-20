import ForceGraph2D from "react-force-graph-2d";
import { Maximize2, Minus, Plus } from "@animated-color-icons/lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SUB_TYPE_COLORS } from "@/lib/types";
import type { GraphEdge } from "@/lib/types";
import { useI18n } from "@/lib/i18n";
import { nodeSize as calcNodeSize, hexToRgba } from "@/lib/graph-utils";

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

function getLinkNodeIds(link: ForceLink): [number, number] {
	const src = typeof link.source === "object" ? link.source.id : link.source;
	const tgt = typeof link.target === "object" ? link.target.id : link.target;
	return [src, tgt];
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
	const [hoverNodeId, setHoverNodeId] = useState<number | null>(null);

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

	// Connected nodes for hover highlight
	const connectedNodesMap = useMemo(() => {
		const map = new Map<number, Set<number>>();
		for (const link of graphData.links) {
			const [src, tgt] = getLinkNodeIds(link);
			if (!map.has(src)) map.set(src, new Set());
			if (!map.has(tgt)) map.set(tgt, new Set());
			map.get(src)!.add(tgt);
			map.get(tgt)!.add(src);
		}
		return map;
	}, [graphData.links]);

	// Count connections per node for tooltip
	const connectionCounts = useMemo(() => {
		const counts = new Map<number, number>();
		for (const edge of graphData.links) {
			const [srcId, tgtId] = getLinkNodeIds(edge);
			counts.set(srcId, (counts.get(srcId) ?? 0) + 1);
			counts.set(tgtId, (counts.get(tgtId) ?? 0) + 1);
		}
		return counts;
	}, [graphData.links]);

	// Is node highlighted (hovered or connected to hovered)?
	const isNodeHighlighted = useCallback((nodeId: number) => {
		if (hoverNodeId === null) return true; // no hover = all visible
		if (nodeId === hoverNodeId) return true;
		return connectedNodesMap.get(hoverNodeId)?.has(nodeId) ?? false;
	}, [hoverNodeId, connectedNodesMap]);

	// Node size from hit_count (log scale)
	const nodeSize = useCallback((node: ForceNode) => {
		return calcNodeSize(node.hit_count);
	}, []);

	// Custom node rendering with hover highlight
	const drawNode = useCallback(
		(node: ForceNode, ctx: CanvasRenderingContext2D) => {
			const size = nodeSize(node);
			const color = SUB_TYPE_COLORS[node.sub_type] ?? "#8b7d6b";
			const x = node.x ?? 0;
			const y = node.y ?? 0;
			const highlighted = isNodeHighlighted(node.id);
			const isHovered = hoverNodeId === node.id;
			const dimmed = hoverNodeId !== null && !highlighted;

			// Glow ring for hovered node
			if (isHovered) {
				ctx.beginPath();
				ctx.arc(x, y, size + 4, 0, 2 * Math.PI);
				ctx.fillStyle = `${color}30`;
				ctx.fill();
			}

			// Connected node pulse ring
			if (highlighted && !isHovered && hoverNodeId !== null) {
				ctx.beginPath();
				ctx.arc(x, y, size + 2, 0, 2 * Math.PI);
				ctx.strokeStyle = `${color}50`;
				ctx.lineWidth = 1.5;
				ctx.stroke();
			}

			// Main circle
			ctx.beginPath();
			ctx.arc(x, y, size, 0, 2 * Math.PI);
			ctx.fillStyle = dimmed ? `${color}30` : color;
			ctx.fill();

			ctx.strokeStyle = dimmed ? `${color}20` : `${color}60`;
			ctx.lineWidth = isHovered ? 2.5 : 1.5;
			ctx.stroke();

			// Label for hovered node
			if (isHovered) {
				ctx.font = "10px var(--font-sans, sans-serif)";
				ctx.textAlign = "center";
				ctx.fillStyle = color;
				ctx.fillText(node.label.slice(0, 30), x, y + size + 12);
			}
		},
		[nodeSize, isNodeHighlighted, hoverNodeId],
	);

	// Node color lookup for link coloring
	const nodeColorMap = useMemo(() => {
		const map = new Map<number, string>();
		for (const n of filteredNodes) {
			map.set(n.id, SUB_TYPE_COLORS[n.sub_type] ?? "#8b7d6b");
		}
		return map;
	}, [filteredNodes]);

	// Link color + width with hover highlight
	const linkColor = useCallback((link: ForceLink) => {
		const [srcId, tgtId] = getLinkNodeIds(link);
		const color = nodeColorMap.get(srcId) ?? "#8b7d6b";

		if (hoverNodeId !== null) {
			const isConnected = srcId === hoverNodeId || tgtId === hoverNodeId;
			if (isConnected) return hexToRgba(color, 0.8);
			return hexToRgba(color, 0.05);
		}

		const opacity = Math.min(0.7, Math.max(0.2, 0.2 + link.score * 0.5));
		return hexToRgba(color, opacity);
	}, [nodeColorMap, hoverNodeId]);

	const linkWidth = useCallback((link: ForceLink) => {
		if (hoverNodeId !== null) {
			const [srcId, tgtId] = getLinkNodeIds(link);
			const isConnected = srcId === hoverNodeId || tgtId === hoverNodeId;
			if (isConnected) return Math.max(2.5, link.score * 5);
			return 0.3;
		}
		return Math.max(1, link.score * 3);
	}, [hoverNodeId]);

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
			<div className="relative rounded-xl border border-border overflow-hidden" style={{ height: "70vh" }}>
				{/* Zoom controls */}
				<div className="absolute top-2 right-2 z-10 flex flex-col gap-1">
					<Tooltip><TooltipTrigger asChild>
						<button type="button" onClick={() => { const fg = fgRef.current; if (fg) { const z = fg.zoom(); fg.zoom(z * 1.5, 300); } }}
							className="flex size-7 items-center justify-center rounded-lg border bg-card/90 backdrop-blur-sm transition-colors hover:bg-accent">
							<Plus className="size-3.5 text-muted-foreground" />
						</button>
					</TooltipTrigger><TooltipContent side="left">{t("knowledge.zoomIn")}</TooltipContent></Tooltip>
					<Tooltip><TooltipTrigger asChild>
						<button type="button" onClick={() => { const fg = fgRef.current; if (fg) { const z = fg.zoom(); fg.zoom(z * 0.67, 300); } }}
							className="flex size-7 items-center justify-center rounded-lg border bg-card/90 backdrop-blur-sm transition-colors hover:bg-accent">
							<Minus className="size-3.5 text-muted-foreground" />
						</button>
					</TooltipTrigger><TooltipContent side="left">{t("knowledge.zoomOut")}</TooltipContent></Tooltip>
					<Tooltip><TooltipTrigger asChild>
						<button type="button" onClick={() => { const fg = fgRef.current; if (fg) fg.zoomToFit(400); }}
							className="flex size-7 items-center justify-center rounded-lg border bg-card/90 backdrop-blur-sm transition-colors hover:bg-accent">
							<Maximize2 className="size-3.5 text-muted-foreground" />
						</button>
					</TooltipTrigger><TooltipContent side="left">{t("knowledge.zoomReset")}</TooltipContent></Tooltip>
				</div>
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
					linkWidth={linkWidth}
					linkLabel={linkLabel}
					nodeLabel={nodeLabel}
					onNodeClick={(node: ForceNode) => onNodeClick(node)}
					onNodeHover={(node: ForceNode | null) => setHoverNodeId(node?.id ?? null)}
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
