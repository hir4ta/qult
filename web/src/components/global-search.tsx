import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Brain, ListChecks, Search } from "@animated-color-icons/lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ButlerEmpty } from "@/components/butler-empty";
import { Input } from "@/components/ui/input";
import { knowledgeQueryOptions, tasksQueryOptions } from "@/lib/api";
import { useI18n } from "@/lib/i18n";

interface SearchResult {
	type: "task" | "knowledge";
	slug?: string;
	id?: number;
	label: string;
	sub_type?: string;
}

export function GlobalSearch() {
	const { t } = useI18n();
	const navigate = useNavigate();
	const [query, setQuery] = useState("");
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);

	const { data: tasksData } = useQuery(tasksQueryOptions());
	const { data: knowledgeData } = useQuery(knowledgeQueryOptions());

	const results: SearchResult[] = [];
	if (query.length >= 2) {
		const q = query.toLowerCase();
		// Tasks
		const tasks = tasksData?.tasks ?? [];
		for (const task of tasks) {
			if (task.slug.toLowerCase().includes(q)) {
				results.push({ type: "task", slug: task.slug, label: task.slug });
			}
			if (results.length >= 5) break;
		}
		// Knowledge
		const entries = knowledgeData?.entries ?? [];
		for (const entry of entries) {
			if (entry.label.toLowerCase().includes(q) || entry.content.toLowerCase().includes(q)) {
				results.push({ type: "knowledge", id: entry.id, label: entry.label, sub_type: entry.sub_type });
			}
			if (results.length >= 10) break;
		}
	}

	const handleSelect = useCallback((result: SearchResult) => {
		setQuery("");
		setOpen(false);
		if (result.type === "task" && result.slug) {
			navigate({ to: "/tasks/$slug", params: { slug: result.slug } });
		} else if (result.type === "knowledge") {
			navigate({ to: "/knowledge" });
		}
	}, [navigate]);

	// Close on click outside
	useEffect(() => {
		const handler = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
		};
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, []);

	// Close on Escape
	const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
		if (e.key === "Escape") { setOpen(false); setQuery(""); }
	}, []);

	return (
		<div ref={ref} className="relative">
			<div className="relative">
				<Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
				<Input
					ref={inputRef}
					value={query}
					onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
					onFocus={() => query.length >= 2 && setOpen(true)}
					onKeyDown={handleKeyDown}
					placeholder={t("search.placeholder")}
					className="h-8 w-52 pl-8 text-sm rounded-lg"
				/>
			</div>
			{open && results.length > 0 && (
				<div className="absolute top-full mt-1 w-72 rounded-lg border bg-card z-50 py-1 shadow-lg">
					{results.map((r, i) => (
						<button
							key={`${r.type}-${r.slug ?? r.id}-${i}`}
							type="button"
							onClick={() => handleSelect(r)}
							className="al-icon-wrapper flex items-center gap-2 w-full px-3 py-1.5 text-sm text-left transition-colors hover:bg-accent"
						>
							{r.type === "task" ? (
								<ListChecks className="size-3.5 shrink-0 text-muted-foreground" />
							) : (
								<Brain className="size-3.5 shrink-0" style={{ color: r.sub_type === "decision" ? "#628141" : r.sub_type === "pattern" ? "#2d8b7a" : "#e67e22" }} />
							)}
							<span className="truncate">{r.label}</span>
							<span className="ml-auto text-[10px] text-muted-foreground shrink-0">
								{r.type === "task" ? "spec" : r.sub_type}
							</span>
						</button>
					))}
				</div>
			)}
			{open && query.length >= 2 && results.length === 0 && (
				<div className="absolute top-full mt-1 w-72 rounded-lg border bg-card z-50 py-2 shadow-lg">
					<ButlerEmpty scene="monocle" messageKey="empty.noResults" className="!py-4" />
				</div>
			)}
		</div>
	);
}
