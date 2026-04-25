/**
 * Dashboard theme — wraps `@inkjs/ui`'s `defaultTheme` with our cyan / magenta /
 * yellow / green palette. Components mostly drive color via direct props
 * (e.g. `<Badge color="cyan">`), but `extendTheme` gives us a single hook
 * for future `.qult/config.json` overrides without touching call sites.
 */

import { defaultTheme, extendTheme, type Theme } from "@inkjs/ui";

export const qultTheme: Theme = extendTheme(defaultTheme, { components: {} });

export const COLORS = {
	primary: "cyan",
	accent: "magenta",
	success: "green",
	warning: "yellow",
	error: "magenta",
	muted: "gray",
} as const;

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
			return COLORS.primary;
	}
}
