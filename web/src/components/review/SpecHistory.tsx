import { useQuery } from "@tanstack/react-query";
import { History } from "lucide-react";
import { useState } from "react";
import { DiffViewer } from "@/components/diff-viewer";
import { specContentQueryOptions, specHistoryQueryOptions, specVersionQueryOptions } from "@/lib/api";
import { useI18n } from "@/lib/i18n";

interface SpecHistoryProps {
	slug: string;
	file: string;
}

export function SpecHistory({ slug, file }: SpecHistoryProps) {
	const { t } = useI18n();
	const { data: historyData } = useQuery(specHistoryQueryOptions(slug, file));
	const { data: currentData } = useQuery(specContentQueryOptions(slug, file));

	const versions = historyData?.versions ?? [];
	const [oldVersion, setOldVersion] = useState<string>("");
	const [newVersion, setNewVersion] = useState<string>("current");

	// Auto-select: old = latest history version, new = current
	const effectiveOld = oldVersion || (versions.length > 0 ? versions[0]!.timestamp : "");

	const { data: oldData } = useQuery(specVersionQueryOptions(slug, file, effectiveOld));

	if (versions.length === 0) {
		return (
			<div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
				<History className="size-4 mr-2" />
				{t("review.noHistory")}
			</div>
		);
	}

	const newVersionTs = newVersion !== "current" ? newVersion : "";
	const { data: newVersionData } = useQuery(specVersionQueryOptions(slug, file, newVersionTs));
	const oldText = oldData?.content ?? "";
	const newText = newVersion === "current" ? (currentData?.content ?? "") : (newVersionData?.content ?? "");

	return (
		<div className="space-y-3">
			{/* Version selectors */}
			<div className="flex items-center gap-3 text-xs">
				<div className="flex items-center gap-1.5">
					<span className="text-muted-foreground">{t("review.oldVersion")}:</span>
					<select
						value={effectiveOld}
						onChange={(e) => setOldVersion(e.target.value)}
						className="rounded-lg border bg-card px-2 py-1 text-xs h-7"
					>
						{versions.map((v) => (
							<option key={v.timestamp} value={v.timestamp}>
								{formatVersionTimestamp(v.timestamp)}
							</option>
						))}
					</select>
				</div>
				<span className="text-muted-foreground">→</span>
				<div className="flex items-center gap-1.5">
					<span className="text-muted-foreground">{t("review.newVersion")}:</span>
					<select
						value={newVersion}
						onChange={(e) => setNewVersion(e.target.value)}
						className="rounded-lg border bg-card px-2 py-1 text-xs h-7"
					>
						<option value="current">{t("review.currentVersion")}</option>
						{versions.map((v) => (
							<option key={v.timestamp} value={v.timestamp}>
								{formatVersionTimestamp(v.timestamp)}
							</option>
						))}
					</select>
				</div>
			</div>

			{/* Diff viewer */}
			{oldText && newText ? (
				<DiffViewer
					oldText={oldText}
					newText={newText}
					oldLabel={formatVersionTimestamp(effectiveOld)}
					newLabel={newVersion === "current" ? t("review.currentVersion") : formatVersionTimestamp(newVersion)}
				/>
			) : (
				<div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
					{t("review.loadingVersions")}
				</div>
			)}
		</div>
	);
}

/** Format version timestamp (YYYYMMDDTHHmmss → YYYY-MM-DD HH:mm) */
function formatVersionTimestamp(ts: string): string {
	if (ts.length < 13) return ts;
	return `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)} ${ts.slice(9, 11)}:${ts.slice(11, 13)}`;
}
