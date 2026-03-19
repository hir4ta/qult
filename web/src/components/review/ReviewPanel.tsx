import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle, MessageSquare, XCircle } from "lucide-react";
import { useState } from "react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { reviewHistoryQueryOptions, submitReview } from "@/lib/api";
import type { Review, ReviewComment } from "@/lib/types";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

interface ReviewPanelProps {
	slug: string;
	reviewStatus: string;
	specContent: string;
	currentFile: string;
}

export function ReviewPanel({ slug, reviewStatus, specContent, currentFile }: ReviewPanelProps) {
	const queryClient = useQueryClient();
	const { t } = useI18n();
	const { data: historyData } = useQuery(reviewHistoryQueryOptions(slug));
	const [comments, setComments] = useState<ReviewComment[]>([]);
	const [newComment, setNewComment] = useState("");
	const [selectedLine, setSelectedLine] = useState<number | null>(null);

	const reviews = historyData?.reviews ?? [];
	const latestReview = reviews[reviews.length - 1];

	const mutation = useMutation({
		mutationFn: (status: "approved" | "changes_requested") => submitReview(slug, status, comments),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["review", slug] });
			queryClient.invalidateQueries({ queryKey: ["review-history", slug] });
			queryClient.invalidateQueries({ queryKey: ["tasks"] });
			setComments([]);
		},
	});

	const lines = specContent.split("\n");

	const addComment = () => {
		if (!newComment.trim() || selectedLine === null) return;
		setComments([...comments, { file: currentFile, line: selectedLine, body: newComment.trim() }]);
		setNewComment("");
		setSelectedLine(null);
	};

	const removeComment = (index: number) => {
		setComments(comments.filter((_, i) => i !== index));
	};

	// Carry over unresolved comments from previous review
	const unresolvedFromPrevious =
		latestReview?.comments?.filter((c) => !c.resolved && c.file === currentFile) ?? [];

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-2">
					<h3 className="text-sm font-medium">Review</h3>
					<ReviewStatusBadge status={reviewStatus} />
				</div>
				{reviewStatus === "pending" && (
					<div className="flex gap-2">
						<ConfirmAction
							title={t("review.approveTitle")}
							description={t("review.approveDescription")}
							action={() => mutation.mutate("approved")}
							disabled={mutation.isPending}
						>
							<Button
								size="sm"
								variant="outline"
								className="gap-1 text-xs"
								style={{ borderColor: "rgba(45,139,122,0.4)", color: "#2d8b7a" }}
							>
								<CheckCircle className="h-3.5 w-3.5" />
								{t("review.approve")}
							</Button>
						</ConfirmAction>
						<ConfirmAction
							title={t("review.requestChangesTitle")}
							description={t("review.requestChangesDescription")}
							action={() => mutation.mutate("changes_requested")}
							disabled={mutation.isPending || comments.length === 0}
						>
							<Button
								size="sm"
								variant="outline"
								className="gap-1 text-xs"
								style={{ borderColor: "rgba(230,126,34,0.4)", color: "#e67e22" }}
							>
								<XCircle className="h-3.5 w-3.5" />
								{t("review.requestChanges")}
							</Button>
						</ConfirmAction>
					</div>
				)}
			</div>

			{/* Line-numbered spec content */}
			<Card>
				<ScrollArea className="h-[400px]">
					<div className="p-2 font-mono text-xs">
						{lines.map((line, i) => {
							const lineNum = i + 1;
							const hasComment =
								comments.some((c) => c.line === lineNum) ||
								unresolvedFromPrevious.some((c) => c.line === lineNum);
							return (
								<div key={`line-${lineNum}`}>
									<div
										className={cn(
											"flex gap-2 px-1 py-0.5 hover:bg-accent/50 cursor-pointer rounded-sm",
											selectedLine === lineNum && "bg-accent",
											hasComment && "bg-brand-rule/[0.06]",
										)}
										onClick={() => setSelectedLine(lineNum)}
										onKeyDown={(e) => e.key === "Enter" && setSelectedLine(lineNum)}
									>
										<span className="w-8 shrink-0 text-right text-muted-foreground select-none">
											{lineNum}
										</span>
										<span className="whitespace-pre-wrap break-all">{line || " "}</span>
									</div>
									{/* Inline comments on this line */}
									{unresolvedFromPrevious
										.filter((c) => c.line === lineNum)
										.map((c, ci) => (
											<InlineComment key={`prev-${lineNum}-${ci}`} comment={c} isPrevious />
										))}
									{comments
										.filter((c) => c.line === lineNum)
										.map((c, ci) => {
											const idx = comments.findIndex((x) => x.line === c.line && x.body === c.body);
											return (
												<InlineComment
													key={`new-${lineNum}-${ci}`}
													comment={c}
													onRemove={() => removeComment(idx)}
												/>
											);
										})}
								</div>
							);
						})}
					</div>
				</ScrollArea>
			</Card>

			{/* Add comment */}
			{selectedLine !== null && reviewStatus === "pending" && (
				<div className="flex gap-2 items-end">
					<div className="flex-1 space-y-1">
						<p className="text-xs text-muted-foreground">
							{t("review.commentOn")} {currentFile}:{selectedLine}
						</p>
						<Textarea
							value={newComment}
							onChange={(e) => setNewComment(e.target.value)}
							placeholder={t("review.addComment")}
							className="min-h-[60px] text-sm"
						/>
					</div>
					<Button size="sm" onClick={addComment} disabled={!newComment.trim()}>
						<MessageSquare className="h-3.5 w-3.5 mr-1" />
						{t("review.add")}
					</Button>
				</div>
			)}

			{/* Pending comments summary */}
			{comments.length > 0 && (
				<div className="space-y-1">
					<p className="text-xs text-muted-foreground">{comments.length} {t("review.pendingComments")}</p>
				</div>
			)}

			{/* Review history */}
			{reviews.length > 0 && <ReviewHistory reviews={reviews} />}
		</div>
	);
}

