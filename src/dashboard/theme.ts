/**
 * Dashboard theme — gruvbox-material palette adapted from
 * https://github.com/sainnhe/gruvbox-material-vscode (Material variant).
 *
 * Ink renders text via `chalk`, which accepts hex strings directly. We expose
 * two surfaces:
 *   - `PALETTE`  — raw named colors of the gruvbox-material scheme
 *   - `COLORS`   — semantic role aliases (primary / accent / success / …)
 *     that components should prefer; swap the underlying palette value here
 *     to retheme the whole UI.
 *
 * `extendTheme` over `@inkjs/ui`'s default theme gives us a single hook for
 * future `.qult/config.json`-driven overrides without changing call sites.
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

export const qultTheme: Theme = extendTheme(defaultTheme, { components: {} });

export type SeverityVariant = "success" | "warning" | "error" | "info";

export function severityColor(v: SeverityVariant): string {
	switch (v) {
		case "success":
			return COLORS.success;
		case "warning":
			return COLORS.warning;
		case "error":
			return COLORS.error;
		case "info":
			return COLORS.info;
	}
}
