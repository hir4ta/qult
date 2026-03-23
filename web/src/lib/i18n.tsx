import { createContext, useCallback, useContext, useMemo, useState } from "react";

export type Locale = "en" | "ja";

const STORAGE_KEY = "alfred-locale";

function getInitialLocale(): Locale {
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (stored === "en" || stored === "ja") return stored;
	} catch {
		// SSR or localStorage unavailable
	}
	return "en";
}

export const translations = {
	// Header tabs (dynamic via tab.labelKey)
	"nav.overview": { en: "Overview", ja: "概要" },
	"nav.tasks": { en: "Specs", ja: "スペック" },
	"nav.knowledge": { en: "Knowledge", ja: "ナレッジ" },

	// Overview stats
	"overview.totalTasks": { en: "Total Specs", ja: "スペック合計" },
	"overview.active": { en: "Active", ja: "アクティブ" },
	"overview.completed": { en: "Completed", ja: "完了" },
	"overview.knowledge": { en: "Knowledge", ja: "ナレッジ" },
	"overview.tasks": { en: "Specs", ja: "スペック" },

	// Tasks sidebar
	"tasks.waves": { en: "Waves", ja: "Wave" },

	// Task detail
	"task.completeTask": { en: "Complete Spec", ja: "スペックを完了" },
	"task.confirmComplete": { en: "Mark this spec as completed?", ja: "このスペックを完了にしますか？" },
	"task.cancel": { en: "Cancel", ja: "キャンセル" },
	"task.notFound": { en: "Spec not found.", ja: "スペックが見つかりません。" },
	"task.noSpecs": { en: "No spec files found.", ja: "スペックファイルが見つかりません。" },
	"task.focus": { en: "Focus", ja: "フォーカス" },
	"task.validation": { en: "Validation", ja: "バリデーション" },
	"task.passed": { en: "passed", ja: "成功" },
	"task.failed": { en: "failed", ja: "失敗" },

	// Knowledge
	"knowledge.entries": { en: "entries", ja: "件" },
	"knowledge.hits": { en: "hits", ja: "ヒット" },
	"knowledge.archive": { en: "Archive", ja: "アーカイブ" },
	"knowledge.restore": { en: "Restore", ja: "復元" },
	"knowledge.archiveHint": { en: "Archive (exclude from search)", ja: "アーカイブ（検索から除外）" },
	"knowledge.restoreHint": { en: "Restore to search", ja: "検索に復元" },
	"knowledge.active": { en: "Active", ja: "有効" },
	"knowledge.archived": { en: "Archived", ja: "アーカイブ済" },
	"knowledge.searchAppearances": { en: "Search result appearances", ja: "検索結果への出現回数" },
	"knowledge.patternCandidate": { en: "5+ → pattern candidate", ja: "5+ → パターン候補" },
	"knowledge.ruleCandidate": { en: "15+ → rule candidate", ja: "15+ → ルール候補" },
	"knowledge.saved": { en: "Saved", ja: "保存日" },
	"knowledge.decision": { en: "Decision", ja: "意思決定" },
	"knowledge.pattern": { en: "Pattern", ja: "パターン" },
	"knowledge.rule": { en: "Rule", ja: "ルール" },
	"knowledge.snapshot": { en: "Snapshot", ja: "スナップショット" },
	"knowledge.detail.context": { en: "Context", ja: "背景" },
	"knowledge.detail.decision": { en: "Decision", ja: "決定内容" },
	"knowledge.detail.reasoning": { en: "Reasoning", ja: "理由" },
	"knowledge.detail.alternatives": { en: "Alternatives", ja: "検討した代替案" },
	"knowledge.detail.pattern": { en: "Pattern", ja: "パターン" },
	"knowledge.detail.whenToApply": { en: "When to Apply", ja: "適用条件" },
	"knowledge.detail.expectedOutcomes": { en: "Expected Outcomes", ja: "期待される結果" },
	"knowledge.detail.rule": { en: "Rule", ja: "ルール" },
	"knowledge.detail.rationale": { en: "根拠", ja: "根拠" },
	"knowledge.promote": { en: "Promote to Rule", ja: "ルールに昇格" },
	"knowledge.promoteTitle": { en: "Promote to Rule?", ja: "ルールに昇格しますか？" },
	"knowledge.promoteDescription": { en: "This pattern will be promoted to a rule.", ja: "このパターンをルールに昇格します。" },
	"knowledge.verification.verified": { en: "Verified", ja: "検証済" },
	"knowledge.verification.overdue": { en: "Overdue", ja: "期限切れ" },
	"knowledge.verification.pending": { en: "Pending", ja: "未検証" },

	// Filters (dynamic via t(`filter.${s}`))
	"filter.all": { en: "All", ja: "全て" },
	"filter.active": { en: "Active", ja: "アクティブ" },
	"filter.done": { en: "Done", ja: "完了" },

	// Projects
	"projects.title": { en: "Projects", ja: "プロジェクト" },
	"projects.lastSeen": { en: "Last seen", ja: "最終アクセス" },
	"projects.missing": { en: "Missing", ja: "不明" },
	"projects.archived": { en: "Archived", ja: "アーカイブ済み" },
	"projects.noProjects": { en: "No projects registered yet. Use alfred in a project directory to register it.", ja: "まだプロジェクトが登録されていません。プロジェクトディレクトリで alfred を使用すると自動登録されます。" },
	"projects.save": { en: "Save", ja: "保存" },

	// Keyboard shortcuts (dynamic via desc key)
	"shortcuts.title": { en: "Keyboard Shortcuts", ja: "キーボードショートカット" },
	"shortcuts.nextTask": { en: "Next task", ja: "次のタスク" },
	"shortcuts.prevTask": { en: "Previous task", ja: "前のタスク" },
	"shortcuts.toggleExpand": { en: "Toggle expand", ja: "展開/折りたたみ" },
	"shortcuts.help": { en: "Show shortcuts", ja: "ショートカット表示" },

	// Traceability
	"task.traceability": { en: "Traceability", ja: "トレーサビリティ" },
	"task.traceabilityHint1": { en: "Maps each requirement (FR) to its implementation task (T-N.N) and test case (TS-N.N).", ja: "各要件(FR)を実装タスク(T-N.N)とテストケース(TS-N.N)に紐づけます。" },
	"task.traceabilityHint2": { en: "Gaps indicate untested or unimplemented requirements.", ja: "空欄は未実装・未テストの要件を示します。" },
	"task.requirement": { en: "Requirement", ja: "要件" },
	"task.taskId": { en: "Task", ja: "タスク" },
	"task.testId": { en: "Test", ja: "テスト" },

	// Butler empty states
	"empty.noTasks": { en: "Nothing requiring your attention at the moment, sir.", ja: "ただいま、ご用件はございません。" },
	"empty.noSpecs": { en: "No specifications on file, sir. Shall I prepare one?", ja: "仕様書はございません。ご用意いたしましょうか？" },
	"empty.noMemories": { en: "The archives are empty, sir.\nKnowledge awaits discovery.", ja: "記録はございません。\n知見の蓄積をお待ちしております。" },

	// View Switcher
	"view.list": { en: "List", ja: "リスト" },
	"view.card": { en: "Card", ja: "カード" },

} as const;