function ReviewStatusBadge({ status }: { status: string }) {
	const styles: Record<string, { color: string; bg: string }> = {
		pending: { color: "#6b7280", bg: "rgba(107,114,128,0.15)" },
		approved: { color: "#2d8b7a", bg: "rgba(45,139,122,0.15)" },
		changes_requested: { color: "#e67e22", bg: "rgba(230,126,34,0.15)" },
	};
	const s = styles[status] ?? styles.pending ?? { color: "#6b7280", bg: "rgba(107,114,128,0.15)" };
	return (
		<span
			className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium"
			style={{ backgroundColor: s.bg, color: s.color }}
		>
			{status}
		</span>
	);
}

function InlineComment({
	comment,
	isPrevious,
	onRemove,
}: {
	comment: ReviewComment;
	isPrevious?: boolean;
	onRemove?: () => void;
}) {
	return (
		<div
			className={cn(
				"ml-10 my-0.5 rounded px-2 py-1 text-xs",
				isPrevious ? "bg-brand-rule/[0.06] text-muted-foreground" : "bg-brand-decision/[0.08]",
			)}
		>
			<div className="flex items-start justify-between gap-2">
				<p className="whitespace-pre-wrap">{comment.body}</p>
				{onRemove && (
					<button
						type="button"
						onClick={onRemove}
						className="shrink-0 text-muted-foreground hover:text-foreground"
					>
						x
					</button>
				)}
			</div>
			{isPrevious && comment.resolved && (
				<Badge variant="outline" className="mt-1 text-[10px]">
					resolved
				</Badge>
			)}
		</div>
	);
}

function ReviewHistory({ reviews }: { reviews: Review[] }) {
	const { t } = useI18n();
	return (
		<Card>
			<CardHeader className="py-2 px-4">
				<CardTitle className="text-xs font-medium text-muted-foreground">
					{t("review.history")} ({reviews.length} {t("review.rounds")}{reviews.length > 1 ? "s" : ""})
				</CardTitle>
			</CardHeader>
			<CardContent className="p-4 pt-0 space-y-3">
				{reviews.map((review, i) => (
					<div key={`review-${review.timestamp}`}>
						{i > 0 && <Separator className="my-2" />}
						<div className="flex items-center gap-2">
							<ReviewStatusBadge status={review.status} />
							<span className="text-xs text-muted-foreground">
								{formatTimestamp(review.timestamp)}
							</span>
						</div>
						{review.summary && <p className="text-xs mt-1">{review.summary}</p>}
						{review.comments && review.comments.length > 0 && (
							<p className="text-xs text-muted-foreground mt-1">
								{review.comments.length} {t("review.comments")},{" "}
								{review.comments.filter((c) => !c.resolved).length} {t("review.unresolved")}
							</p>
						)}
					</div>
				))}
			</CardContent>
		</Card>
	);
}

function ConfirmAction({
	title,
	description,
	action,
	disabled,
	children,
}: {
	title: string;
	description: string;
	action: () => void;
	disabled?: boolean;
	children: React.ReactNode;
}) {
	const { t } = useI18n();
	return (
		<AlertDialog>
			<AlertDialogTrigger asChild disabled={disabled}>
				{children}
			</AlertDialogTrigger>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>{title}</AlertDialogTitle>
					<AlertDialogDescription>{description}</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>{t("review.cancel")}</AlertDialogCancel>
					<AlertDialogAction onClick={action}>{t("review.confirm")}</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}

function formatTimestamp(ts: string): string {
	try {
		return new Date(ts).toLocaleString("ja-JP", {
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
		});
	} catch {
		return ts;
	}
}
