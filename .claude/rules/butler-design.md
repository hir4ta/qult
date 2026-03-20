---
paths:
  - "web/**"
---

# Alfred Butler Design System

Nova Style を廃止。alfred 独自のデザインシステム "Butler Design" を定義する。
テーマは **"執事の書斎"** — 温かく上品で、機械的な完璧さより手仕事の質感を重視する。

## 1. Icons — Animated Color Icons

- **全アイコンを `@animated-color-icons/lucide-react` から import**（`lucide-react` は使わない）
- ホバーでアニメーションする CSS-only アイコン
- 親要素に `al-icon-wrapper` クラスを付与してホバー範囲を拡張
- two-tone: `primaryColor` / `secondaryColor` で brand color を適用
- `lucide-react` からの移行: import ソースを変えるだけ（API 互換）

## 2. Grain Texture — 書斎の質感

- ダッシュボード背景に SVG `feTurbulence` ベースのグレインテクスチャを重ねる
- opacity: 0.03（ライトモード）/ 0.04（ダークモード）
- `mix-blend-mode: overlay` + `pointer-events: none`
- globals.css に `.grain-overlay` クラスとして定義、`__root.tsx` の body 相当に適用

## 3. Spring Animation — Motion for React

- `motion` (旧 Framer Motion) を使用
- **執事の動き = 高 damping、控えめ**: `{ damping: 25, stiffness: 200 }` をデフォルト spring に
- bouncy / playful なモーション禁止（低 damping、overshoot 禁止）
- 適用箇所:
  - カード stagger reveal: タブ切替時に `staggerChildren: 0.04` で一枚ずつ現れる
  - 数値カウンター: 統計値が spring でカウントアップ（`motion.span` + `useMotionValue`）
  - `AnimatePresence`: ページ・カード退場時のフェードアウト
  - Wave 進捗バー: spring で自然に止まる
- `transition-colors` / `transition-all` は motion に置き換え（CSS transition は icon hover 等の軽量用途のみ残す）

## 4. Empty States — 執事キャラクター

- 空状態にはカスタム SVG イラスト + 執事口調のコピーを表示
- イラスト一覧:
  - タスクなし: 空のシルバートレイを持つ執事
  - 検索ヒットなし: モノクルで覗く執事
  - Spec 完了: 軽くお辞儀する執事
  - エラー: 眉をひそめる執事
  - Knowledge 空: 本棚の前に立つ執事
- コピー例 (i18n):
  - EN: "Nothing requiring your attention at the moment, sir."
  - JA: "ただいま、ご用件はございません。"
- SVG ファイルは `web/src/assets/butler/` に配置
- サイズ: 最大 200x160px、モノクロ or brand-dark 1色

## 5. Organic Border Radius — 不完全さの美

- カード: `border-radius: 12px 16px 14px 18px`（微妙に不均一）
- ボタン / 入力: `rounded-lg` のまま（操作性を維持）
- Tailwind カスタムクラス: `rounded-organic` を globals.css に定義

## 6. Neo-Brutalist Accents — 封蝋の重み

- CTA ボタン（Complete, Approve 等）に flat offset shadow: `shadow-[3px_3px_0_var(--color-brand-dark)]`
- アクティブカード（現在の Wave）にも同様の flat shadow
- 通常のカード / 入力 / タブには shadow 禁止（従来通り）
- offset shadow は `hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-[2px_2px_0_var(--color-brand-dark)]` で押し込み効果

## 7. Generative SVG Dividers — セクション区切り

- `<hr>` や `border-bottom` の代わりに SVG 波形区切り線を使用
- セッション（ページロード）ごとにシード値を変え、微妙に異なるパターンを生成
- コンポーネント: `web/src/components/wave-divider.tsx`
- 高さ: 8-12px、opacity: 0.15、brand color

## 8. Color Storytelling — 色で語る

- **Tab ambient tint**: アクティブタブの brand color が背景に 3% opacity でにじむ
- **Wave 色相シフト**: 進捗に応じて cool blue (#3b82f6) → warm amber (#f59e0b) → green (#22c55e)
- **Archived/disabled**: 彩度 50% 減 + opacity 0.6
- `SUB_TYPE_COLORS` は従来の brand palette を維持

## 9. Signature Visualization — Wave Timeline

- 現在のステップ UI を Canvas/SVG カスタム描画に置き換え
- 曲線コネクタ（直線ではなく bezier curve）
- 有機的なノード形状（完全な円ではなく、微妙に揺らいだ shape）
- 手書き風ライン（SVG stroke-dasharray による表現）
- alfred のシグネチャ・ビジュアルとして位置づけ

## 10. Butler Identity — 全体を貫くメタファー

- **色温度**: 暖色寄り。背景は純白 (#fff) ではなくアイボリー寄り (#faf9f7 light / #1c1917 dark)
- **モーション**: 上品で控えめ。高 damping の spring。急な動きや bounce 禁止
- **コピー**: 空状態やツールチップに執事口調の人格を持たせる
- **Progressive disclosure**: 情報を一度に全部見せず、必要な時に差し出す
- **フォント運用**:
  - Display (Quicksand) はページヘッダーに大胆に使用（text-2xl 以上）
  - ID・スラッグ (`T-1.3`, `FR-5`) にはモノスペース (Tailwind font-mono (system monospace))
  - 本文 (Nunito) はそのまま維持

## Rules (Do / Don't)

### DO
- `@animated-color-icons/lucide-react` から全アイコンを import する
- カードに `rounded-organic` を使う
- 空状態に執事 SVG イラスト + i18n コピーを表示する
- spring アニメーションに高 damping (`damping >= 20`) を使う
- CTA ボタンに flat offset shadow を付ける
- section 区切りに wave-divider コンポーネントを使う

### DON'T
- `lucide-react` から直接 import しない
- `shadow-xs`, `shadow-sm`, `shadow-md` を通常のカード / ボタンに使わない
- bouncy / playful なアニメーション（`damping < 15`, spring overshoot）を使わない
- `transition-all` を使わない
- 純白 (#ffffff) を背景色に使わない（アイボリー系を使う）
- 空状態を "No data" 等の無機質なテキストだけで済ませない
