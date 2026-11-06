# Gentle Dot · installer design system

Synced from `packages/ui/src/styles.css` and `scripts/installer/page.css`.
Scope: native-installer concepts only; not an exhaustive app catalogue or a proposed starter system. The installer page's flat dark surfaces take precedence over decorative app effects. Layout dimensions are composition choices, not new project tokens.

## Colors — 9 semantic tokens

All values below occur in `packages/ui/src/styles.css`; all except surface-2 and yellow also occur in `scripts/installer/page.css`.

| Token | Value | Usage |
| --- | --- | --- |
| --bg | #1a1218 | Canvas, quiet inset areas |
| --surface | #20161e | Installer panels |
| --surface-2 | #241822 | Emphasized inset, step rail |
| --line | #342230 | Decorative separators, not sole control boundaries |
| --text | #f6eff3 | Headings, body copy |
| --muted | #a78e9b | Secondary copy on the three dark backgrounds |
| --accent | #f095c8 | Primary action, keyboard focus, current step |
| --accent-ink | #1a1218 | Text on accent; never white on pink |
| --yellow | #e0c27a | Explicit simulation / caution text on dark surfaces |

## Typography — 2 system-only fallback stacks

Source: `packages/ui/src/styles.css` --font-text and --font-mono. Omit named non-system leading fonts; use only their existing system fallback subsequences. No font downloads.

- --font-text: system-ui, -apple-system, "Segoe UI", sans-serif
- --font-mono: "SF Mono", ui-monospace, Menlo, monospace

Source: `scripts/installer/page.css`: body 14px/20px; h1 28px/36px; h2 18px/24px. Source: `packages/ui/src/styles.css` .eyebrow: 12px/16px, weight 600, tracking 0.12em, uppercase. Weights 400, 600, 700 occur in app CSS. These are the four size/line-height pairs used here.

## Spacing — 7 values

4px, 8px, 12px, 16px, 24px, 32px, 48px. Sources: `scripts/installer/page.css` focus offset / margins / section padding / main padding; `packages/ui/src/styles.css` header gaps. Reuse these for inset, gap and vertical rhythm. Zero is a reset, not a spacing token.

## Radius — 2 values

--radius-sm: 8px; --radius-md: 12px. Sources: both CSS files. Buttons use small, panels use medium. No invented pill radius.

## Shadow — 1 value

--accent-shadow: 0 10px 30px rgba(240, 149, 200, 0.3). Source: `packages/ui/src/styles.css`. Primary action only; no shadow stacks on panels. The shadow's translucent color is a sourced effect, not an additional text color.

## Component rules

- Flat dark panels, subtle decorative line borders; distinguish sections with headings and spacing too. No gradients or stock hero.
- Primary button: accent fill and border, accent-ink text, small radius, weight 600; sourced shadow. Installer minimum control height 44px, padding 8px 16px (`scripts/installer/page.css`). Secondary buttons and disclosure boundaries use muted or accent borders for contrast; never line alone.
- Focus: 2px solid accent, 4px offset (`scripts/installer/page.css`). Native semantic buttons, details/summary, labels and checkbox controls. No invisible interactions.
- Eyebrows: 12px/16px mono, accent, uppercase. Body 14px/20px, headings as above. Readable text never uses decorative border color.
- Preview disclosure is sticky and always says: “Design concept / simulated preview—no operations performed”. Simulated lifecycle states must also say simulated. No success-green status.
- Package information is read-only. No fabricated version, size or release URL. macOS DMG; Linux Debian / Arch packages. No platform detection or permissions triggered.
- No motion, network, persistent storage, OS actions, app commands or real verification. Interactions can only illustrate local review/cancel states. Native details are permitted.

## Self-check contract

All four HTML boards embed only these colors, stacks and rules. Contrast checks cover text, muted, accent and yellow against bg / surface / surface-2, plus accent-ink on accent. Focus accent is checked on all dark surfaces. Decorative line borders do not convey an action or status alone. Structural verification is not browser, assistive-technology or native installation proof.
