---
paths:
  - "web/**"
---

# Frontend Development Rules

## Stack

- React 19 + TypeScript + Vite 8
- TanStack Router (file-based routing in `web/src/routes/`)
- TanStack Query (server state, SSE invalidation)
- shadcn/ui (Radix UI primitives) + Tailwind CSS v4
- Biome for linting/formatting (not ESLint/Prettier)

## Design System — Nova Style

Components follow shadcn Nova style (compact, flat, dashboard-optimized):

- **No shadows** on cards, buttons, inputs, toggles, tabs. Only floating elements (tooltip, dialog overlay) use `shadow-lg`
- **`rounded-lg`** for primary interactive elements (buttons, inputs, toggles, tabs). Cards use `rounded-xl`
- **Compact heights**: button default `h-8`, input `h-8`, tabs list `h-8` (not h-9)
- **Compact padding**: card `py-4 px-4`, dialog `p-4` (not py-6/px-6/p-6)
- **`transition-colors`** instead of `transition-all` or `transition-[color,box-shadow]`
- **Hover**: use `hover:-translate-y-0.5` + border color change for cards, never `hover:shadow-*`
- **Progress bar**: `h-1` (thin)

## Colors

- OKLCH color space for theme variables (globals.css)
- Brand colors defined as `--color-brand-*` in `@theme inline` block
- Brand palette (DEC-15): session `#40513b`, decision `#628141`, pattern `#2d8b7a`, rule `#e67e22`, error `#c0392b`, purple `#7b6b8d`
- Use semantic tokens (`bg-card`, `text-foreground`, `border-border`) over raw colors
- Brand colors applied via inline `style={{ color: "#2d8b7a" }}` for knowledge sub-types

## Typography

- Display font: Quicksand (`var(--font-display)`)
- Body font: Nunito (`var(--font-sans)`)
- Dialog/alert titles: `text-base` (not `text-lg`)
- Use `text-[10px]`, `text-[11px]` for metadata/labels

## Component Patterns

- shadcn components live in `web/src/components/ui/` — edit directly, do not re-wrap
- Custom components in `web/src/components/` (section-card, diff-viewer, review panel)
- Data fetching: TanStack Query hooks in `web/src/lib/api.ts` with `queryOptions()` pattern
- Stale times: 5s for live data (tasks, knowledge), 60s for reference data (specs, health)
- SSE via `web/src/lib/sse.ts` → `queryClient.invalidateQueries()` on events
- i18n: `useI18n()` hook with `t("key")` pattern. 70+ keys in `web/src/lib/i18n.tsx`. Always add both EN and JA

## File Structure

```
web/src/
  routes/         # TanStack Router pages (file-based, auto-generated routeTree)
  components/     # Custom + shadcn/ui components
  lib/            # api.ts, types.ts, i18n.tsx, sse.ts, format.ts, utils.ts
  styles/         # globals.css (Tailwind theme + brand palette)
```

## Rules

- Do NOT add `shadow-xs`, `shadow-sm`, or `shadow-md` to any component
- Do NOT use `transition-all` for hover effects — specify exact properties
- Do NOT add new shadcn components without checking if an existing one covers the use case
- Do NOT hardcode English strings — use i18n keys with both EN and JA translations
- Route files should not exceed ~400 lines. Extract components when growing
- Mutations must invalidate relevant queries via `queryClient.invalidateQueries()`
- API types in `web/src/lib/types.ts` must stay in sync with `src/api/server.ts` responses
