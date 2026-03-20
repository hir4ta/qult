import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { useI18n } from "@/lib/i18n";

const SHORTCUTS = [
	{ key: "j", desc: "shortcuts.nextTask" },
	{ key: "k", desc: "shortcuts.prevTask" },
	{ key: "e", desc: "shortcuts.toggleExpand" },
	{ key: "?", desc: "shortcuts.help" },
] as const;

export function KeyboardHelpDialog({
	open,
	onClose,
}: {
	open: boolean;
	onClose: () => void;
}) {
	const { t } = useI18n();
	return (
		<Dialog open={open} onOpenChange={(o) => !o && onClose()}>
			<DialogContent className="max-w-sm">
				<DialogHeader>
					<DialogTitle className="text-base">{t("shortcuts.title")}</DialogTitle>
				</DialogHeader>
				<div className="space-y-2">
					{SHORTCUTS.map((s) => (
						<div key={s.key} className="flex items-center justify-between py-1">
							<span className="text-sm text-muted-foreground">{t(s.desc as never)}</span>
							<kbd className="rounded border bg-muted px-2 py-0.5 text-xs font-mono">{s.key}</kbd>
						</div>
					))}
				</div>
			</DialogContent>
		</Dialog>
	);
}
