import { useEffect } from "react";

type ShortcutMap = Record<string, () => void>;

/** Register keyboard shortcuts. Ignores events from input/textarea elements. */
export function useKeyboardShortcuts(shortcuts: ShortcutMap) {
	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			const target = e.target as HTMLElement;
			if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;

			const key = e.key;
			const fn = shortcuts[key];
			if (fn) {
				e.preventDefault();
				fn();
			}
		};
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, [shortcuts]);
}
