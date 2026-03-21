import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { searchQueryOptions } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { useSearch, useNavigate } from "@tanstack/react-router";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { BookOpen, FileText, Search } from "@animated-color-icons/lucide-react";

export function GlobalSearch() {
	const { t } = useI18n();
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [debouncedQuery, setDebouncedQuery] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);
	const search = useSearch({ strict: false }) as { project?: string };

	// Cmd+K / Ctrl+K shortcut
	useEffect(() => {
		function onKeyDown(e: KeyboardEvent) {
			if ((e.metaKey || e.ctrlKey) && e.key === "k") {
				e.preventDefault();
				setOpen(true);
			}
		}
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, []);

	// Debounce
	useEffect(() => {
		const timer = setTimeout(() => setDebouncedQuery(query), 300);
		return () => clearTimeout(timer);
	}, [query]);

	// Focus input when dialog opens
	useEffect(() => {
		if (open) setTimeout(() => inputRef.current?.focus(), 100);
	}, [open]);

	const navigate = useNavigate();
	const { data, isLoading } = useQuery(
		searchQueryOptions(debouncedQuery, { projectId: search.project }),
	);

	function handleResultClick(r: { source: string; slug?: string; id: number }) {
		setOpen(false);
		setQuery("");
		if (r.source === "spec" && r.slug) {
			navigate({ to: "/tasks/$slug", params: { slug: r.slug } });
		} else {
			// Knowledge: navigate to knowledge page (detail opens via hash)
			navigate({ to: "/knowledge", search: { highlight: String(r.id) } });
		}
	}

	return (
		<>
			<button
				type="button"
				onClick={() => setOpen(true)}
				className="al-icon-wrapper flex items-center gap-1.5 px-2.5 h-8 text-sm text-muted-foreground transition-colors hover:text-foreground"
			>
				<Search className="size-4" />
				<span className="text-xs text-muted-foreground/60 hidden sm:inline">
					&#8984;K
				</span>
			</button>

			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent className="p-0 gap-0 max-w-lg" showCloseButton={false}>
					<div className="flex items-center gap-2 px-4 py-3 border-b">
						<Search className="size-4 text-muted-foreground shrink-0" />
						<Input
							ref={inputRef}
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							placeholder={t("search.placeholder")}
							className="border-0 shadow-none focus-visible:ring-0 h-8 text-sm"
						/>
					</div>
					<div className="max-h-80 overflow-y-auto p-2">
						{isLoading && debouncedQuery && (
							<p className="text-sm text-muted-foreground text-center py-4">
								...
							</p>
						)}
						{data?.results &&
							data.results.length === 0 &&
							debouncedQuery && (
								<p className="text-sm text-muted-foreground text-center py-4">
									{t("search.noResults")}
								</p>
							)}
						{data?.results?.map((r) => (
							<button
								type="button"
								key={`${r.source}-${r.id}`}
								className="flex items-start gap-3 px-3 py-2 rounded-lg hover:bg-muted/50 cursor-pointer w-full text-left transition-colors"
								onClick={() => handleResultClick(r)}
							>
								{r.source === "knowledge" ? (
									<BookOpen
										className="size-4 mt-0.5 shrink-0"
										style={{ color: "#2d8b7a" }}
									/>
								) : (
									<FileText
										className="size-4 mt-0.5 shrink-0"
										style={{ color: "#628141" }}
									/>
								)}
								<div className="min-w-0 flex-1">
									<div className="text-sm font-medium truncate">
										{r.title || r.slug || t("search.untitled")}
									</div>
									<div className="flex items-center gap-2 text-[11px] text-muted-foreground">
										<span className="font-mono">{r.source}</span>
										{r.projectName && (
											<span>&middot; {r.projectName}</span>
										)}
										{r.slug && (
											<span>
												&middot; {r.slug}/{r.fileName}
											</span>
										)}
									</div>
								</div>
							</button>
						))}
					</div>
				</DialogContent>
			</Dialog>
		</>
	);
}
