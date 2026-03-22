import { useQuery } from "@tanstack/react-query";
import { CheckSquare, MessageSquare, Square } from "@animated-color-icons/lucide-react";
import { useCallback, useRef, useState } from "react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { reviewHistoryQueryOptions } from "@/lib/api";
import type { ReviewComment } from "@/lib/types";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export interface ReviewCommentWithRange {
	file: string;
	line: number;        // start line (1-based)
	endLine?: number;    // end line (inclusive, for multi-line)
	body: string;
	resolved?: boolean;
}

interface ReviewPanelProps {
	slug: string;
	reviewStatus: string;
	specContent: string;
	currentFile: string;
	comments?: ReviewCommentWithRange[];
	onAddComment?: (line: number, body: string, endLine?: number) => void;
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
	const [resolvedOverrides, setResolvedOverrides] = useState<Map<string, boolean>>(new Map());

	// Selection state for multi-line
	const [selStart, setSelStart] = useState<number | null>(null);
	const [selEnd, setSelEnd] = useState<number | null>(null);
	const [commentDraft, setCommentDraft] = useState("");
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	const reviews = historyData?.reviews ?? [];
	const latestReview = reviews[reviews.length - 1];
	const unresolvedFromPrevious =
		latestReview?.comments?.filter((c) => !c.resolved && c.file === currentFile) ?? [];

	const isPending = reviewStatus === "pending";

	const togglePreviousResolved = (comment: ReviewComment) => {
		const key = `${comment.file}:${comment.line}:${comment.body}`;
		setResolvedOverrides((prev) => {
			const next = new Map(prev);
			next.set(key, !(next.get(key) ?? comment.resolved ?? false));
			return next;
		});
	};

	const isResolved = (comment: ReviewComment) => {
		const key = `${comment.file}:${comment.line}:${comment.body}`;
		return resolvedOverrides.get(key) ?? comment.resolved ?? false;
	};

	// Line click: single click = start, shift+click = extend range
	const handleLineClick = useCallback((lineNum: number, shiftKey: boolean) => {
		if (!isPending) return;
		if (shiftKey && selStart !== null) {
			// Extend selection
			setSelEnd(lineNum);
		} else {
			// New selection
			setSelStart(lineNum);
			setSelEnd(null);
			setCommentDraft("");
		}
		setTimeout(() => textareaRef.current?.focus(), 50);
	}, [isPending, selStart]);

	const cancelSelection = useCallback(() => {
		setSelStart(null);
		setSelEnd(null);
		setCommentDraft("");
	}, []);

	const submitComment = useCallback(() => {
		if (!commentDraft.trim() || selStart === null || !onAddComment) return;
		const startLine = selEnd !== null ? Math.min(selStart, selEnd) : selStart;
		const endLine = selEnd !== null ? Math.max(selStart, selEnd) : undefined;
		onAddComment(startLine, commentDraft.trim(), endLine !== startLine ? endLine : undefined);
		cancelSelection();
	}, [commentDraft, selStart, selEnd, onAddComment, cancelSelection]);

	// Compute which lines are in the active selection
	const selMin = selStart !== null && selEnd !== null ? Math.min(selStart, selEnd) : selStart;
	const selMax = selStart !== null && selEnd !== null ? Math.max(selStart, selEnd) : selStart;

	const lines = specContent.split("\n");

	// Group comments by their start line for rendering
	const commentsByLine = new Map<number, ReviewCommentWithRange[]>();
	for (const c of [...unresolvedFromPrevious, ...comments]) {
		const arr = commentsByLine.get(c.line) ?? [];
		arr.push(c as ReviewCommentWithRange);
		commentsByLine.set(c.line, arr);
	}

	// Determine where to show the comment form (after the last line of selection)
	const commentFormLine = selStart !== null ? (selMax ?? selStart) : null;

