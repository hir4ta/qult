import { ReviewPanel } from "@/components/review/ReviewPanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
	specContentQueryOptions,
	specsQueryOptions,
	tasksQueryOptions,
	validationQueryOptions,
} from "@/lib/api";
import type { SpecEntry, TaskDetail, ValidationReport } from "@/lib/types";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { CircleCheck, CircleDot, MessageSquareText } from "lucide-react";
import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";

export const Route = createFileRoute("/tasks/$slug")({
	component: TaskDetailPage,
});

const SIZE_LABELS: Record<string, string> = {
	S: "Small — 3 spec files",
	M: "Medium — 4-5 spec files",
	L: "Large — 7 spec files",
	XL: "Extra Large — 7 spec files",
	D: "Delta — 2 spec files",
};

function TaskDetailPage() {
	const { slug } = Route.useParams();
	const { data: tasksData } = useQuery(tasksQueryOptions());
	const { data: specsData } = useQuery(specsQueryOptions(slug));
	const { data: validationData } = useQuery(validationQueryOptions(slug));
	const [selectedFile, setSelectedFile] = useState<string | null>(null);
	const [reviewMode, setReviewMode] = useState(false);

	const task = tasksData?.tasks.find((t) => t.slug === slug);
	const specs = specsData?.specs ?? [];
	const activeFile = selectedFile ?? specs[0]?.file ?? null;
	const { data: contentData } = useQuery(specContentQueryOptions(slug, activeFile ?? ""));
	const content = contentData?.content ?? "";
	const isPending = task?.review_status === "pending";

	if (!task) {
		return <p className="text-sm text-muted-foreground">Task not found.</p>;
	}

	return (
		<div className="space-y-4">
			{/* Header */}
			<div className="flex items-center gap-3">
				{task.status === "completed" ? (
					<CircleCheck className="size-5 shrink-0 text-brand-pattern" />
				) : (
					<CircleDot className="size-5 shrink-0 text-brand-session" />
				)}
				<h2 className="text-lg font-semibold" style={{ fontFamily: "var(--font-display)" }}>
					{task.slug}
				</h2>
				{task.size && (
					<Tooltip>
						<TooltipTrigger asChild>
							<Badge variant="outline" className="cursor-help">{task.size}</Badge>
						</TooltipTrigger>
						<TooltipContent>{SIZE_LABELS[task.size] ?? `Size: ${task.size}`}</TooltipContent>
					</Tooltip>
				)}
				{task.spec_type && (
					<Tooltip>
						<TooltipTrigger asChild>
							<Badge variant="outline" className="cursor-help">{task.spec_type}</Badge>
						</TooltipTrigger>
						<TooltipContent>Spec type: {task.spec_type}</TooltipContent>
					</Tooltip>
				)}
				{task.review_status && (
					<Badge
						variant="outline"
						className="text-xs"
						style={{
							borderColor:
								task.review_status === "approved"
									? "rgba(45,139,122,0.4)"
									: task.review_status === "changes_requested"
										? "rgba(230,126,34,0.4)"
										: "rgba(107,114,128,0.3)",
							color:
								task.review_status === "approved"
									? "#2d8b7a"
									: task.review_status === "changes_requested"
										? "#e67e22"
										: "#6b7280",
						}}
					>
						{task.review_status}
					</Badge>
				)}
				{validationData && <ValidationBadge report={validationData} />}
				{isPending && activeFile && (
					<Button
						size="sm"
						variant="outline"
						className="ml-auto gap-1.5 text-xs"
						onClick={() => setReviewMode(!reviewMode)}
					>
						<MessageSquareText className="h-3.5 w-3.5" />
						{reviewMode ? "Exit Review" : "Review"}
					</Button>
				)}
			</div>

			{task.focus && (
				<p className="text-sm text-muted-foreground">{task.focus}</p>
			)}

			<Separator />

			{/* File list (left) + Spec viewer (right) */}
			<div className="flex gap-4">
				<div className="w-40 shrink-0 space-y-1">
					{specs.map((spec) => (
						<button
							type="button"
							key={spec.file}
							onClick={() => { setSelectedFile(spec.file); setReviewMode(false); }}
							className={`w-full rounded-md px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-accent ${
								activeFile === spec.file ? "bg-accent font-medium" : ""
							}`}
						>
							{spec.file.replace(".md", "")}
						</button>
					))}
					{specs.length === 0 && <p className="text-xs text-muted-foreground">No spec files.</p>}
				</div>
				<div className="min-w-0 flex-1">
					{activeFile ? (
						reviewMode && isPending ? (
							<ReviewPanel
								slug={slug}
								reviewStatus={task.review_status ?? "pending"}
								specContent={content}
								currentFile={activeFile}
							/>
						) : (
							<SpecContentViewer content={content} file={activeFile} />
						)
					) : (
						<div className="flex h-40 items-center justify-center rounded-lg border border-dashed border-stone-200">
							<p className="text-sm text-muted-foreground">Select a spec file to view.</p>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}

function ValidationBadge({ report }: { report: ValidationReport }) {
	const passed = report.checks.filter((c) => c.status === "pass").length;
	const failed = report.checks.filter((c) => c.status === "fail").length;
	const color = failed > 0 ? "#c0392b" : "#2d8b7a";
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Badge variant="outline" className="text-xs cursor-help" style={{ borderColor: color, color }}>
					{passed}P / {failed}F
				</Badge>
			</TooltipTrigger>
			<TooltipContent>
				<p>Validation: {passed} passed, {failed} failed</p>
				<p className="opacity-75">Checks spec file existence and structure</p>
			</TooltipContent>
		</Tooltip>
	);
}

function SpecContentViewer({ content, file }: { content: string; file: string }) {
	return (
		<Card className="!gap-0 !py-0">
			<CardContent className="p-0">
				<ScrollArea className="h-[calc(100vh-220px)]">
					<div className="p-5 overflow-hidden prose prose-sm prose-stone dark:prose-invert max-w-[80ch]
						prose-headings:text-sm prose-headings:font-semibold prose-headings:mt-3 prose-headings:mb-1.5
						prose-h1:text-base prose-h1:mt-0 prose-h1:mb-2
						prose-p:text-[13px] prose-p:leading-relaxed prose-p:my-1
						prose-li:text-[13px] prose-li:my-0
						prose-table:text-[12px]
						prose-th:px-3 prose-th:py-1.5 prose-th:text-left prose-th:border prose-th:border-border prose-th:bg-muted/50
						prose-td:px-3 prose-td:py-1.5 prose-td:border prose-td:border-border
						[&_table]:!w-auto
						prose-code:text-[12px] prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-foreground
						prose-pre:bg-muted prose-pre:text-foreground prose-pre:rounded-lg prose-pre:my-2
						[&_pre]:p-0 [&_pre_code]:bg-transparent [&_pre_code]:text-foreground [&_pre_code]:p-3 [&_pre_code]:block [&_pre_code]:text-[12px] [&_pre_code]:leading-relaxed [&_pre_code]:whitespace-pre-wrap [&_pre_code]:break-all
						[&_code]:break-all">
						{content ? (
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
								{content}
							</Markdown>
						) : (
							<p className="text-xs text-muted-foreground">Loading...</p>
						)}
					</div>
				</ScrollArea>
			</CardContent>
		</Card>
	);
}
