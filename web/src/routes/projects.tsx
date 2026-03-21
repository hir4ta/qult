import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { projectsQueryOptions } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import type { ProjectRecord } from "@/lib/types";
import { Archive, ArchiveRestore, Pencil } from "@animated-color-icons/lucide-react";
import { useState } from "react";
import { Input } from "@/components/ui/input";


export const Route = createFileRoute("/projects")({
	component: ProjectsPage,
});

function ProjectsPage() {
	const { t } = useI18n();
	const { data } = useQuery(projectsQueryOptions());
	const projects = data?.projects ?? [];

	return (
		<div className="space-y-6">
			<h1
				className="text-2xl font-bold"
				style={{ fontFamily: "var(--font-display)" }}
			>
				{t("projects.title")}
			</h1>
			{projects.length === 0 ? (
				<p className="text-muted-foreground text-sm">{t("projects.noProjects")}</p>
			) : (
				<div className="space-y-3">
					{projects.map((p) => (
						<ProjectCard key={p.id} project={p} />
					))}
				</div>
			)}
		</div>
	);
}

function ProjectCard({ project }: { project: ProjectRecord }) {
	const { t } = useI18n();
	const queryClient = useQueryClient();
	const [editing, setEditing] = useState(false);
	const [name, setName] = useState(project.name);

	const mutation = useMutation({
		mutationFn: async (body: { name?: string; status?: string }) => {
			const res = await fetch(`/api/projects/${encodeURIComponent(project.id)}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			if (!res.ok) throw new Error("Failed");
		},
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: ["projects"] }),
	});

	const isArchived = project.status === "archived";
	const isMissing = project.status === "missing";

	return (
		<div
			className={`rounded-organic border p-4 ${isArchived || isMissing ? "opacity-60" : ""}`}
		>
			<div className="flex items-center justify-between gap-4">
				<div className="min-w-0 flex-1">
					{editing ? (
						<form
							onSubmit={(e) => {
								e.preventDefault();
								mutation.mutate({ name });
								setEditing(false);
							}}
							className="flex items-center gap-2"
						>
							<Input
								value={name}
								onChange={(e) => setName(e.target.value)}
								className="h-8 text-sm"
							/>
							<button
								type="submit"
								className="text-xs font-medium"
								style={{ color: "var(--color-brand-dark)" }}
							>
								{t("projects.save")}
							</button>
						</form>
					) : (
						<div className="flex items-center gap-2">
							<span className="font-medium text-sm">{project.name}</span>
							{isMissing && (
								<span className="text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-700">
									{t("projects.missing")}
								</span>
							)}
							{isArchived && (
								<span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">
									{t("projects.archived")}
								</span>
							)}
						</div>
					)}
					<div className="text-[11px] text-muted-foreground mt-0.5 font-mono truncate">
						{project.path}
					</div>
					{project.remote && (
						<div className="text-[11px] text-muted-foreground font-mono truncate">
							{project.remote}
						</div>
					)}
				</div>
				<div className="flex items-center gap-1 shrink-0">
					<button
						type="button"
						onClick={() => setEditing(!editing)}
						className="al-icon-wrapper p-1.5 rounded hover:bg-muted"
					>
						<Pencil className="size-3.5" />
					</button>
					<button
						type="button"
						onClick={() =>
							mutation.mutate({
								status: isArchived ? "active" : "archived",
							})
						}
						className="al-icon-wrapper p-1.5 rounded hover:bg-muted"
					>
						{isArchived ? (
							<ArchiveRestore className="size-3.5" />
						) : (
							<Archive className="size-3.5" />
						)}
					</button>
				</div>
			</div>
			<div className="text-[10px] text-muted-foreground mt-1">
				{t("projects.lastSeen")}:{" "}
				{new Date(project.lastSeenAt).toLocaleDateString()}
			</div>
		</div>
	);
}
