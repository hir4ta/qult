import { ReviewPanel } from "@/components/review/ReviewPanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import { FileText, MessageSquareText } from "lucide-react";
import { useState } from "react";
import Markdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";

export const Route = createFileRoute("/tasks/$slug")({
	component: TaskDetailPage,
});

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

	return (
		<div className="space-y-4">
			<TaskHeader task={task} validation={validationData} />
			<Separator />
			<div className="flex gap-4">
				<div className="w-48 shrink-0 space-y-3">
					<SpecFileList specs={specs} selected={selectedFile} onSelect={setSelectedFile} />
					{selectedFile && task.review_status === "pending" && (
						<Button
							size="sm"
							variant="outline"
							className="w-full gap-1.5 text-xs"
							onClick={() => setMode(mode === "review" ? "view" : "review")}
						>
							<MessageSquareText className="h-3.5 w-3.5" />
							{mode === "review" ? "Exit Review" : "Review"}
						</Button>
					)}
				</div>
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
						<p className="text-sm text-muted-foreground">Select a spec file to view.</p>
					)}
				</div>
			</div>
		</div>
	);
}

function TaskHeader({ task, validation }: { task: TaskDetail; validation?: ValidationReport }) {
	return (
		<div className="space-y-2">
			<div className="flex items-center gap-3">
				<h2 className="text-lg font-semibold">{task.slug}</h2>
				{task.size && <Badge variant="outline">{task.size}</Badge>}
				{task.spec_type && <Badge variant="outline">{task.spec_type}</Badge>}
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
				{validation && <ValidationBadge report={validation} />}
			</div>
			{task.focus && <p className="text-sm text-muted-foreground">{task.focus}</p>}
			{task.next_steps && task.next_steps.length > 0 && (
				<div className="space-y-1">
					<p className="text-xs font-medium text-muted-foreground">Next Steps</p>
					{task.next_steps.map((step, i) => (
						<div key={`step-${i}`} className="flex items-center gap-2 text-sm">
							<span className={cn("text-xs", step.done && "line-through text-muted-foreground")}>
								{step.done ? "[x]" : "[ ]"} {step.text}
							</span>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

function ValidationBadge({ report }: { report: ValidationReport }) {
	const passed = report.checks.filter((c) => c.status === "pass").length;
	const failed = report.checks.filter((c) => c.status === "fail").length;
	const color = failed > 0 ? "#c0392b" : "#2d8b7a";
	return (
		<Badge variant="outline" className="text-xs" style={{ borderColor: color, color }}>
			{passed}P / {failed}F
		</Badge>
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
		<div className="space-y-1">
			{specs.map((spec) => (
				<button
					type="button"
					key={spec.file}
					onClick={() => onSelect(spec.file)}
					className={cn(
						"w-full rounded px-2 py-1.5 text-left text-sm transition-colors",
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
		<Card>
			<CardHeader className="py-2 px-4">
				<CardTitle className="text-sm font-medium">{file}</CardTitle>
			</CardHeader>
			<CardContent className="p-0">
				<ScrollArea className="h-[600px]">
					<div className="p-4 prose prose-sm prose-stone dark:prose-invert max-w-none
						prose-headings:text-sm prose-headings:font-semibold prose-headings:mt-4 prose-headings:mb-2
						prose-p:text-xs prose-p:leading-relaxed prose-p:my-1
						prose-li:text-xs prose-li:my-0
						prose-table:text-xs
						prose-th:px-2 prose-th:py-1 prose-th:text-left prose-th:border prose-th:border-border prose-th:bg-muted/50
						prose-td:px-2 prose-td:py-1 prose-td:border prose-td:border-border
						prose-code:text-xs prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:rounded
						prose-pre:p-0 prose-pre:bg-transparent">
						{content ? (
							<Markdown
								components={{
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
