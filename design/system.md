# Gentle Dot design system
Synced from `packages/ui/src/styles.css:1-36`; no application source changed. Values below are existing tokens, not a proposed rebrand.

## Colors
| Token | Value | Usage |
| --- | --- | --- |
| `--bg` | `#1a1218` | Page |
| `--bg-glass` | `rgba(26, 18, 24, 0.82)` | Translucent background |
| `--surface` | `#20161e` | Panel |
| `--surface-2` | `#241822` | Hover surface |
| `--line` | `#342230` | Separator |
| `--text` | `#f6eff3` | Primary text |
| `--muted` | `#a78e9b` | Supporting text |
| `--accent` | `#f095c8` | Primary action/brand |
| `--accent-ink` | `#1a1218` | Text on accent |
| `--accent-soft` | `rgba(240, 149, 200, 0.12)` | Accent surface |
| `--accent-line` | `rgba(240, 149, 200, 0.35)` | Accent outline |
| `--scrim` | `rgba(14, 10, 13, 0.45)` | Overlay |
| `--green` | `#b4e7c7` | Success |
| `--red` | `#ff718f` | Error |
| `--yellow` | `#e0c27a` | Warning |
| `--amber` | `#f5a524` | Dot indicator |

## Type
| Token | Value | Usage |
| --- | --- | --- |
| `--font-text` | `Inter, "SF Pro Text", system-ui, -apple-system, "Segoe UI", sans-serif` | System/local text stack; never fetch fonts |
| `--font-mono` | `"IosevkaTerm NF", "Iosevka Term", "JetBrains Mono", "SF Mono", ui-monospace, Menlo, monospace` | System/local metadata stack |

Source base type is14px/20px. Composition can scale relative text for page hierarchy; that is layout, not an additional claimed brand token.

## Shape and layout
| Token | Value | Usage |
| --- | --- | --- |
| `--radius-sm` | `8px` | Inputs/buttons |
| `--radius-md` | `12px` | Compact panels |
| `--radius-lg` | `16px` | Panels |
| `--radius-pill` | `999px` | Status pill |
| `--radius` | `20px` | Main panel |
| `--reading-width` | `780px` | Reading measure |
| `--ease` | `cubic-bezier(0.2, 0.8, 0.2, 1)` | Transition |
| `--accent-shadow` | `0 10px 30px rgba(240, 149, 200, 0.3)` | Accent elevation |
| `--shadow-elevated` | `0 18px 44px rgba(0, 0, 0, 0.55)` | Raised surface |

Source buttons use7px14px padding; application spacing is component-specific, not an invented global spacing scale. Web controls use larger accessible hit areas. Prefer one meaningful download panel, source separators and source radii; text on accent uses accent-ink, never white. Preserve visible focus, reduced-motion behavior, native labeled controls, honest unavailable/loading/error states and no external assets in artboards.
