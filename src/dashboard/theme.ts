/**
 * Dashboard theme — Tokyo Night-inspired modern palette.
 *
 * The visual language leans on a single muted-purple → blue → cyan gradient
 * (aurora) for primary surfaces, with reds reserved for actual errors and
 * orange for highlights. Gray is the workhorse for structural lines, so the
 * eye lands on whatever the panel actually needs to convey.
 *
 * Surfaces:
 *   - `PALETTE`  — raw color names
 *   - `COLORS`   — semantic role aliases (primary / accent / success / …)
 *   - `GRADIENTS` — small helper for interpolated banners and progress fills
 *   - `qultTheme` — overrides @inkjs/ui's default Badge / Alert /
 *     StatusMessage / ProgressBar / Spinner so they pick up the palette
 *     automatically.
 */

import { defaultTheme, extendTheme, type Theme } from "@inkjs/ui";

/** Catppuccin Mocha palette — modern pastels with a warm accent core. */
export const PALETTE = {
	fg: "#cdd6f4",
	subtle: "#313244",
	gray: "#6c7086",
	mid: "#7f849c",
	rosewater: "#f5e0dc",
	flamingo: "#f2cdcd",
	pink: "#f5c2e7",
	mauve: "#cba6f7",
	lavender: "#b4befe",
	red: "#f38ba8",
	maroon: "#eba0ac",
	peach: "#fab387",
	yellow: "#f9e2af",
	green: "#a6e3a1",
	teal: "#94e2d5",
	sky: "#89dceb",
	sapphire: "#74c7ec",
	blue: "#89b4fa",
	bg: "#1e1e2e",
} as const;

/**
 * Semantic role colors. Components consume these — never PALETTE directly.
 *
 * Note: `primary` is mauve (purple) rather than blue to keep the UI from
 * feeling cold. Blue is reserved for `info` only so it pops when used.
 */
export const COLORS = {
	primary: PALETTE.mauve,
	accent: PALETTE.peach,
	success: PALETTE.green,
	warning: PALETTE.yellow,
	error: PALETTE.red,
	info: PALETTE.sapphire,
	highlight: PALETTE.flamingo,
	muted: PALETTE.gray,
	dim: PALETTE.subtle,
	fg: PALETTE.fg,
} as const;

// =====================================================================
// Gradient helpers
// =====================================================================

/** Interpolate two `#rrggbb` colors at `t` ∈ [0,1]. */
export function lerpHex(a: string, b: string, t: number): string {
	const ar = Number.parseInt(a.slice(1, 3), 16);
	const ag = Number.parseInt(a.slice(3, 5), 16);
	const ab = Number.parseInt(a.slice(5, 7), 16);
	const br = Number.parseInt(b.slice(1, 3), 16);
	const bg = Number.parseInt(b.slice(3, 5), 16);
	const bb = Number.parseInt(b.slice(5, 7), 16);
	const k = Math.max(0, Math.min(1, t));
	const r = Math.round(ar + (br - ar) * k);
	const g = Math.round(ag + (bg - ag) * k);
	const blu = Math.round(ab + (bb - ab) * k);
	return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${blu.toString(16).padStart(2, "0")}`;
}

/** Sample a multi-stop gradient at `t` ∈ [0,1]. */
export function sampleGradient(stops: readonly string[], t: number): string {
	if (stops.length === 0) return COLORS.fg;
	if (stops.length === 1) return stops[0] ?? COLORS.fg;
	const k = Math.max(0, Math.min(1, t));
	const segCount = stops.length - 1;
	const segLen = 1 / segCount;
	const segIdx = Math.min(segCount - 1, Math.floor(k / segLen));
	const segT = (k - segIdx * segLen) / segLen;
	return lerpHex(stops[segIdx] ?? COLORS.fg, stops[segIdx + 1] ?? COLORS.fg, segT);
}

/** Reusable gradient definitions. Warm-leaning, blue-light. */
export const GRADIENTS = {
	/**
	 * Aurora — peach → pink → mauve → lavender. Default for the qult
	 * wordmark; warm at the top, cools off without ever turning blue.
	 */
	aurora: [PALETTE.peach, PALETTE.pink, PALETTE.mauve, PALETTE.lavender] as const,
	/** Sunset — saturated warm sweep for occasional accents. */
	sunset: [PALETTE.red, PALETTE.peach, PALETTE.yellow] as const,
} as const;

// =====================================================================
// @inkjs/ui theme overrides
// =====================================================================

const VARIANT_COLOR: Record<"info" | "success" | "error" | "warning", string> = {
	info: COLORS.info,
	success: COLORS.success,
	error: COLORS.error,
	warning: COLORS.warning,
};

export const qultTheme: Theme = extendTheme(defaultTheme, {
	components: {
		Badge: {
			styles: {
				container: ({ color }: { color?: string }) => ({
					backgroundColor: color ?? COLORS.accent,
				}),
				label: () => ({ color: PALETTE.bg, bold: true }),
			},
		},
		Spinner: {
			styles: {
				container: () => ({ gap: 1 }),
				frame: () => ({ color: COLORS.accent }),
				label: () => ({ color: COLORS.muted }),
			},
		},
		ProgressBar: {
			styles: {
				container: () => ({ flexGrow: 1, minWidth: 0 }),
				completed: () => ({ color: COLORS.primary }),
				remaining: () => ({ color: COLORS.dim, dimColor: true }),
			},
		},
		Alert: {
			styles: {
				container: ({ variant }: { variant: keyof typeof VARIANT_COLOR }) => ({
					flexGrow: 1,
					borderStyle: "round" as const,
					borderColor: VARIANT_COLOR[variant],
					gap: 1,
					paddingX: 1,
				}),
				iconContainer: () => ({ flexShrink: 0 }),
				icon: ({ variant }: { variant: keyof typeof VARIANT_COLOR }) => ({
					color: VARIANT_COLOR[variant],
				}),
				content: () => ({
					flexShrink: 1,
					flexGrow: 1,
					minWidth: 0,
					flexDirection: "column" as const,
					gap: 1,
				}),
				title: () => ({ bold: true, color: COLORS.fg }),
				message: () => ({ color: COLORS.fg }),
			},
		},
		StatusMessage: {
			styles: {
				container: () => ({ gap: 1 }),
				iconContainer: () => ({ flexShrink: 0 }),
				icon: ({ variant }: { variant: keyof typeof VARIANT_COLOR }) => ({
					color: VARIANT_COLOR[variant],
				}),
				message: () => ({ color: COLORS.fg }),
			},
		},
	},
});

export type SeverityVariant = "success" | "warning" | "error" | "info";

export function severityColor(v: SeverityVariant): string {
	return VARIANT_COLOR[v];
}
