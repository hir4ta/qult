import { motion } from "motion/react";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/lib/i18n";
import { butlerSpring } from "@/lib/motion";
import EmptyTraySvg from "@/assets/butler/empty-tray.svg?raw";
import MonocleSvg from "@/assets/butler/monocle.svg?raw";
import BookshelfSvg from "@/assets/butler/bookshelf.svg?raw";
import ConcernedSvg from "@/assets/butler/concerned.svg?raw";
import BowSvg from "@/assets/butler/bow.svg?raw";

type ButlerScene = "empty-tray" | "monocle" | "bookshelf" | "concerned" | "bow";

const scenes: Record<ButlerScene, string> = {
	"empty-tray": EmptyTraySvg,
	monocle: MonocleSvg,
	bookshelf: BookshelfSvg,
	concerned: ConcernedSvg,
	bow: BowSvg,
};

interface ButlerEmptyProps {
	scene: ButlerScene;
	messageKey: TranslationKey;
	className?: string;
}

export function ButlerEmpty({ scene, messageKey, className }: ButlerEmptyProps) {
	const { t } = useI18n();

	return (
		<motion.div
			className={`flex flex-col items-center justify-center gap-4 py-12 ${className ?? ""}`}
			initial={{ opacity: 0, y: 8 }}
			animate={{ opacity: 1, y: 0 }}
			transition={butlerSpring}
		>
			<div
				className="w-32 h-24 text-muted-foreground/40"
				// biome-ignore lint/security/noDangerouslySetInnerHtml: trusted SVG assets
				dangerouslySetInnerHTML={{ __html: scenes[scene] }}
			/>
			<p className="text-sm text-muted-foreground italic max-w-xs text-center">
				{t(messageKey)}
			</p>
		</motion.div>
	);
}
