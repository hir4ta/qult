import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CircleHelp } from "@animated-color-icons/lucide-react";
import { useI18n } from "@/lib/i18n";

interface TraceRow {
	fr: string;
	tasks: string[];
	tests: string[];
}

/** Extract FR→Task→Test traceability from spec content. */
function extractTraceability(specContents: Record<string, string>): TraceRow[] {
	const reqContent = specContents["requirements.md"] ?? "";
	const taskContent = specContents["tasks.md"] ?? "";
	const testContent = specContents["test-specs.md"] ?? "";

	// Extract all FR-N IDs from requirements
	const frIds = [...new Set(reqContent.match(/FR-\d+/g) ?? [])].sort();

	return frIds.map((fr) => {
		// Find tasks referencing this FR
		const taskMatches: string[] = [];
		const taskLines = taskContent.split("\n");
		for (const line of taskLines) {
			if (line.includes(fr)) {
				const taskMatch = line.match(/T-\d+\.\d+/);
				if (taskMatch) taskMatches.push(taskMatch[0]);
			}
		}

		// Find tests referencing this FR
		const testMatches: string[] = [];
		const testLines = testContent.split("\n");
		for (let i = 0; i < testLines.length; i++) {
			if (testLines[i]!.includes(fr)) {
				// Look backwards for TS-N.N header
				for (let j = i; j >= Math.max(0, i - 5); j--) {
					const tsMatch = testLines[j]!.match(/TS-\d+\.\d+/);
					if (tsMatch) { testMatches.push(tsMatch[0]); break; }
				}
			}
		}

		return { fr, tasks: [...new Set(taskMatches)], tests: [...new Set(testMatches)] };
	});
}

export function TraceabilityMatrix({ specContents }: { specContents: Record<string, string> }) {
	const { t } = useI18n();
	const rows = extractTraceability(specContents);

	if (rows.length === 0) return null;

	return (
		<div className="rounded-xl border border-border bg-card">
			<div className="px-4 py-2.5">
				<div className="flex items-center gap-1.5">
					<h3 className="text-sm font-semibold" style={{ fontFamily: "var(--font-display)" }}>
						{t("task.traceability")}
					</h3>
					<Popover>
						<PopoverTrigger asChild>
							<button type="button" className="al-icon-wrapper text-muted-foreground hover:text-foreground transition-colors">
								<CircleHelp className="size-3.5" />
							</button>
						</PopoverTrigger>
						<PopoverContent className="max-w-xs text-xs space-y-1">
							<p>{t("task.traceabilityHint1")}</p>
							<p className="text-muted-foreground">{t("task.traceabilityHint2")}</p>
						</PopoverContent>
					</Popover>
				</div>
			</div>
			<div className="border-t overflow-auto">
				<table className="w-full text-xs">
					<thead>
						<tr className="border-b bg-muted/30">
							<th className="px-3 py-1.5 text-left font-medium">{t("task.requirement")}</th>
							<th className="px-3 py-1.5 text-left font-medium">{t("task.taskId")}</th>
							<th className="px-3 py-1.5 text-left font-medium">{t("task.testId")}</th>
						</tr>
					</thead>
					<tbody>
						{rows.map((row) => (
							<tr key={row.fr} className="border-b last:border-0">
								<td className="px-3 py-1.5 font-mono font-medium">{row.fr}</td>
								<td className="px-3 py-1.5 font-mono text-muted-foreground">
									{row.tasks.length > 0 ? row.tasks.join(", ") : "—"}
								</td>
								<td className="px-3 py-1.5 font-mono text-muted-foreground">
									{row.tests.length > 0 ? row.tests.join(", ") : "—"}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	);
}
