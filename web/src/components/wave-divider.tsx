import { useId } from "react";

interface WaveDividerProps {
	className?: string;
}

function hashCode(str: string): number {
	let hash = 0;
	for (let i = 0; i < str.length; i++) {
		hash = (hash << 5) - hash + str.charCodeAt(i);
		hash |= 0;
	}
	return Math.abs(hash);
}

export function WaveDivider({ className }: WaveDividerProps) {
	const id = useId();
	const seed = hashCode(id);

	// Generate a subtle wave path with seed-based variation
	const amplitude = 2 + (seed % 3); // 2-4px
	const frequency = 2 + (seed % 2); // 2-3 waves
	const phase = (seed % 100) / 100 * Math.PI * 2;

	const width = 400;
	const height = 12;
	const mid = height / 2;
	const points: string[] = [`M 0 ${mid}`];

	for (let x = 0; x <= width; x += 2) {
		const y = mid + Math.sin((x / width) * Math.PI * frequency * 2 + phase) * amplitude;
		points.push(`L ${x} ${y.toFixed(1)}`);
	}

	return (
		<div className={`my-4 ${className ?? ""}`}>
			<svg
				viewBox={`0 0 ${width} ${height}`}
				className="w-full"
				preserveAspectRatio="none"
				aria-hidden="true"
			>
				<path
					d={points.join(" ")}
					fill="none"
					stroke="currentColor"
					strokeWidth="1"
					opacity="0.15"
				/>
			</svg>
		</div>
	);
}
