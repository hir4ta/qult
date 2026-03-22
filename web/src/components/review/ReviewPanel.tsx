import { useQuery } from "@tanstack/react-query";
import { CheckSquare, History, MessageSquare, Square } from "@animated-color-icons/lucide-react";
import { useCallback, useState } from "react";
import { SpecHistory } from "./SpecHistory";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { reviewHistoryQueryOptions } from "@/lib/api";
import type { Review, ReviewComment } from "@/lib/types";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

interface ReviewPanelProps {
	slug: string;
	reviewStatus: string;
	specContent: string;
	currentFile: string;
	comments?: Array<{ file: string; line: number; body: string }>;
	onAddComment?: (line: number, body: string) => void;
	onRemoveComment?: (line: number, body: string) => void;
}

export function ReviewPanel({
	slug,
	reviewStatus,
	specContent,
	currentFile,
	comments = [],
	onAddComment,
	onRemoveComment,
}: ReviewPanelProps) {
	const { t } = useI18n();
	const { data: historyData } = useQuery(reviewHistoryQueryOptions(slug));
	const [newComment, setNewComment] = useState("");
	const [selectedLine, setSelectedLine] = useState<number | null>(null);
	const [activeTab, setActiveTab] = useState<"review" | "history">("review");
	const [resolvedOverrides, setResolvedOverrides] = useState<Map<string, boolean>>(new Map());

	const reviews = historyData?.reviews ?? [];
	const latestReview = reviews[reviews.length - 1];
	const unresolvedFromPrevious =
		latestReview?.comments?.filter((c) => !c.resolved && c.file === currentFile) ?? [];

	const togglePreviousResolved = (comment: ReviewComment) => {
		const key = `${comment.file}:${comment.line}:${comment.body}`;
		setResolvedOverrides((prev) => {
			const next = new Map(prev);
			const current = next.get(key) ?? comment.resolved ?? false;
			next.set(key, !current);
			return next;
		});
	};

	const isResolved = (comment: ReviewComment) => {
		const key = `${comment.file}:${comment.line}:${comment.body}`;
		return resolvedOverrides.get(key) ?? comment.resolved ?? false;
	};

	const addComment = useCallback(() => {
		if (!newComment.trim() || selectedLine === null || !onAddComment) return;
		onAddComment(selectedLine, newComment.trim());
		setNewComment("");
		setSelectedLine(null);
	}, [newComment, selectedLine, onAddComment]);

	const lines = specContent.split("\n");

	return (
		<div className="space-y-3">
			<div className="flex items-center gap-2">
				<button type="button" onClick={() => setActiveTab("review")}
					className={cn("text-sm font-medium px-2 py-0.5 rounded-lg transition-colors", activeTab === "review" ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")}
				>Review</button>
				<button type="button" onClick={() => setActiveTab("history")}
					className={cn("text-sm font-medium px-2 py-0.5 rounded-lg transition-colors flex items-center gap-1", activeTab === "history" ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")}
				><History className="size-3.5" />{t("review.history")}</button>
			</div>

			{activeTab === "history" && <SpecHistory slug={slug} file={currentFile} />}

			{activeTab === "review" && (
				<>
					{/* Line-numbered viewer */}
					<Card className="overflow-hidden">
						<ScrollArea className="h-[500px]">
							<div className="font-mono text-xs">
								{lines.map((line, i) => {
									const lineNum = i + 1;
									const hasNewComment = comments.some((c) => c.line === lineNum);
									const hasPrevComment = unresolvedFromPrevious.some((c) => c.line === lineNum);
									const isSelected = selectedLine === lineNum;
									return (
										<div key={lineNum}>
											<div
												className={cn(
													"flex hover:bg-accent/40 cursor-pointer group",
													isSelected && "bg-[rgba(45,139,122,0.12)]",
													!isSelected && hasNewComment && "bg-[rgba(98,129,65,0.08)]",
													!isSelected && hasPrevComment && "bg-[rgba(230,126,34,0.06)]",
												)}
												onClick={() => reviewStatus === "pending" && setSelectedLine(isSelected ? null : lineNum)}
											>
												<span className="w-10 shrink-0 text-right pr-2 py-[2px] text-muted-foreground/40 select-none border-r border-border/20 group-hover:text-muted-foreground/70">
													{lineNum}
												</span>
												<span className="flex-1 px-3 py-[2px] whitespace-pre-wrap break-all">{line || " "}</span>
												{reviewStatus === "pending" && (
													<span className="w-6 shrink-0 flex items-center justify-center opacity-0 group-hover:opacity-40 text-muted-foreground">
														+
													</span>
												)}
											</div>
											{/* Inline comments anchored to this line */}
											{unresolvedFromPrevious
												.filter((c) => c.line === lineNum)
												.map((c, ci) => (
													<InlineCommentRow
														key={`prev-${lineNum}-${ci}`}
														comment={c}
														isPrevious
														resolved={isResolved(c)}
														onToggleResolved={() => togglePreviousResolved(c)}
													/>
												))}
											{comments
												.filter((c) => c.line === lineNum)
												.map((c, ci) => (
													<InlineCommentRow
														key={`new-${lineNum}-${ci}`}
														comment={{ ...c, resolved: false }}
														onRemove={() => onRemoveComment?.(c.line, c.body)}
													/>
												))}
											{/* Comment input inline when this line is selected */}
											{isSelected && reviewStatus === "pending" && (
												<div className="ml-10 mr-2 my-1 flex gap-2 items-end">
													<div className="flex-1 space-y-1">
														<p className="text-[10px] text-muted-foreground">
															{currentFile}:{lineNum}
														</p>
														<Textarea
															value={newComment}
															onChange={(e) => setNewComment(e.target.value)}
															placeholder={t("review.addComment")}
															className="min-h-[50px] text-xs"
															autoFocus
															onKeyDown={(e) => {
																if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
																	e.preventDefault();
																	addComment();
																}
																if (e.key === "Escape") {
																	setSelectedLine(null);
																	setNewComment("");
																}
															}}
														/>
													</div>
													<div className="flex flex-col gap-1 pb-1">
														<Button size="sm" onClick={addComment} disabled={!newComment.trim()} className="text-xs h-7 px-2">
															<MessageSquare className="h-3 w-3 mr-1" />
															{t("review.add")}
														</Button>
														<Button size="sm" variant="ghost" onClick={() => { setSelectedLine(null); setNewComment(""); }} className="text-xs h-7 px-2 text-muted-foreground">
															Esc
														</Button>
													</div>
												</div>
											)}
										</div>
									);
								})}
							</div>
						</ScrollArea>
					</Card>

					{reviews.length > 0 && <ReviewHistory reviews={reviews} />}
				</>
			)}
		</div>
	);
}

// --- Inline Comment Row ---

function InlineCommentRow({
	comment,
	isPrevious,
	resolved,
	onRemove,
	onToggleResolved,
}: {
	comment: ReviewComment;
	isPrevious?: boolean;
	resolved?: boolean;
	onRemove?: () => void;
	onToggleResolved?: () => void;
}) {
	const isR = resolved ?? comment.resolved ?? false;
	return (
		<div
			className={cn(
				"ml-10 mr-2 my-0.5 rounded-lg px-3 py-1.5 text-xs border-l-2",
				isPrevious ? "border-l-[#e67e22] bg-[rgba(230,126,34,0.04)]" : "border-l-[#628141] bg-[rgba(98,129,65,0.04)]",
				isR && "opacity-40",
			)}
			onClick={(e) => e.stopPropagation()}
		>
			<div className="flex items-start justify-between gap-2">
				<p className="whitespace-pre-wrap">{comment.body}</p>
				<div className="flex items-center gap-1 shrink-0">
					{isPrevious && onToggleResolved && (
						<button type="button" onClick={onToggleResolved}
							className="text-muted-foreground hover:text-foreground transition-colors"
						>
							{isR ? <CheckSquare className="size-3.5" /> : <Square className="size-3.5" />}
						</button>
					)}
					{onRemove && (
						<button type="button" onClick={onRemove}
							className="text-muted-foreground hover:text-foreground text-[10px]"
						>✕</button>
					)}
				</div>
			</div>
		</div>
	);
}

// --- Review History ---

function ReviewHistory({ reviews }: { reviews: Review[] }) {
	const { t, locale } = useI18n();
	return (
		<Card className="p-3">
			<p className="text-xs font-medium text-muted-foreground mb-2">
				{t("review.history")} ({reviews.length})
			</p>
			<div className="space-y-2">
				{reviews.map((review) => (
					<div key={review.timestamp} className="flex items-center gap-2 text-xs">
						<ReviewStatusBadge status={review.status} />
						<span className="text-muted-foreground">
							{new Date(review.timestamp).toLocaleString(locale === "ja" ? "ja-JP" : "en-US", {
								month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
							})}
						</span>
						{review.comments && review.comments.length > 0 && (
							<span className="text-muted-foreground/60">
								{review.comments.length} {t("review.comments")}
							</span>
						)}
					</div>
				))}
			</div>
		</Card>
	);
}

function ReviewStatusBadge({ status }: { status: string }) {
	const colors: Record<string, { color: string; bg: string }> = {
		pending: { color: "#6b7280", bg: "rgba(107,114,128,0.15)" },
		approved: { color: "#2d8b7a", bg: "rgba(45,139,122,0.15)" },
		changes_requested: { color: "#e67e22", bg: "rgba(230,126,34,0.15)" },
	};
	const s = colors[status] ?? colors.pending!;
	return (
		<span className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium"
			style={{ backgroundColor: s.bg, color: s.color }}
		>{status}</span>
	);
}
