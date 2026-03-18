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

// Format ISO date to relative or short date.
export function formatDate(iso: string): string {
	if (!iso) return "";
	try {
		const d = new Date(iso);
		const now = new Date();
		const diffMs = now.getTime() - d.getTime();
		const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

		if (diffDays === 0) return "today";
		if (diffDays === 1) return "yesterday";
		if (diffDays < 7) return `${diffDays}d ago`;
		if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
		return d.toLocaleDateString("ja-JP", { month: "short", day: "numeric" });
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
