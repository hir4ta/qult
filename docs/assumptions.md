# Load-Bearing Assumptions

qult の各コンポーネントが依存する仮定と、仮定が崩れた場合の対処を記録する。

> "every component in a harness encodes an assumption about what the model can't do on its own, and those assumptions are worth stress testing."
> -- Anthropic, Harness Design for Long-Running Apps (2026-03-24)

## ストレステスト方針

モデルのメジャーアップデート時（Opus 5.0 等）に以下を検証する:

1. 各仮定について「モデル単体でこれを守れるか？」をテスト
2. 守れるなら該当コンポーネントを削除候補にする
3. 守れないなら仮定は維持。このドキュメントを更新する

前回のストレステスト: v0.14.0 (2026-03-27) -- 19機能削除、5 hooks + 8 state fields に簡素化。

## Hook レイヤー

### Plugin hooks の信頼性

**仮定**: plugin/hooks/hooks.json だけでは hooks が発火しない環境がある。

**根拠**: VS Code 拡張で plugin hooks が発火しない (#18547)、plugin hooks がマッチするが実行されない (#10225)。2026-03 時点で未解決。

**対策**: `/qult:register-hooks` で `.claude/settings.local.json` にフォールバック登録できるようにした。plugin hooks と settings hooks が両方存在する場合、同一コマンドは重複排除される。

**崩れたら**: Claude Code 側で plugin hooks の信頼性が修正されれば、register-hooks スキルは不要になる。ただし害はないので残しても良い。

**検証方法**: #18547, #10225 の issue ステータスを定期的に確認。resolved になったら、plugin hooks のみで 5 セッション実行し、全 hooks が発火することを確認。

### PostToolUse: Edit/Write 後の lint/typecheck 実行

**仮定**: Claude は Edit 後に自発的に lint/typecheck を実行しない。実行しても結果を見て修正するとは限らない。

**根拠**: SWE-bench 観察。Claude はテスト実行は比較的するが、lint は指示がない限り省略する傾向がある。

**崩れたら**: on_write ゲートを advisory に格下げ（respond のみ、pending-fixes なし）。

**検証方法**: 10 回の Edit セッションで、qult なしで lint エラーを自発修正する割合を計測。80% 超なら仮定は崩れている。

### PreToolUse: pending-fixes があるファイル以外への Edit をブロック

**仮定**: Claude は lint エラーを放置したまま別ファイルの編集に移る。

**根拠**: 実運用で頻繁に観察。PostToolUse の advisory context (respond) だけでは 50% 以上の確率で無視される。

**崩れたら**: DENY を削除し、respond のみに戻す。PreToolUse hook を advisory に変更。

**検証方法**: respond のみ（DENY なし）で 10 セッション実行。lint エラー放置率を計測。20% 以下なら仮定は崩れている。

### Stop: pending-fixes/incomplete plan/no review でブロック

**仮定**: Claude は lint エラーが残っていても、プランが未完了でも、レビューなしでも停止しようとする。

**根拠**: 長いタスクの終盤で「context anxiety」が発生し、品質チェックをスキップして早期完了を試みる。

**崩れたら**: Stop hook を削除。advisory（respond）に格下げ。

**検証方法**: Stop hook を advisory 化して 5 セッション実行。未完了のまま停止する割合を計測。

### SubagentStop: reviewer 出力の構造検証 + スコア閾値

**仮定**: qult-reviewer は PASS/FAIL verdict やスコアを出力せずに終了することがある。低スコアでも PASS を出す。

**根拠**: LLM の「confident leniency」。評価者も出力フォーマットを省略することがある。

**崩れたら**: 構造検証のみ削除（スコア閾値は残す）。出力フォーマットが 95% 以上正しいなら構造検証は不要。

**検証方法**: SubagentStop の構造検証なしで 10 レビューを実行。不正フォーマット率を計測。

### SessionStart: ゲート未設定時のプロンプト

**仮定**: ユーザーはゲート設定を忘れる。

**根拠**: init 直後は gates.json が空。ユーザーが detect-gates を手動実行する必要がある。

**崩れたら**: init 時にゲートを自動検出する（session-start のプロンプト不要）。

**検証方法**: init で自動検出が安定すれば、session-start のプロンプトは削除。

## State レイヤー

### Atomic write (write-to-temp + rename)

**仮定**: hook プロセスが中断されるとファイルが破損する。

**根拠**: POSIX rename の原子性。hook は timeout 付きで実行され、タイムアウトで SIGTERM される。writeFileSync 途中での kill はファイル破損を引き起こす。

**崩れたら**: この仮定は OS レベルなのでモデル進化では崩れない。削除不可。

### Session-scoped state files

**仮定**: 複数の Claude Code セッションが同じプロジェクトで同時に実行される。

**根拠**: IDE の複数タブ、ターミナルの複数ウィンドウ。

**崩れたら**: session scope を削除し、単一ファイルに戻す。並行セッションが実運用でない場合はオーバーヘッド。

**検証方法**: registry.json の同時接続パターンを分析。

### Process-scoped cache + dirty flag

**仮定**: 1 hook 実行中に状態ファイルを複数回読み書きするが、ディスク I/O は 1 回で済ませたい。

**根拠**: PostToolUse は readPendingFixes → writePendingFixes + recordChangedFile と複数の状態操作を行う。毎回ディスクに書くと 3-5ms のレイテンシが追加される。

**崩れたら**: hook のレイテンシ要件が緩和されれば、キャッシュなしの直接 I/O に戻す。

## Gate レイヤー

### on_write / on_commit / on_review の3段ゲート

**仮定**: 品質チェックは「編集時」「コミット時」「レビュー時」の3段階で実行すべき。lint は即時、テストはコミット前、E2E はレビュー時。

**根拠**: lint は高速 (< 1s) なので毎回実行可能。テストは数秒かかるので毎回は非効率。E2E は数分かかるのでレビュー時のみ。

**崩れたら**: テストが十分高速 (< 1s) なら on_write に統合。E2E が十分高速なら on_commit に統合。

### run_once_per_batch

**仮定**: typecheck はプロジェクト全体を検査するので、1 ファイル編集ごとに実行する必要がない。

**根拠**: tsc --noEmit は 1-5s かかる。10 ファイル編集で 10 回実行すると 10-50s の遅延。

**崩れたら**: typecheck が十分高速 (< 500ms) になれば、run_once_per_batch を削除。

## Evaluator レイヤー

### 独立 reviewer エージェント

**仮定**: Claude は自分の書いたコードを客観的に評価できない（confident leniency）。

**根拠**: Anthropic の記事が明示的に述べている。自己評価は一貫して甘い。

**崩れたら**: この仮定がモデル進化で崩れる可能性は低い。自己評価バイアスは訓練データレベルの問題。ただし将来のモデルで self-critique 能力が劇的に向上すれば、独立 reviewer を self-review に置き換え可能。

**検証方法**: 同じ diff に対して self-review と独立 review のスコアを比較。差が 1 点以内なら仮定は崩れている。

### スコア閾値 12/15

**仮定**: aggregate 12 未満のコードは改善の余地がある。

**根拠**: 3 次元全て 4/5 = 12。「各次元で minor issues あり」が最低合格ライン。

**崩れたら**: 実運用でスコア分布を計測し、閾値を調整。全レビューが 13+ なら閾値を上げる。全レビューが 9-11 で停滞するなら閾値を下げる。

### 最大 3 イテレーション

**仮定**: 3 回の修正ループで改善が頭打ちになる。

**根拠**: Self-Refine 研究: 「3 回以上の反復は収穫逓減」。

**崩れたら**: 実運用で 3 回目のイテレーションでのスコア改善幅を計測。改善なしが 80% 超なら 2 回に減らす。

## Review Requirement

### 5 ファイル閾値

**仮定**: 5 ファイル以上のゲート対象変更は十分に大きく、独立レビューの価値がある。

**根拠**: 経験的な閾値。厳密な根拠はない。

**崩れたら**: 実運用でレビューが価値を生む変更サイズの分布を計測。閾値を調整。

**注意**: この閾値は最も仮定が弱い。運用データ収集を優先すべき。
