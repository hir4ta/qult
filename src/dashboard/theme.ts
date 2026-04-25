/**
 * Dashboard theme — gruvbox-material palette adapted from
 * https://github.com/sainnhe/gruvbox-material-vscode (Material variant).
 *
 * Two surfaces:
 *   - `PALETTE`  — raw named colors of the gruvbox-material scheme
 *   - `COLORS`   — semantic role aliases (primary / accent / success / …)
 *     that components should prefer; swap the underlying palette value here
 *     to retheme the whole UI.
 *
 * The `qultTheme` object overrides the default `@inkjs/ui` styles for
 * Badge / Alert / StatusMessage / ProgressBar / Spinner so the built-in
 * components inherit the gruvbox palette automatically (otherwise their
 * defaults stay on bright ANSI colors and only our local `<Text color>` /
 * `<Badge color>` props get themed).
 */

import { defaultTheme, extendTheme, type Theme } from "@inkjs/ui";

/** gruvbox-material (medium contrast) foreground palette. */
export const PALETTE = {
	fg: "#ddc7a1",
	red: "#ea6962",
	orange: "#e78a4e",
	yellow: "#d8a657",
	green: "#a9b665",
	aqua: "#89b482",
	blue: "#7daea3",
	purple: "#d3869b",
	gray: "#928374",
	subtle: "#5a524c",
	bg: "#282828",
} as const;

/** Semantic role colors. Components consume these, never PALETTE directly. */
export const COLORS = {
	primary: PALETTE.blue,
	accent: PALETTE.purple,
	success: PALETTE.green,
	warning: PALETTE.yellow,
	error: PALETTE.red,
	info: PALETTE.aqua,
	highlight: PALETTE.orange,
	muted: PALETTE.gray,
	dim: PALETTE.subtle,
	fg: PALETTE.fg,
} as const;

const VARIANT_COLOR: Record<"info" | "success" | "error" | "warning", string> = {
	info: COLORS.info,
	success: COLORS.success,
	error: COLORS.error,
	warning: COLORS.warning,
};

/**
 * Override the default ink-ui themes so built-in components (Spinner /
 * ProgressBar / Alert / StatusMessage / Badge) pick up gruvbox colors.
 */
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
				frame: () => ({ color: COLORS.primary }),
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
