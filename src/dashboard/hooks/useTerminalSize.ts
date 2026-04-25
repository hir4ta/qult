/**
 * Track terminal columns/rows. Listens for `resize` on `process.stdout`
 * (Ink's `useStdout` returns the same stream) and debounces updates so
 * rapid drag-resize doesn't cascade into layout thrash.
 *
 * Returns the current size plus the most recent layout `tier` so the
 * caller can pass it into `computeLayout()` for hysteresis.
 */

import { useStdout } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import { computeLayout, type Layout, type LayoutTier } from "../state/layout.ts";
import type { TerminalSize } from "../types.ts";

const DEBOUNCE_MS = 100;

export interface TerminalLayout {
	size: TerminalSize;
	layout: Layout;
}

export function useTerminalSize(): TerminalLayout {
	const { stdout } = useStdout();
	const initialCols = stdout.columns ?? 80;
	const initialRows = stdout.rows ?? 24;
	const [size, setSize] = useState<TerminalSize>({
		columns: initialCols,
		rows: initialRows,
	});
	const previousTier = useRef<LayoutTier | undefined>(undefined);

	useEffect(() => {
		let timer: NodeJS.Timeout | null = null;
		const onResize = (): void => {
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => {
				timer = null;
				setSize({ columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 });
			}, DEBOUNCE_MS);
		};
		stdout.on("resize", onResize);
		return () => {
			if (timer) clearTimeout(timer);
			stdout.off("resize", onResize);
		};
	}, [stdout]);

	const layout = useMemo(() => {
		const next = computeLayout(size.columns, size.rows, previousTier.current);
		previousTier.current = next.tier;
		return next;
	}, [size.columns, size.rows]);

	return { size, layout };
}