	return (
		<div className="space-y-3">
			<>
					{/* GitHub-style file viewer */}
					<div className="rounded-lg border border-border/60 overflow-hidden">
						{/* File header */}
						<div className="flex items-center gap-2 px-3 py-1.5 bg-muted/30 border-b border-border/40">
							<span className="text-xs font-mono text-muted-foreground">{currentFile}</span>
							<span className="text-[10px] text-muted-foreground/50">{lines.length} lines</span>
						</div>

						{/* Line viewer */}
						<div className="overflow-auto max-h-[500px]" style={{ fontFamily: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace" }}>
							{lines.map((line, i) => {
								const lineNum = i + 1;
								const inSelection = selMin !== null && selMax !== null && lineNum >= selMin && lineNum <= selMax;
								const isSingleSel = selStart === lineNum && selEnd === null;
								const hasComment = commentsByLine.has(lineNum);
								const lineComments = commentsByLine.get(lineNum);
								const showForm = commentFormLine === lineNum;

								return (
									<div key={lineNum}>
										{/* Code line */}
										<div
											className={cn(
												"flex group text-xs leading-5",
												(inSelection || isSingleSel) && "bg-[#ddf4ff] dark:bg-[#1a3a4a]",
												!inSelection && !isSingleSel && hasComment && "bg-[#fff8e1] dark:bg-[#2a2518]",
												!inSelection && !isSingleSel && !hasComment && "hover:bg-[#f6f8fa] dark:hover:bg-[#161b22]",
											)}
										>
											{/* Gutter: line number + add button */}
											<div
												className="w-12 shrink-0 flex items-center justify-end pr-2 select-none cursor-pointer border-r border-border/20 relative"
												onClick={(e) => handleLineClick(lineNum, e.shiftKey)}
											>
												{isPending && (
													<span className="absolute left-1 opacity-0 group-hover:opacity-100 text-blue-500 text-[10px] font-bold">
														+
													</span>
												)}
												<span className="text-[11px] text-muted-foreground/40 group-hover:text-muted-foreground/70 tabular-nums">
													{lineNum}
												</span>
											</div>

											{/* Code content */}
											<div className="flex-1 px-3 whitespace-pre-wrap break-all min-h-[20px]">
												{line || " "}
											</div>
										</div>

										{/* Inline comments thread */}
										{lineComments && lineComments.map((c, ci) => {
											const isPrev = unresolvedFromPrevious.includes(c as ReviewComment);
											return (
												<CommentThread
													key={`${lineNum}-${ci}`}
													comment={c}
													isPrevious={isPrev}
													resolved={isPrev ? isResolved(c as ReviewComment) : false}
													onToggleResolved={isPrev ? () => togglePreviousResolved(c as ReviewComment) : undefined}
													onRemove={!isPrev ? () => onRemoveComment?.(c.line, c.body) : undefined}
												/>
											);
										})}

										{/* Comment form */}
										{showForm && isPending && (
											<CommentForm
												ref={textareaRef}
												file={currentFile}
												startLine={selMin ?? lineNum}
												endLine={selMax !== selMin ? selMax ?? undefined : undefined}
												value={commentDraft}
												onChange={setCommentDraft}
												onSubmit={submitComment}
												onCancel={cancelSelection}
											/>
										)}
									</div>
								);
							})}
						</div>
					</div>

			</>
		</div>
	);
}

// --- Comment Form (GitHub-style) ---

import { forwardRef } from "react";

const CommentForm = forwardRef<HTMLTextAreaElement, {
	file: string;
	startLine: number;
	endLine?: number;
	value: string;
	onChange: (v: string) => void;
	onSubmit: () => void;
	onCancel: () => void;
}>(({ file, startLine, endLine, value, onChange, onSubmit, onCancel }, ref) => {
	const { t } = useI18n();
	const rangeLabel = endLine ? `L${startLine}-L${endLine}` : `L${startLine}`;

	return (
		<div className="mx-3 my-2 rounded-lg border border-blue-200 dark:border-blue-800 bg-white dark:bg-[#0d1117] overflow-hidden">
			{/* Header */}
			<div className="flex items-center gap-2 px-3 py-1.5 bg-[#f6f8fa] dark:bg-[#161b22] border-b border-blue-200/50 dark:border-blue-800/50">
				<span className="text-[10px] font-mono text-blue-600 dark:text-blue-400 font-medium">{rangeLabel}</span>
				<span className="text-[10px] text-muted-foreground">{file}</span>
			</div>
			{/* Body */}
			<div className="p-3 space-y-2">
				<Textarea
					ref={ref}
					value={value}
					onChange={(e) => onChange(e.target.value)}
					placeholder={t("review.addComment")}
					className="min-h-[60px] text-xs border-border/40 bg-transparent resize-none"
					onKeyDown={(e) => {
						if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
							e.preventDefault();
							onSubmit();
						}
						if (e.key === "Escape") {
							e.preventDefault();
							onCancel();
						}
					}}
				/>
				<div className="flex items-center justify-between">
					<span className="text-[10px] text-muted-foreground">⌘Enter to submit · Esc to cancel</span>
					<div className="flex gap-2">
						<Button size="sm" variant="ghost" onClick={onCancel} className="text-xs h-7 px-3">
							Cancel
						</Button>
						<Button size="sm" onClick={onSubmit} disabled={!value.trim()} className="text-xs h-7 px-3 bg-[#628141] text-white hover:bg-[#4e6a34]">
							<MessageSquare className="h-3 w-3 mr-1" />
							{t("review.add")}
						</Button>
					</div>
				</div>
			</div>
		</div>
	);
});
CommentForm.displayName = "CommentForm";

// --- Comment Thread (GitHub-style) ---

function CommentThread({
	comment,
	isPrevious,
	resolved,
	onToggleResolved,
	onRemove,
}: {
	comment: ReviewCommentWithRange;
	isPrevious?: boolean;
	resolved?: boolean;
	onToggleResolved?: () => void;
	onRemove?: () => void;
}) {
	const isR = resolved ?? comment.resolved ?? false;
	const rangeLabel = comment.endLine ? `L${comment.line}-L${comment.endLine}` : `L${comment.line}`;

	return (
		<div className={cn(
			"mx-3 my-1 rounded-lg border overflow-hidden",
			isPrevious ? "border-orange-200 dark:border-orange-800" : "border-green-200 dark:border-green-800",
			isR && "opacity-40",
		)}>
			{/* Thread header */}
			<div className={cn(
				"flex items-center justify-between px-3 py-1 text-[10px]",
				isPrevious ? "bg-orange-50 dark:bg-orange-950/30" : "bg-green-50 dark:bg-green-950/30",
			)}>
				<span className="font-mono font-medium" style={{ color: isPrevious ? "#e67e22" : "#628141" }}>
					{rangeLabel}
				</span>
				<div className="flex items-center gap-1">
					{isPrevious && onToggleResolved && (
						<button type="button" onClick={onToggleResolved}
							className="text-muted-foreground hover:text-foreground cursor-pointer"
						>
							{isR ? <CheckSquare className="size-3.5" /> : <Square className="size-3.5" />}
						</button>
					)}
					{onRemove && (
						<button type="button" onClick={onRemove}
							className="text-muted-foreground hover:text-foreground cursor-pointer text-xs"
						>✕</button>
					)}
				</div>
			</div>
			{/* Comment body */}
			<div className="px-3 py-2 text-xs whitespace-pre-wrap bg-white dark:bg-[#0d1117]">
				{comment.body}
			</div>
		</div>
	);
}

