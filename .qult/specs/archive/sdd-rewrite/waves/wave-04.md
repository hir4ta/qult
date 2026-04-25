# Wave 4: Agents and spec lifecycle skills

**Goal**: spec 策定・実装フェーズの新 agent 3 体（spec-generator / spec-clarifier / spec-evaluator）と新 skill 5 つ（/qult:spec / /qult:clarify / /qult:wave-start / /qult:wave-complete / /qult:wip）を追加し、旧 plan-generator / plan-evaluator 系を削除する。
**Verify**: `bun run typecheck && bun run lint && bun run test && bun run build` 全 pass。新 skill 5 つが `plugin/skills/` に存在し、旧 `/qult:plan-generator` skill ディレクトリは削除されている。新 agent 3 体が `plugin/agents/` に存在し、旧 plan-* agent は削除されている。
**Started at**: 2026-04-25T15:19:00Z
**Completed at**: 2026-04-25T15:22:00Z
**Scaffold**: false

## Commits

- 7a9acc8: [wave-04] feat: replace plan-generator/plan-evaluator with spec-generator/clarifier/evaluator agents
- 09dd871: [wave-04] feat: add 5 spec lifecycle skills (spec/clarify/wave-start/wave-complete/wip), remove plan-generator skill

**Range**: 7a9acc8..09dd871

## Notes

- spec-generator は phase ∈ {requirements, design, tasks} の XML タグ区切りで instruction bleed を防ぐ
- spec-clarifier は generate / apply 両モード、5-10 問、選択肢+推奨、日本語+英語の「お任せ」検知パターン
- spec-evaluator は phase 別 threshold (18/17/16) と 4 dimension scoring、temperature=0、threshold ± 1 retry
- /qult:wave-complete は 7 stage（pre-flight → range integrity → test → detector → commit msg → commit → finalize → preview）
- quality-guardian agent の plan 言及を sed で spec に置換
- 既存 reviewer agent (spec/quality/security/adversarial) には plan 言及なし、変更不要
- skill 数: 11 → 15、agent 数: 7 → 8 (quality-guardian + 4 reviewer + 3 spec)
- 全 build / lint / 383 test pass を維持
