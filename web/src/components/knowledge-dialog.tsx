import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogDescription,
} from "@/components/ui/dialog";
import { KnowledgeDrawerContent } from "@/components/knowledge-detail";
import { formatLabel } from "@/lib/format";
import type { KnowledgeEntry } from "@/lib/types";

export function KnowledgeDialog({
	entry,
	onClose,
}: {
	entry: KnowledgeEntry | null;
	onClose: () => void;
}) {
	if (!entry) return null;

	const { title, source } = formatLabel(entry.label);

	return (
		<Dialog open={!!entry} onOpenChange={(open) => { if (!open) onClose(); }}>
			<DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto rounded-organic p-0">
				<div className="px-6 pb-6 pt-5 space-y-4">
					<DialogHeader>
						<DialogTitle
							className="text-xl font-bold tracking-tight pr-8"
							style={{ fontFamily: "var(--font-display)" }}
						>
							{title}
						</DialogTitle>
						{source && (
							<DialogDescription className="text-xs">
								{source}
							</DialogDescription>
						)}
					</DialogHeader>

					<KnowledgeDrawerContent entry={entry} onClose={onClose} />
				</div>
			</DialogContent>
		</Dialog>
	);
}
