import { Check, ChevronDown, MessageSquareText, BookOpen } from "lucide-react";
import { useState } from "react";
import Markdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import remarkGfm from "remark-gfm";
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
	canReview?: boolean;
	isReviewMode?: boolean;
	onToggleReviewMode?: () => void;
	reviewPanel?: React.ReactNode;
}

export function SectionCard({
	title,
	content,
	color,
	defaultOpen = false,
	approved,
	onApprove,
	slug,
	canReview,
	isReviewMode,
	onToggleReviewMode,
	reviewPanel,
}: SectionCardProps) {
	const { t } = useI18n();
	const [open, setOpen] = useState(defaultOpen);

	return (
		<div
			className={cn(
				"rounded-lg border overflow-hidden transition-colors hover:border-border/80",
				open ? "bg-card" : "bg-muted/30",
			)}
		>
			<div
				className="flex items-center justify-between px-4 py-2.5 cursor-pointer hover:bg-accent/30 transition-colors"
				onClick={() => setOpen(!open)}
			>
				<div className="flex items-center gap-2 flex-1 min-w-0">
					<span className="text-sm font-medium">{title.replace(".md", "")}</span>
					<ChevronDown
						className={cn(
							"size-4 text-muted-foreground transition-transform shrink-0",
							open && "rotate-180",
						)}
					/>
				</div>
				<div className="flex items-center gap-1.5 shrink-0 ml-2">
					{canReview && onToggleReviewMode && (
						<button
							type="button"
							onClick={(e) => { e.stopPropagation(); onToggleReviewMode(); }}
							className={cn(
								"flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors shrink-0",
								isReviewMode
									? "bg-brand-pattern/[0.12] text-[#2d8b7a] border border-[rgba(45,139,122,0.3)]"
									: "bg-muted text-muted-foreground border border-transparent hover:border-border hover:bg-accent",
							)}
						>
							{isReviewMode ? (
								<>
									<MessageSquareText className="size-3" />
									{t("section.reviewMode")}
								</>
							) : (
								<>
									<BookOpen className="size-3" />
									{t("section.reviewMode")}
								</>
							)}
						</button>
					)}
					{onApprove && (
						<button
							type="button"
							onClick={(e) => { e.stopPropagation(); onApprove(title, !approved); }}
							className={cn(
								"flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors shrink-0",
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
			</div>

			{open && (
				<div className="border-t px-4 py-3">
					{isReviewMode && reviewPanel ? (
						reviewPanel
					) : (
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
					)}
				</div>
			)}
		</div>
	);
}
