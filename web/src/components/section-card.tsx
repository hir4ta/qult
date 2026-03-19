import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, History } from "lucide-react";
import { useState } from "react";
import Markdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import remarkGfm from "remark-gfm";
import { DiffViewer } from "@/components/diff-viewer";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** Spec file → brand color mapping */
export const SPEC_FILE_COLORS: Record<string, string> = {
	"requirements.md": "#40513b",
	"design.md": "#628141",
	"tasks.md": "#2d8b7a",
	"test-specs.md": "#7b6b8d",
	"decisions.md": "#e67e22",
	"research.md": "#628141",
	"session.md": "#40513b",
	"bugfix.md": "#c0392b",
	"delta.md": "#44403c",
};

interface SectionCardProps {
	title: string;
	content: string;
	color?: string;
	defaultOpen?: boolean;
	approved?: boolean;
	onApprove?: (file: string, approved: boolean) => void;
	slug?: string;
}

export function SectionCard({
	title,
	content,
	color,
	defaultOpen = false,
	approved,
	onApprove,
	slug,
}: SectionCardProps) {
	const { t } = useI18n();
	const [open, setOpen] = useState(defaultOpen);
	const [showDiff, setShowDiff] = useState(false);
	const [selectedVersion, setSelectedVersion] = useState<string | null>(null);
	const [versionContent, setVersionContent] = useState<string | null>(null);
	const borderColor = color ?? SPEC_FILE_COLORS[title] ?? "#44403c";

	const { data: historyData } = useQuery({
		queryKey: ["spec-history", slug, title],
		queryFn: async () => {
			if (!slug) return { versions: [] };
			const res = await fetch(`/api/tasks/${slug}/specs/${title}/history`);
			return res.json() as Promise<{ versions: Array<{ timestamp: string; size: number }> }>;
		},
		enabled: !!slug && open,
	});

	const loadVersion = async (ts: string) => {
		if (!slug) return;
		const res = await fetch(`/api/tasks/${slug}/specs/${title}/versions/${ts}`);
		const data = await res.json() as { content: string };
		setVersionContent(data.content);
		setSelectedVersion(ts);
		setShowDiff(true);
	};

	return (
		<div
			className="rounded-lg border bg-card overflow-hidden transition-colors hover:border-border/80"
			style={{ borderLeftWidth: 3, borderLeftColor: borderColor }}
		>
			<div className="flex items-center justify-between px-4 py-2.5">
				<button
					type="button"
					onClick={() => setOpen(!open)}
					className="flex items-center gap-2 text-left transition-colors hover:opacity-70 flex-1 min-w-0"
				>
					<span className="text-sm font-medium">{title.replace(".md", "")}</span>
					<ChevronDown
						className={cn(
							"size-4 text-muted-foreground transition-transform shrink-0",
							open && "rotate-180",
						)}
					/>
				</button>
				{slug && historyData && historyData.versions.length > 0 && (
					<button
						type="button"
						onClick={() => setShowDiff(!showDiff)}
						className={cn(
							"flex items-center gap-1 rounded-md px-2 py-1 text-[11px] transition-all shrink-0",
							showDiff ? "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-400" : "text-muted-foreground hover:text-foreground",
						)}
					>
						<History className="size-3" />
						{historyData.versions.length}
					</button>
				)}
				{onApprove && (
					<button
						type="button"
						onClick={() => onApprove(title, !approved)}
						className={cn(
							"flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-all shrink-0 ml-2",
							approved
								? "bg-emerald-50 text-emerald-700 border border-emerald-200 dark:bg-emerald-950 dark:text-emerald-400 dark:border-emerald-800"
								: "bg-muted text-muted-foreground border border-transparent hover:border-border hover:bg-accent",
						)}
					>
						<Check className={cn("size-3", approved ? "opacity-100" : "opacity-30")} />
						{approved ? t("section.approved") : t("section.approve")}
					</button>
				)}
			</div>

			{open && showDiff && historyData && (
				<div className="border-t px-4 py-2 bg-muted/20">
					<div className="flex flex-wrap gap-1 mb-2">
						{historyData.versions.map((v) => (
							<button
								key={v.timestamp}
								type="button"
								onClick={() => loadVersion(v.timestamp)}
								className={cn(
									"rounded px-2 py-0.5 text-[10px] font-mono transition-colors",
									selectedVersion === v.timestamp
										? "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200"
										: "bg-muted text-muted-foreground hover:bg-accent",
								)}
							>
								{v.timestamp.replace("T", " ")}
							</button>
						))}
					</div>
					{versionContent !== null && (
						<DiffViewer
							oldText={versionContent}
							newText={content}
							oldLabel={selectedVersion ?? "old"}
							newLabel="current"
						/>
					)}
				</div>
			)}
			{open && !showDiff && (
				<div className="border-t px-4 py-3">
					<div
						className="prose prose-sm prose-stone dark:prose-invert max-w-none
						prose-headings:text-sm prose-headings:font-semibold prose-headings:mt-3 prose-headings:mb-1.5
						prose-h1:text-base prose-h1:mt-0 prose-h1:mb-2
						prose-p:text-[13px] prose-p:leading-relaxed prose-p:my-1
						prose-li:text-[13px] prose-li:my-0
						prose-table:text-[12px]
						prose-th:px-3 prose-th:py-1.5 prose-th:text-left prose-th:border prose-th:border-border prose-th:bg-muted/50
						prose-td:px-3 prose-td:py-1.5 prose-td:border prose-td:border-border
						prose-code:text-[12px] prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-foreground
						prose-pre:bg-muted prose-pre:text-foreground prose-pre:rounded-lg prose-pre:my-2
						[&_pre]:p-0 [&_pre_code]:bg-transparent [&_pre_code]:text-foreground [&_pre_code]:p-3 [&_pre_code]:block [&_pre_code]:text-[12px] [&_pre_code]:leading-relaxed [&_pre_code]:whitespace-pre-wrap [&_pre_code]:break-all
						[&_code]:break-all"
					>
						<Markdown
							remarkPlugins={[remarkGfm]}
							components={{
								h1({ children }) {
									return <h1 className="!mt-0 !mb-1 !text-base">{children}</h1>;
								},
								code({ className, children, ...props }) {
									const match = /language-(\w+)/.exec(className || "");
									const codeStr = String(children).replace(/\n$/, "");
									if (match) {
										return (
											<SyntaxHighlighter
												style={oneDark}
												language={match[1]}
												PreTag="div"
												customStyle={{ fontSize: "0.75rem", borderRadius: "0.375rem", margin: 0 }}
												wrapLongLines
											>
												{codeStr}
											</SyntaxHighlighter>
										);
									}
									return (
										<code className={className} {...props}>
											{children}
										</code>
									);
								},
							}}
						>
							{content.replace(/<!--[\s\S]*?-->/g, "")}
						</Markdown>
					</div>
				</div>
			)}
		</div>
	);
}
