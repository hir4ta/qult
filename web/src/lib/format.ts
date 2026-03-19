// Label parsing: strip section_path prefixes and date markers.
// "react-dashboard > DEC-1: [2026-03-16] chi as Go HTTP Router" → "chi as Go HTTP Router"
// "claude-alfred > manual > React SPA移行パターン: TUI→Web..." → "React SPA移行パターン: TUI→Web..."
export function formatLabel(raw: string): { title: string; source: string } {
	const parts = raw.split(" > ");
	const last = parts[parts.length - 1] ?? raw;

	// Strip DEC-N / pattern prefix + date
	const cleaned = last.replace(/^DEC-\d+:\s*/, "").replace(/^\[\d{4}-\d{2}-\d{2}\]\s*/, "");

	const source = parts.length > 1 ? parts[0]! : "";
	return { title: cleaned || last, source };
}

// Format ISO date to relative or short date using calendar day boundaries (local timezone).
// When called without locale (from contexts without i18n), defaults to English.
export function formatDate(iso: string, locale?: "en" | "ja"): string {
	if (!iso) return "";
	try {
		const d = new Date(iso);
		const now = new Date();
		// Compare by local calendar date, not elapsed milliseconds
		const toLocalDay = (dt: Date) => new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()).getTime();
		const diffDays = Math.round((toLocalDay(now) - toLocalDay(d)) / (1000 * 60 * 60 * 24));

		const isJa = locale === "ja";
		if (diffDays === 0) return isJa ? "今日" : "today";
		if (diffDays === 1) return isJa ? "昨日" : "yesterday";
		if (diffDays < 7) return isJa ? `${diffDays}日前` : `${diffDays}d ago`;
		if (diffDays < 30) {
			const weeks = Math.floor(diffDays / 7);
			return isJa ? `${weeks}週前` : `${weeks}w ago`;
		}
		const dateLocale = isJa ? "ja-JP" : "en-US";
		return d.toLocaleDateString(dateLocale, { month: "short", day: "numeric" });
	} catch {
		return iso;
	}
}

// Truncate content for preview, stripping markdown headers, annotations, and list markers.
export function contentPreview(content: string, maxLen = 120): string {
	const lines = content.split("\n");
	const useful = lines
		.filter(
			(l) =>
				!l.startsWith("#") &&
				!l.startsWith("<!--") &&
				!l.startsWith("- **Status**") &&
				l.trim().length > 0,
		)
		.map((l) => l.replace(/^-\s+/, ""))
		.join(" ")
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\s+/g, " ")
		.trim();
	return useful.length > maxLen ? `${useful.slice(0, maxLen)}...` : useful;
}
