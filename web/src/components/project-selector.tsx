import { useQuery } from "@tanstack/react-query";
import { projectsQueryOptions } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";

export function ProjectSelector() {
	const { t } = useI18n();
	const { data } = useQuery(projectsQueryOptions());
	const search = useSearch({ strict: false }) as { project?: string };
	const navigate = useNavigate();
	const projects = data?.projects ?? [];
	const activeProjects = projects.filter((p) => p.status !== "archived");

	if (activeProjects.length === 0) return null;

	return (
		<Select
			value={search.project ?? "__all__"}
			onValueChange={(val) => {
				const projectId = val === "__all__" ? undefined : val;
				const params = new URLSearchParams(window.location.search);
				if (projectId) params.set("project", projectId);
				else params.delete("project");
				navigate({
					to: ".",
					search: Object.fromEntries(params),
				} as never);
			}}
		>
			<SelectTrigger className="h-8 w-[180px] text-sm">
				<SelectValue placeholder={t("projects.allProjects")} />
			</SelectTrigger>
			<SelectContent>
				<SelectItem value="__all__">{t("projects.allProjects")}</SelectItem>
				{activeProjects.map((p) => (
					<SelectItem key={p.id} value={p.id}>
						{p.name}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}
