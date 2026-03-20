# Design Review Checklist

Profile: `design`
Trigger: web/ changes (*.tsx, *.css, *.ts in web/)

Before evaluating, call `knowledge` with: "butler design system animated icons grain texture spring animation"

## Icons

| # | Check | Severity | What to look for |
|---|---|---|---|
| I1 | Animated icons only | HIGH | Imports from `lucide-react` instead of `@animated-color-icons/lucide-react` |
| I2 | Wrapper class present | MEDIUM | Icon parent missing `al-icon-wrapper` class (hover animation won't trigger) |
| I3 | Brand color applied | LOW | Icons using `currentColor` where brand two-tone (`primaryColor`/`secondaryColor`) is more appropriate |

## Grain & Texture

| # | Check | Severity | What to look for |
|---|---|---|---|
| G1 | Grain overlay present | HIGH | Root layout missing `.grain-overlay` class |
| G2 | Background color warmth | MEDIUM | Pure white `#ffffff` / `#fff` used as background instead of ivory (`#faf9f7` light / `#1c1917` dark) |
| G3 | Grain opacity range | LOW | Grain opacity outside 0.02-0.05 range (too subtle or too noisy) |

## Animation

| # | Check | Severity | What to look for |
|---|---|---|---|
| A1 | Motion library usage | HIGH | New animated components using CSS `transition-all` instead of `motion` |
| A2 | Spring damping | HIGH | Spring config with `damping < 15` (too bouncy for butler identity) |
| A3 | Stagger reveal | MEDIUM | List/grid of cards appearing without stagger animation (`staggerChildren`) |
| A4 | AnimatePresence | MEDIUM | Components mounting/unmounting without exit animation |
| A5 | Counter animation | LOW | Stat numbers changing without spring-based count-up |

## Empty States

| # | Check | Severity | What to look for |
|---|---|---|---|
| ES1 | Butler illustration | HIGH | Empty state showing generic "No data" text without butler SVG illustration |
| ES2 | Butler copy tone | MEDIUM | Empty state text lacking butler personality (should be formal/polite) |
| ES3 | i18n coverage | MEDIUM | Empty state text hardcoded in one language (must have EN + JA) |

## Visual Identity

| # | Check | Severity | What to look for |
|---|---|---|---|
| V1 | Organic border radius | MEDIUM | Cards using uniform `rounded-xl` instead of `rounded-organic` |
| V2 | CTA flat shadow | MEDIUM | Primary action buttons (Complete, Approve) missing flat offset shadow |
| V3 | Shadow policy | HIGH | Cards/buttons/inputs using `shadow-xs`, `shadow-sm`, `shadow-md` (forbidden) |
| V4 | Section dividers | LOW | Sections separated by `<hr>` or `border-bottom` instead of wave-divider |
| V5 | Display font sizing | LOW | Page headers not using Quicksand at text-2xl or above for dramatic hierarchy |
| V6 | Monospace IDs | LOW | Task/FR IDs (`T-1.3`, `FR-5`) not using monospace font |

## Color

| # | Check | Severity | What to look for |
|---|---|---|---|
| C1 | Tab ambient tint | LOW | Active tab not bleeding brand color into page background |
| C2 | Archived desaturation | MEDIUM | Disabled/archived items at full saturation instead of 50% reduced |
| C3 | Wave color progression | LOW | Wave progress not shifting hue (blue → amber → green) |
| C4 | Brand palette | HIGH | New colors introduced outside the established brand palette without justification |
