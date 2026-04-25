# Wave 6: Documentation, version bump, integration verification

**Goal**: CLAUDE.md / README / docs/ をすべて SDD アーキテクチャに合わせて更新、plugin manifest を v1.0.0 に bump、最終 e2e 確認。
**Verify**: `bun run typecheck && bun run lint && bun run test && bun run build` 全 pass。CLAUDE.md / README.md / README.ja.md / docs/assumptions.md が SDD 用語で再構成済み。`plugin/.claude-plugin/plugin.json` と `.claude-plugin/marketplace.json` が v1.0.0。
**Started at**: 2026-04-25T15:31:00Z
**Completed at**: 2026-04-25T15:38:00Z
**Scaffold**: false

## Commits

- 2057a4b: [wave-06] docs: rewrite CLAUDE.md / README / assumptions, bump plugin to v1.0.0

**Range**: 2057a4b..2057a4b

## Notes

- **CLAUDE.md** 全面書換: Spec-Driven Development 中心の構成に再編、`.qult/` ディレクトリ規約 / file-based state / 8 agent ロスター / Tier 1 detector / config 階層 / Phase Gate を SDD 文脈で記述。`bun:sqlite` 言及を全削除、`getDb` / DB API への参照を排除。
- **README.md / README.ja.md** 全面書換: SDD ライフサイクル 30 秒の例を追加、コマンド表に新 5 skill を反映、レビュアーモデル表に spec-* agent を追加、限界セクションに「Wave 単位の自動 review 無し」「単一 architect 前提」「Claude Code 専用」を明記。
- **docs/assumptions.md** 全面書換: hook 前提のセクション群を削除し、State レイヤー（atomic write / project-local / commit/gitignore 戦略 / 単一 architect）、SDD パイプライン（必須 clarify / spec-evaluator 4 次元 / temperature=0 retry）、Wave / commit 紐付け（range binding / `[wave-NN]` prefix / Range 整合性検証）、Reviewer / Detector（独立 review / threshold 30 / 最大 3 iter / severity block）、Review Requirement に再構成。Calibration Rationale を `spec_eval.thresholds` に対応。
- **docs/qult-cloud-plan.md** に冒頭 status note 追加: 本ドキュメントは v0.x 時代に書かれた未着手の構想であり、cloud 作業着手時は v1.0 base で改訂が必要、と明記。中身は触らず（未来の作業範囲）。
- **docs/research-sdd-vs-harness-2026.md / evaluation-framework.md / research-harness-engineering-2026.md / references.md** は v1.0 と整合（grep で plan-* / SQLite 等の qult 内部参照なし、研究文献としての価値はそのまま）。
- **.claude/skills/release/SKILL.md** から `bun:sqlite` 言及を削除（runtime 注釈として残っていた）。
- **plugin/.claude-plugin/plugin.json** と **.claude-plugin/marketplace.json** を v1.0.0 に bump、description に "Spec-Driven Development" を反映。

## Verification

- `bun run typecheck` ✅
- `bun run lint` ✅
- `bun run test` ✅ (383 tests)
- `bun run build` ✅ (`plugin/dist/mcp-server.mjs` 再生成)
