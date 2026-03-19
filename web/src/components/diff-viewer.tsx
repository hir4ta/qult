import { diffLines } from "diff";
import { useMemo } from "react";

interface DiffViewerProps {
	oldText: string;
	newText: string;
	oldLabel?: string;
	newLabel?: string;
}

export function DiffViewer({ oldText, newText, oldLabel, newLabel }: DiffViewerProps) {
	const changes = useMemo(() => diffLines(oldText, newText), [oldText, newText]);

	let lineNum = 0;
	return (
		<div className="rounded-lg border text-xs font-mono overflow-auto max-h-[60vh]">
			{(oldLabel || newLabel) && (
				<div className="flex gap-4 border-b px-3 py-1.5 text-[10px] text-muted-foreground bg-muted/30">
					{oldLabel && <span>--- {oldLabel}</span>}
					{newLabel && <span>+++ {newLabel}</span>}
				</div>
			)}
			<div className="divide-y divide-border/30">
				{changes.map((change, i) => {
					const lines = change.value.replace(/\n$/, "").split("\n");
					return lines.map((line, j) => {
						if (!change.added && !change.removed) lineNum++;
						else if (change.added) lineNum++;

						const bg = change.added
							? "bg-green-50 dark:bg-green-950/30"
							: change.removed
								? "bg-red-50 dark:bg-red-950/30"
								: "";
						const textColor = change.added
							? "text-green-800 dark:text-green-300"
							: change.removed
								? "text-red-800 dark:text-red-300"
								: "text-foreground/70";
						const prefix = change.added ? "+" : change.removed ? "-" : " ";

						return (
							<div
								key={`${i}-${j}`}
								className={`flex ${bg}`}
							>
								<span className="w-10 shrink-0 text-right pr-2 text-muted-foreground/50 select-none border-r border-border/30 py-px">
									{!change.removed ? lineNum : ""}
								</span>
								<span className={`pl-1 ${textColor} whitespace-pre-wrap break-all py-px`}>
									<span className="select-none opacity-50">{prefix}</span>
									{line}
								</span>
							</div>
						);
					});
				})}
			</div>
		</div>
	);
}
