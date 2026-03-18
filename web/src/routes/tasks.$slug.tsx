import { ReviewPanel } from "@/components/review/ReviewPanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
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
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { CircleCheck, CircleDot, FileText, MessageSquareText } from "lucide-react";
import { useState } from "react";
import Markdown from "react-markdown";
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
	const [mode, setMode] = useState<"view" | "review">("view");

	const task = tasksData?.tasks.find((t) => t.slug === slug);
	const specs = specsData?.specs ?? [];
	const { data: contentData } = useQuery(specContentQueryOptions(slug, selectedFile ?? ""));
	const content = contentData?.content ?? "";

	if (!task) {
		return <p className="text-sm text-muted-foreground">Task not found.</p>;
	}

	const firstUncheckedIdx = task.next_steps?.findIndex((s) => !s.done) ?? -1;

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
			</div>

			{task.focus && (
				<p className="text-sm text-muted-foreground pl-8">{task.focus}</p>
			)}

			<Separator />

			{/* Main content: Next Steps (left) + Spec viewer (right) */}
			<div className="flex gap-5">
				{/* Left column: Next Steps + File list */}
				<div className="w-56 shrink-0 space-y-4">
					{/* Next Steps */}
					{task.next_steps && task.next_steps.length > 0 && (
						<div className="space-y-1">
							<p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">
								Next Steps
							</p>
							{task.next_steps.map((step, i) => {
								const isCurrent = i === firstUncheckedIdx;
								return (
									<div
										key={`step-${i}`}
										className={cn(
											"relative flex items-start gap-2 rounded-md px-2 py-1 transition-colors",
											isCurrent && "overflow-hidden",
										)}
									>
										{isCurrent && (
											<div
												className="absolute inset-0 animate-shimmer"
												style={{
													background:
														"linear-gradient(90deg, rgba(45,139,122,0.03) 0%, rgba(45,139,122,0.10) 50%, rgba(45,139,122,0.03) 100%)",
													backgroundSize: "200% 100%",
												}}
											/>
										)}
										<Checkbox checked={step.done} className="relative mt-0.5" />
										<span
											className={cn(
												"relative text-[11px] leading-relaxed",
												step.done && "line-through text-muted-foreground",
												isCurrent && "font-medium",
											)}
										>
											{step.text}
										</span>
									</div>
								);
							})}
						</div>
					)}

					<Separator />

					{/* File list */}
					<div className="space-y-1">
						<p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">
							Spec Files
						</p>
						<SpecFileList specs={specs} selected={selectedFile} onSelect={setSelectedFile} />
						{selectedFile && task.review_status === "pending" && (
							<Button
								size="sm"
								variant="outline"
								className="w-full gap-1.5 text-xs mt-2"
								onClick={() => setMode(mode === "review" ? "view" : "review")}
							>
								<MessageSquareText className="h-3.5 w-3.5" />
								{mode === "review" ? "Exit Review" : "Review"}
							</Button>
						)}
					</div>
				</div>

				{/* Right column: Spec content */}
				<div className="min-w-0 flex-1">
					{selectedFile && (
						<Tabs value={mode} onValueChange={(v) => setMode(v as "view" | "review")}>
							<TabsList className="mb-3">
								<TabsTrigger value="view" className="gap-1 text-xs">
									<FileText className="h-3.5 w-3.5" />
									View
								</TabsTrigger>
								{task.review_status === "pending" && (
									<TabsTrigger value="review" className="gap-1 text-xs">
										<MessageSquareText className="h-3.5 w-3.5" />
										Review
									</TabsTrigger>
								)}
							</TabsList>
							<TabsContent value="view">
								<SpecContentViewer content={content} file={selectedFile} />
							</TabsContent>
							<TabsContent value="review">
								<ReviewPanel
									slug={slug}
									reviewStatus={task.review_status ?? "pending"}
									specContent={content}
									currentFile={selectedFile}
								/>
							</TabsContent>
						</Tabs>
					)}
					{!selectedFile && (
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

function SpecFileList({
	specs,
	selected,
	onSelect,
}: {
	specs: SpecEntry[];
	selected: string | null;
	onSelect: (file: string) => void;
}) {
	return (
		<div className="space-y-0.5">
			{specs.map((spec) => (
				<button
					type="button"
					key={spec.file}
					onClick={() => onSelect(spec.file)}
					className={cn(
						"w-full rounded-md px-2 py-1.5 text-left text-[12px] transition-colors",
						"hover:bg-accent",
						selected === spec.file && "bg-accent font-medium",
					)}
				>
					{spec.file}
				</button>
			))}
			{specs.length === 0 && <p className="text-xs text-muted-foreground px-2">No spec files.</p>}
		</div>
	);
}

function SpecContentViewer({ content, file }: { content: string; file: string }) {
	return (
		<Card className="!gap-0 !py-0">
			<div className="px-4 py-2.5 border-b border-border">
				<span className="text-sm font-bold">{file}</span>
			</div>
			<CardContent className="p-0">
				<ScrollArea className="h-[600px]">
					<div className="p-4 prose prose-sm prose-stone dark:prose-invert max-w-none
						prose-headings:text-sm prose-headings:font-semibold prose-headings:mt-3 prose-headings:mb-1.5
						prose-h1:text-base prose-h1:mt-0 prose-h1:mb-2
						prose-p:text-xs prose-p:leading-relaxed prose-p:my-1
						prose-li:text-xs prose-li:my-0
						prose-table:text-[11px]
						prose-th:px-2 prose-th:py-1 prose-th:text-left prose-th:border prose-th:border-border prose-th:bg-muted/50 prose-th:whitespace-nowrap
						prose-td:px-2 prose-td:py-1 prose-td:border prose-td:border-border
						prose-code:text-xs prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-foreground
						prose-pre:p-0 prose-pre:bg-muted/50 prose-pre:text-foreground prose-pre:rounded-lg
						[&_table]:w-full [&_table]:table-fixed
						[&_td]:break-words [&_th]:break-words
						[&_pre_code]:bg-transparent [&_pre_code]:p-3 [&_pre_code]:block [&_pre_code]:text-[11px] [&_pre_code]:leading-relaxed [&_pre_code]:whitespace-pre-wrap [&_pre_code]:break-words">
						{content ? (
							<Markdown
								components={{
									// Strip the first H1 title (redundant with file name header).
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
							<p className="text-xs text-muted-foreground">No content.</p>
						)}
					</div>
				</ScrollArea>
			</CardContent>
		</Card>
	);
}
