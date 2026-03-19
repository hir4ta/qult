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

const translations = {
	// Header tabs
	"nav.overview": { en: "Overview", ja: "概要" },
	"nav.tasks": { en: "Tasks", ja: "タスク" },
	"nav.knowledge": { en: "Knowledge", ja: "ナレッジ" },
	"nav.activity": { en: "Activity", ja: "アクティビティ" },

	// Overview stats
	"overview.totalTasks": { en: "Total Tasks", ja: "タスク合計" },
	"overview.active": { en: "Active", ja: "アクティブ" },
	"overview.completed": { en: "Completed", ja: "完了" },
	"overview.knowledge": { en: "Knowledge", ja: "ナレッジ" },
	"overview.tasks": { en: "Tasks", ja: "タスク" },
	"overview.memoryHealth": { en: "Memory Health", ja: "メモリ健全性" },
	"overview.total": { en: "Total", ja: "合計" },
	"overview.stale": { en: "Stale", ja: "陳腐化" },
	"overview.staleHint": { en: "Knowledge not accessed for a long time", ja: "長期間アクセスされていないナレッジ" },
	"overview.conflicts": { en: "Conflicts", ja: "競合" },
	"overview.conflictsHint": { en: "Knowledge entries that may contradict each other", ja: "互いに矛盾の可能性があるナレッジ" },
	"overview.vitality": { en: "Vitality", ja: "活性度" },
	"overview.epics": { en: "Epics", ja: "エピック" },
	"overview.recentDecisions": { en: "Recent Decisions", ja: "最近の意思決定" },

	// Size labels
	"size.S": { en: "Small — 3 spec files", ja: "Small — スペック3ファイル" },
	"size.M": { en: "Medium — 4-5 spec files", ja: "Medium — スペック4-5ファイル" },
	"size.L": { en: "Large — 7 spec files", ja: "Large — スペック7ファイル" },
	"size.XL": { en: "Extra Large — 7 spec files", ja: "Extra Large — スペック7ファイル" },
	"size.D": { en: "Delta — 2 spec files", ja: "Delta — スペック2ファイル" },

	// Tasks sidebar
	"tasks.hideCompleted": { en: "Hide completed", ja: "完了を非表示" },
	"tasks.showCompleted": { en: "Show completed", ja: "完了を表示" },
	"tasks.noTasks": { en: "No tasks found.", ja: "タスクが見つかりません。" },
	"tasks.nextSteps": { en: "Next Steps", ja: "次のステップ" },
	"tasks.waves": { en: "Waves", ja: "Wave" },

	// Task detail
	"task.completeTask": { en: "Complete Task", ja: "タスクを完了" },
	"task.confirmComplete": { en: "Mark this task as completed?", ja: "このタスクを完了にしますか？" },
	"task.confirm": { en: "Confirm", ja: "確認" },
	"task.cancel": { en: "Cancel", ja: "キャンセル" },
	"task.notFound": { en: "Task not found.", ja: "タスクが見つかりません。" },
	"task.noSpecs": { en: "No spec files found.", ja: "スペックファイルが見つかりません。" },
	"task.started": { en: "Started", ja: "開始" },
	"task.completed": { en: "Completed", ja: "完了" },
	"task.focus": { en: "Focus", ja: "フォーカス" },
	"task.validation": { en: "Validation", ja: "バリデーション" },
	"task.passed": { en: "passed", ja: "成功" },
	"task.failed": { en: "failed", ja: "失敗" },

	// Knowledge
	"knowledge.filter": { en: "Filter...", ja: "フィルター..." },
	"knowledge.entries": { en: "entries", ja: "件" },
	"knowledge.hits": { en: "hits", ja: "ヒット" },
	"knowledge.archive": { en: "Archive", ja: "アーカイブ" },
	"knowledge.restore": { en: "Restore", ja: "復元" },
	"knowledge.archiveHint": { en: "Archive (exclude from search)", ja: "アーカイブ（検索から除外）" },
	"knowledge.restoreHint": { en: "Restore to search", ja: "検索に復元" },
	"knowledge.active": { en: "Active", ja: "有効" },
	"knowledge.archived": { en: "Archived", ja: "アーカイブ済" },
	"knowledge.noMemories": { en: "No memories yet.", ja: "メモリはまだありません。" },
	"knowledge.searchAppearances": { en: "Search result appearances", ja: "検索結果への出現回数" },
	"knowledge.patternCandidate": { en: "5+ → pattern candidate", ja: "5+ → パターン候補" },
	"knowledge.ruleCandidate": { en: "15+ → rule candidate", ja: "15+ → ルール候補" },
	"knowledge.saved": { en: "Saved", ja: "保存日" },
	"knowledge.decision": { en: "Decision", ja: "意思決定" },
	"knowledge.pattern": { en: "Pattern", ja: "パターン" },
	"knowledge.rule": { en: "Rule", ja: "ルール" },
	"knowledge.snapshot": { en: "Snapshot", ja: "スナップショット" },
	"knowledge.viewGrid": { en: "Grid", ja: "グリッド" },
	"knowledge.viewGraph": { en: "Graph", ja: "グラフ" },
	"knowledge.graphMinEntries": { en: "At least 5 knowledge entries needed for graph view", ja: "グラフ表示には5件以上のナレッジが必要です" },
	"knowledge.graphTruncated": { en: "Showing top entries by access count", ja: "アクセス数上位のエントリを表示中" },
	"knowledge.graphMethod": { en: "Edges via", ja: "エッジ計算:" },
	"knowledge.graphLoading": { en: "Computing graph...", ja: "グラフを計算中..." },
	"knowledge.graphError": { en: "Failed to load graph", ja: "グラフの読み込みに失敗しました" },
	"knowledge.graphConnections": { en: "connections", ja: "件の接続" },
	"knowledge.detail.context": { en: "Context", ja: "背景" },
	"knowledge.detail.decision": { en: "Decision", ja: "決定内容" },
	"knowledge.detail.reasoning": { en: "Reasoning", ja: "理由" },
	"knowledge.detail.alternatives": { en: "Alternatives", ja: "検討した代替案" },
	"knowledge.detail.pattern": { en: "Pattern", ja: "パターン" },
	"knowledge.detail.whenToApply": { en: "When to Apply", ja: "適用条件" },
	"knowledge.detail.expectedOutcomes": { en: "Expected Outcomes", ja: "期待される結果" },
	"knowledge.detail.rule": { en: "Rule", ja: "ルール" },
	"knowledge.detail.rationale": { en: "根拠", ja: "根拠" },

	// Activity
	"activity.all": { en: "All", ja: "すべて" },
	"activity.timestamp": { en: "Timestamp", ja: "タイムスタンプ" },
	"activity.action": { en: "Action", ja: "アクション" },
	"activity.target": { en: "Target", ja: "対象" },
	"activity.detail": { en: "Detail", ja: "詳細" },
	"activity.noActivity": { en: "No activity found.", ja: "アクティビティが見つかりません。" },
	"activity.epics": { en: "Epics", ja: "エピック" },

	// Section card
	"section.approve": { en: "Approve", ja: "承認" },
	"section.approved": { en: "Approved", ja: "承認済" },
} as const;

export type TranslationKey = keyof typeof translations;

interface I18nContextValue {
	locale: Locale;
	setLocale: (locale: Locale) => void;
	t: (key: TranslationKey) => string;
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
		(key: TranslationKey): string => {
			const entry = translations[key];
			return entry?.[locale] ?? key;
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