export type TranslationKey = keyof typeof translations;

interface I18nContextValue {
	locale: Locale;
	setLocale: (locale: Locale) => void;
	t: (key: TranslationKey, vars?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: React.ReactNode }) {
	const [locale, setLocaleState] = useState<Locale>(getInitialLocale);

	const setLocale = useCallback((newLocale: Locale) => {
		setLocaleState(newLocale);
		try {
			localStorage.setItem(STORAGE_KEY, newLocale);
		} catch {
			// ignore
		}
	}, []);

	const t = useCallback(
		(key: TranslationKey, vars?: Record<string, string | number>): string => {
			const entry = translations[key];
			let text: string = entry?.[locale] ?? key;
			if (vars) {
				for (const [k, v] of Object.entries(vars)) {
					text = text.replaceAll(`{${k}}`, String(v));
				}
			}
			return text;
		},
		[locale],
	);

	const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);

	return <I18nContext value={value}>{children}</I18nContext>;
}

export function useI18n() {
	const ctx = useContext(I18nContext);
	if (!ctx) throw new Error("useI18n must be used within I18nProvider");
	return ctx;
}

/** Date locale string for toLocaleDateString / toLocaleString */
export function dateLocale(locale: Locale): string {
	return locale === "ja" ? "ja-JP" : "en-US";
}
