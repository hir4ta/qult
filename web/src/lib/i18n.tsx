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
	// Header tabs
	"nav.overview": { en: "Overview", ja: "概要" },
	"nav.tasks": { en: "Specs", ja: "スペック" },
	"nav.knowledge": { en: "Knowledge", ja: "ナレッジ" },

	// Overview stats
	"overview.totalTasks": { en: "Total Specs", ja: "スペック合計" },
	"overview.active": { en: "Active", ja: "アクティブ" },
	"overview.completed": { en: "Completed", ja: "完了" },
	"overview.knowledge": { en: "Knowledge", ja: "ナレッジ" },
	"overview.tasks": { en: "Specs", ja: "スペック" },
	"overview.memoryHealth": { en: "Memory Health", ja: "メモリ健全性" },
	"overview.total": { en: "Total", ja: "合計" },
	"overview.stale": { en: "Stale", ja: "陳腐化" },
	"overview.staleHint": { en: "Knowledge not accessed for a long time", ja: "長期間アクセスされていないナレッジ" },
	"overview.conflicts": { en: "Conflicts", ja: "競合" },
	"overview.conflictsHint": { en: "Knowledge entries that may contradict each other", ja: "互いに矛盾の可能性があるナレッジ" },
	"overview.vitality": { en: "Vitality", ja: "活性度" },
	"overview.recentDecisions": { en: "Recent Decisions", ja: "最近の意思決定" },

	// Size labels
	"size.S": { en: "Small — 3 spec files", ja: "Small — スペック3ファイル" },
	"size.M": { en: "Medium — 4 spec files", ja: "Medium — スペック4ファイル" },
	"size.L": { en: "Large — 5 spec files", ja: "Large — スペック5ファイル" },

	// Tasks sidebar
	"tasks.hideCompleted": { en: "Hide completed", ja: "完了を非表示" },
	"tasks.showCompleted": { en: "Show completed", ja: "完了を表示" },
	"tasks.noTasks": { en: "No specs found.", ja: "スペックが見つかりません。" },
	"tasks.nextSteps": { en: "Next Steps", ja: "次のステップ" },
	"tasks.waves": { en: "Waves", ja: "Wave" },

	// Task detail
	"task.completeTask": { en: "Complete Spec", ja: "スペックを完了" },
	"task.confirmComplete": { en: "Mark this spec as completed?", ja: "このスペックを完了にしますか？" },
	"task.confirm": { en: "Confirm", ja: "確認" },
	"task.cancel": { en: "Cancel", ja: "キャンセル" },
	"task.notFound": { en: "Spec not found.", ja: "スペックが見つかりません。" },
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
	"activity.showOlder": { en: "Show older activity", ja: "過去のアクティビティを表示" },

	// Section card
	"section.reviewMode": { en: "Review", ja: "レビュー" },
	"section.readMode": { en: "Read", ja: "閲覧" },

	// Review panel
	"review.approveTitle": { en: "Approve spec?", ja: "スペックを承認しますか？" },
	"review.approveDescription": { en: "This will mark the spec as approved and allow completion.", ja: "承認するとスペックの完了が可能になります。" },
	"review.approve": { en: "Approve", ja: "承認" },
	"review.requestChangesTitle": { en: "Request changes?", ja: "変更を依頼しますか？" },
	"review.requestChangesDescription": { en: "The spec author will need to address your comments.", ja: "スペック作成者がコメントに対応する必要があります。" },
	"review.requestChanges": { en: "Request Changes", ja: "変更を依頼" },
	"review.commentOn": { en: "Comment on", ja: "コメント対象:" },
	"review.addComment": { en: "Add review comment...", ja: "レビューコメントを追加..." },
	"review.add": { en: "Add", ja: "追加" },
	"review.pendingComments": { en: "pending comment(s)", ja: "件の保留コメント" },
	"review.cancel": { en: "Cancel", ja: "キャンセル" },
	"review.confirm": { en: "Confirm", ja: "確認" },
	"review.history": { en: "Review History", ja: "レビュー履歴" },
	"review.rounds": { en: "round", ja: "ラウンド" },
	"review.comments": { en: "comment(s)", ja: "件のコメント" },
	"review.unresolved": { en: "unresolved", ja: "未解決" },

	// Action hints (overview cards)
	"action.completed": { en: "Completed", ja: "完了" },
	"action.awaitingReview": { en: "Awaiting review", ja: "レビュー待ち" },
	"action.changesRequested": { en: "Changes requested", ja: "変更依頼あり" },
	"action.implementing": { en: "Implementing", ja: "実装中" },
	"action.specCreation": { en: "Creating spec", ja: "スペック作成中" },

	// Search
	"search.placeholder": { en: "Search knowledge & specs...", ja: "ナレッジ＆スペックを検索..." },
	"search.noResults": { en: "No results found", ja: "結果が見つかりません" },
	"search.knowledge": { en: "Knowledge", ja: "ナレッジ" },
	"search.spec": { en: "Spec", ja: "スペック" },

	// Projects
	"projects.title": { en: "Projects", ja: "プロジェクト" },
	"projects.allProjects": { en: "All Projects", ja: "すべてのプロジェクト" },
	"projects.archive": { en: "Archive", ja: "アーカイブ" },
	"projects.unarchive": { en: "Unarchive", ja: "アーカイブ解除" },
	"projects.rename": { en: "Rename", ja: "名前変更" },
	"projects.lastSeen": { en: "Last seen", ja: "最終アクセス" },
	"projects.missing": { en: "Missing", ja: "不明" },
	"projects.archived": { en: "Archived", ja: "アーカイブ済み" },
	"projects.noProjects": { en: "No projects registered yet. Use alfred in a project directory to register it.", ja: "まだプロジェクトが登録されていません。プロジェクトディレクトリで alfred を使用すると自動登録されます。" },
	"projects.save": { en: "Save", ja: "保存" },
	"search.untitled": { en: "Untitled", ja: "無題" },
	"nav.projects": { en: "Projects", ja: "プロジェクト" },

	// Filters
	"filter.all": { en: "All", ja: "全て" },
	"filter.active": { en: "Active", ja: "アクティブ" },
	"filter.review": { en: "Review", ja: "レビュー" },
	"filter.done": { en: "Done", ja: "完了" },

	// Knowledge tags & promotion
	"knowledge.tags": { en: "Tags", ja: "タグ" },
	"knowledge.promote": { en: "Promote to Rule", ja: "ルールに昇格" },
	"knowledge.promoteTitle": { en: "Promote to Rule?", ja: "ルールに昇格しますか？" },
	"knowledge.promoteDescription": { en: "This pattern will be promoted to a rule.", ja: "このパターンをルールに昇格します。" },
	"knowledge.promoted": { en: "Promoted", ja: "昇格済" },
	"knowledge.candidates": { en: "Promotion Candidates", ja: "昇格候補" },

	// Spec history
	"review.noHistory": { en: "No version history", ja: "バージョン履歴なし" },
	"review.oldVersion": { en: "Old", ja: "旧" },
	"review.newVersion": { en: "New", ja: "新" },
	"review.currentVersion": { en: "Current", ja: "現在" },
	"review.loadingVersions": { en: "Loading versions...", ja: "バージョン読み込み中..." },

	// Graph controls
	"knowledge.zoomIn": { en: "Zoom in", ja: "拡大" },
	"knowledge.zoomOut": { en: "Zoom out", ja: "縮小" },
	"knowledge.zoomReset": { en: "Fit all", ja: "全体表示" },

	// Keyboard shortcuts
	"shortcuts.title": { en: "Keyboard Shortcuts", ja: "キーボードショートカット" },
	"shortcuts.nextTask": { en: "Next task", ja: "次のタスク" },
	"shortcuts.prevTask": { en: "Previous task", ja: "前のタスク" },
	"shortcuts.toggleExpand": { en: "Toggle expand", ja: "展開/折りたたみ" },
	"shortcuts.help": { en: "Show shortcuts", ja: "ショートカット表示" },

	// Epic dependencies

	// Activity export & date range
	"activity.exportCsv": { en: "Export CSV", ja: "CSV エクスポート" },
	"activity.fromDate": { en: "From", ja: "開始日" },
	"activity.toDate": { en: "To", ja: "終了日" },

	// Traceability & coverage
	"task.traceability": { en: "Traceability", ja: "トレーサビリティ" },
	"task.traceabilityHint1": { en: "Maps each requirement (FR) to its implementation task (T-N.N) and test case (TS-N.N).", ja: "各要件(FR)を実装タスク(T-N.N)とテストケース(TS-N.N)に紐づけます。" },
	"task.traceabilityHint2": { en: "Gaps indicate untested or unimplemented requirements.", ja: "空欄は未実装・未テストの要件を示します。" },
	"task.coverage": { en: "Coverage", ja: "カバレッジ" },
	"task.requirement": { en: "Requirement", ja: "要件" },
	"task.taskId": { en: "Task", ja: "タスク" },
	"task.testId": { en: "Test", ja: "テスト" },

	// Butler empty states
	"empty.noTasks": { en: "Nothing requiring your attention at the moment, sir.", ja: "ただいま、ご用件はございません。" },
	"empty.noSpecs": { en: "No specifications on file, sir. Shall I prepare one?", ja: "仕様書はございません。ご用意いたしましょうか？" },
	"empty.noMemories": { en: "The archives are empty, sir.\nKnowledge awaits discovery.", ja: "記録はございません。\n知見の蓄積をお待ちしております。" },
	"empty.noResults": { en: "I've searched thoroughly, sir. Nothing matches your inquiry.", ja: "くまなく探しましたが、該当するものが見つかりません。" },
	"empty.noActivity": { en: "All quiet on the front, sir. No recent activity to report.", ja: "静かな時でございます。直近の活動はございません。" },
	"empty.error": { en: "My apologies, sir. Something has gone awry.", ja: "申し訳ございません。不具合が生じております。" },

	// Team sharing (v0.5)
	"team.author": { en: "Author", ja: "作成者" },
	"team.owner": { en: "Owner", ja: "担当者" },
	"team.reviewer": { en: "Reviewer", ja: "レビュアー" },
	"team.allOwners": { en: "All Owners", ja: "全担当者" },
	"team.allActors": { en: "All Members", ja: "全メンバー" },
	"team.filterByOwner": { en: "Filter by owner", ja: "担当者で絞り込み" },
	"team.filterByActor": { en: "Filter by member", ja: "メンバーで絞り込み" },
	"team.conflictAlerts": { en: "Conflict Alerts", ja: "矛盾アラート" },
	"team.noConflicts": { en: "No contradictions detected at this time, sir.", ja: "現在、矛盾は検出されておりません。" },
	"team.similarSpecs": { en: "Similar Specs", ja: "類似スペック" },
	"team.noSimilarSpecs": { en: "No similar specifications found, sir.", ja: "類似する仕様は見つかりませんでした。" },
	"team.activityAnalytics": { en: "Analytics", ja: "分析" },
	"team.hitRanking": { en: "Most Accessed Knowledge", ja: "アクセス上位ナレッジ" },
	"team.completionTime": { en: "Completion Time by Size", ja: "サイズ別完了時間" },
	"team.knowledgeExport": { en: "Export", ja: "エクスポート" },
	"team.knowledgeImport": { en: "Import", ja: "インポート" },
	// Activity tab
	"nav.activity": { en: "Activity", ja: "アクティビティ" },
	"activity.title": { en: "Activity", ja: "アクティビティ" },
	"activity.avgCycleTime": { en: "Avg Cycle Time", ja: "平均サイクルタイム" },
	"activity.avgReworkRate": { en: "Avg Rework Rate", ja: "平均手戻り率" },
	"activity.totalSpecs": { en: "Completed Specs", ja: "完了スペック" },
	"activity.days": { en: "days", ja: "日" },
	"activity.rework.title": { en: "Rework Rate by Spec", ja: "スペック別手戻り率" },
	"activity.rework.pending": { en: "Pending (< 21 days)", ja: "確定前（21日未経過）" },
	"activity.rework.rate": { en: "Rework Rate", ja: "手戻り率" },
	"activity.cycleTime.title": { en: "Cycle Time Breakdown", ja: "サイクルタイム内訳" },
	"activity.cycleTime.planning": { en: "Planning", ja: "計画" },
	"activity.cycleTime.approval": { en: "Approval", ja: "承認待ち" },
	"activity.cycleTime.implementation": { en: "Implementation", ja: "実装" },
	"activity.log.title": { en: "Audit Log", ja: "監査ログ" },
	"activity.log.event": { en: "Event", ja: "イベント" },
	"activity.log.slug": { en: "Spec", ja: "スペック" },
	"activity.log.actor": { en: "Actor", ja: "実行者" },
	"activity.log.detail": { en: "Detail", ja: "詳細" },
	"activity.log.time": { en: "Time", ja: "日時" },
	"activity.empty.title": { en: "No activity recorded yet, sir.", ja: "まだアクティビティはございません。" },
	"activity.empty.description": { en: "Complete a spec to see metrics here.", ja: "スペックを完了すると、ここにメトリクスが表示されます。" },
	"activity.noMetrics": { en: "Complete a spec to unlock metrics.", ja: "スペックを完了するとメトリクスが表示されます。" },
	"activity.log.prev": { en: "Prev", ja: "前へ" },
	"activity.log.next": { en: "Next", ja: "次へ" },
	"activity.log.entries": { en: "entries", ja: "件" },
	// Knowledge lifecycle
	"knowledge.verification.verified": { en: "Verified", ja: "検証済" },
	"knowledge.verification.overdue": { en: "Overdue", ja: "期限切れ" },
	"knowledge.verification.pending": { en: "Pending", ja: "未検証" },
	"knowledge.gaps.title": { en: "Knowledge Gaps", ja: "ナレッジギャップ" },
	"knowledge.gaps.empty": { en: "No knowledge gaps detected, sir.", ja: "ナレッジギャップは検出されておりません。" },
	"knowledge.gaps.query": { en: "Query", ja: "クエリ" },
	"knowledge.gaps.score": { en: "Score", ja: "スコア" },
	"knowledge.sort.verificationDue": { en: "Verification Due", ja: "検証期限順" },
	// Briefing
	"briefing.greeting": { en: "Hello.", ja: "こんにちは。" },
	"briefing.waveProgress": { en: "Working on {slug} — Wave {current}/{total}, {remaining} tasks remaining.", ja: "{slug} を進行中 — Wave {current}/{total}、残り {remaining} タスク。" },
	"briefing.multiSpec": { en: "{count} active specs in progress.", ja: "{count} 件のスペックが進行中。" },
	"briefing.completedToday": { en: "{count} spec(s) completed today.", ja: "本日 {count} 件のスペックが完了。" },
	"briefing.overdueKnowledge": { en: "{count} knowledge entries overdue for verification.", ja: "{count} 件のナレッジが検証期限超過。" },
	"briefing.noTasks": { en: "No active specs.", ja: "アクティブなスペックはありません。" },
	"briefing.knowledgeTotal": { en: "Knowledge base: {total} entries.", ja: "ナレッジベース: {total} 件。" },

	// View Switcher
	"view.list": { en: "List", ja: "リスト" },
	"view.card": { en: "Card", ja: "カード" },

	// Drawer
	"drawer.metadata": { en: "Metadata", ja: "メタデータ" },
	"drawer.tags": { en: "Tags", ja: "タグ" },
	"drawer.relatedSpec": { en: "Related Spec", ja: "関連スペック" },
	"drawer.eventDetail": { en: "Event Detail", ja: "イベント詳細" },

	// Heatmap
	"heatmap.title": { en: "Activity Heatmap", ja: "アクティビティ・ヒートマップ" },
	"heatmap.tooltip": { en: "{date}: {count} events", ja: "{date}: {count} イベント" },
	"heatmap.less": { en: "Less", ja: "少" },
	"heatmap.more": { en: "More", ja: "多" },

	// Toast messages
	"toast.approved": { en: "Approved", ja: "承認しました" },
	"toast.approved.desc": { en: "Go back to Claude Code to start implementation.", ja: "Claude Code に戻って実装を開始してください。" },
	"toast.changesRequested": { en: "Changes requested", ja: "修正を依頼しました" },
	"toast.changesRequested.desc": { en: "comments sent. Tell Claude Code: \"Address the review comments\".", ja: "件のコメントを送信しました。Claude Code で「レビューコメントに対応して」と伝えてください。" },
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
