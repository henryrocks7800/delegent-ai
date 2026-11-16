# Delegent AI — Design Principles & Rebuild Brief

> **What the app looks like now (2026-09-28): "Pearl".** Alex chose it from
> five looks on his own phone. It keeps this brief's bones (warm light
> surface, Geist for text, Instrument Serif italic for titles and the brand)
> but replaces the sage accent with ink (`#222220`), puts one soft ambient
> light behind every screen, and uses glass cards (white at 40% with a white
> edge, no shadow). The values live in code, not here:
> `apps/mobile/src/design/tokens.ts` (colours, type, radii, shadows),
> `apps/mobile/src/design/Ambient.tsx` (the light and the pastel guide
> headers) and the `:root` block at the top of
> `apps/mobile/assets/chat-webview/index.html` (the chat's own palette). Read
> the colour tokens below as history.

This document accompanies `coworker-ai-redesign.html` (open it in a browser, screenshot any phone). It tells a coding agent **exactly what to build** to move the app from "hand-cranked" to a polished, modern feel.

The recommended direction is **01 — Quiet** (light, airy). **02 — Studio** is the same system in dark. **03 — Editorial** is a bolder, type-led alternative. Pick one as the source of truth before the agent starts coding.

---

## 1. Audit — what makes the current build feel busy

A short, blunt list of the issues, so the agent knows what to *stop* doing:

1. **Card overload.** Every block — title, stat, faq, list row — sits inside its own rounded-rectangle dark-blue card. There is no hierarchy because everything has the same elevation, the same radius, the same fill. The eye has nowhere to rest.
2. **Five-element header on every screen.** Hamburger, robot logo, "Delegent AI Online", theme toggle, avatar. That is too many controls competing with the page content. A modern app puts at most 2–3 controls in the top bar.
3. **Inconsistent badge/pill system.** "Pro Office" (purple outline), "Ready" (blue outline), "Review" (amber outline), "Next" (grey outline), "Planned" (grey outline), "Coming later" (grey text). Six visual treatments, no clear rule.
4. **Muddy palette.** The dark-blue-grey surface (~#1A1F2E) plus a timid lavender-blue accent reads as generic SaaS. There is no distinctive colour the brand owns.
5. **Type hierarchy is flat.** Headlines and section labels are all sans-serif at similar weights. Without contrast (size, weight, family, or italic), the page reads as one continuous slab.
6. **Default icon set.** The activity-line / paper-plane / folder icons are fine but the robot mark and section icons feel template-ish. The brand mark especially needs to do more work.
7. **Inconsistent spacing.** Vertical rhythm jumps between cards. There is no clear 8pt grid.
8. **Empty space treated as a problem.** Screens like Profile and Capacity have huge empty bottom areas that feel unfinished rather than calm. With proper hierarchy, that empty space becomes part of the design.
9. **Floating tab pill.** A novel pattern, but the icons are tiny and unlabelled. Users have to guess.
10. **Voice/copy is good — keep it.** "Brief it once, then let it handle the admin work" / "Anything you can guide on a PC can become a repeatable task" is on-brand and warm. Don't rewrite this; design *for* it.

---

## 2. Direction 01 — Quiet (recommended)

A warm off-white surface, a single sage accent, an Instrument Serif italic carrying personality, and *no cards by default*. Hierarchy comes from type, hairlines, and whitespace.

### 2.1 Colour tokens

```
// Surface
--surface-bg        #FAFAF7    // page background, warm off-white
--surface-raised    #FFFFFF    // only used for modals / sheets / tooltips
--surface-alt       #F2F1ED    // optional, for very subtle differentiation
--surface-overlay   rgba(14, 14, 12, 0.04)   // hover / pressed state on rows

// Text
--text-primary      #0E0E0C    // headlines, primary body
--text-secondary    #6F6E68    // lede copy, metadata
--text-tertiary     #A8A6A0    // disabled state, "coming later"

// Hairlines & dividers (no card fills — use these instead)
--divider           #E5E2DA
--divider-strong    #C8C5BD    // when a stronger break is needed

// Accent (used sparingly — italic display words, active state, primary action)
--accent            #2A4A3A    // deep sage
--accent-soft       #E8EFE7    // active row tint, capacity bar background

// Status
--status-success    #4A7A4A    // small dot only — never a fill
--status-warn       #B8956E    // terracotta
--status-mute       #A8A6A0    // unavailable / coming later

// Brand mark backgrounds (brand monogram)
--mark-bg           #0E0E0C    // black square with cream "C" italic on top
--mark-fg           #FAFAF7
```

For dark mode (Direction 02 — Studio), invert: `--surface-bg #0C0C0C`, `--text-primary #FAFAF7`, `--divider rgba(255,255,255,0.08)`, accent shifts to champagne `#D4B896`.

### 2.2 Typography

Two families, used with discipline.

**Inter** for everything by default. **Instrument Serif** *italic only*, for accented words inside headlines and as the brand monogram. The italic serif is a *brand voice* device — it should appear maybe once per screen, not on every line.

```
// Display (page titles)
size 32sp · weight 400 · line-height 1.05 · tracking -0.5%
family Inter; italic accent words use Instrument Serif italic 400

// Display sm (secondary screen titles)
size 28sp · weight 400 · line-height 1.08 · tracking -0.3%

// Body lede (the sentence under the headline)
size 15sp · weight 400 · line-height 1.5 · color text-secondary

// Body
size 15sp · weight 400 · line-height 1.45

// Label (eyebrow, section labels, list metadata)
size 11sp · weight 500 · line-height 1.2 · tracking +14% · UPPERCASE
color text-secondary

// Numeric / mono accents
Use Instrument Serif italic 14sp for numbered list markers (01, 02, 03)
not a monospaced font — keeps the warm, editorial feel
```

### 2.3 Spacing

Strict 4pt rhythm, with 8/16/24/32 doing 90% of the work.

```
4 · 8 · 12 · 16 · 24 · 32 · 48 · 64 · 96
```

Default screen padding: **24dp** horizontal. Default vertical rhythm between blocks: **24dp**. Between a row and a divider: **18dp**.

### 2.4 Component rules

**No cards by default.** A card (rounded rect with a fill) is reserved for genuinely modal content like a dialog or a confirmation. Replace every existing card with one of:

- **Hairline-separated rows** for lists (most common)
- **Three-up stat strip** with internal vertical hairlines (used on Home only)
- **Inline group with a label and a hairline** for grouped key/value pairs (Profile)

**Buttons.**
- *Primary*: black solid pill, 14sp white label, 48dp height. Used at most once per screen.
- *Secondary (ghost)*: transparent, 1px `--text-primary` border, pill, 48dp.
- *Tertiary (text-only)*: 13sp `--accent` weight 500, with a trailing arrow `→` for forward actions.

**Status indicators.**
- A 6dp filled dot (`--status-success` / `--status-warn` / `--status-mute`) plus inline text.
- **Never** a pill, never a coloured background, never a border.

**Brand mark.**
- A 64dp rounded square (radius 18dp), `--mark-bg` fill, with an italic Instrument Serif "C" in `--mark-fg` at 32sp. This replaces the generic robot.
- App icon and login screen use the large form. Header uses no mark — only the screen title.

**Top bar.**
- Two slots: a back/menu icon (left) and an avatar (right). That is it.
- No persistent "Delegent AI · Online" — the user knows what app they are in. Online state lives on the Home screen as a single small dot + label, near the stats.
- Theme toggle moves into Profile / Settings, not the top bar.

**Bottom navigation.**
- Three items: Home, Connect, Files. Inline label under each icon, 10sp uppercase.
- No floating pill background — just a top hairline divider above the tab area.
- Active state: icon + label go to `--text-primary`; inactive go to `--text-tertiary`.

**List rows.**
- Numbered list items use an italic Instrument Serif "01", "02", "03" as the eyebrow above the title (small, sage-tinted).
- Title at 16sp / 500. One-line meta below at 12sp / `--text-secondary`.
- Right-aligned status: dot + uppercase 11sp label.

**Input fields.**
- No filled background. A bottom-line input only (1px `--divider`, becomes 1px `--text-primary` on focus).
- Label is the eyebrow style above the field.

**Capacity / progress.**
- 4dp tall, 2dp radius track, `--divider` background, `--accent` fill. Percentage label uppercased to the right at 11sp.

### 2.5 Motion

Quiet products move quietly. Keep durations short and easings calm.

- Standard transition: **180ms · `cubic-bezier(0.2, 0, 0, 1)`** (Material emphasized decelerate)
- Between-screen navigation: shared-axis horizontal slide (forward/back) at 220ms
- Tab change: cross-fade at 150ms, no slide
- Modal sheet: slide up + fade at 240ms with a small overshoot (`cubic-bezier(0.22, 1, 0.36, 1)`)
- No bouncy springs. No delayed staggered reveals on list items — show everything at once.

### 2.6 Iconography

Use a single line-icon set — Lucide or Phosphor (regular weight, 1.5px stroke). Do *not* mix line and filled icons in the same view. Icons are 20dp in nav, 18dp in headers, 14dp inline.

Drop the robot mark entirely. The italic "C" monogram does the brand work.

### 2.7 Voice

The current copy is good. Two small edits:

- "Delegent AI" header text → remove from chrome, keep only on the welcome screen
- Status pills with full sentences ("Ready to connect") → reduce to single words ("Ready", "Coming later", "Unavailable")

---

## 3. Direction 02 — Studio (dark variant of Quiet)

Same system, dark mode.

```
--surface-bg        #0C0C0C
--surface-raised    #161616
--text-primary      #FAFAF7
--text-secondary    #8A8580
--text-tertiary     #6B6258
--divider           rgba(255, 255, 255, 0.08)
--accent            #D4B896    // champagne — replaces sage in light mode
--mark-bg           #FAFAF7    // mark inverts: cream square, black italic C
--mark-fg           #0C0C0C
```

Everything else (typography, spacing, components, motion) is identical to Direction 01. The app should support both as a single theme system that swaps tokens — not two separate designs.

Recommended: **light by default**, dark available in Profile. The current build defaults to dark; switching to light-default is part of what makes the redesign feel modern.

---

## 4. Direction 03 — Editorial (bolder alternative)

Type-led, magazine-style. Higher visual risk, higher distinctiveness.

```
--surface-bg        #F2EEE2    // warm cream
--text-primary      #1A1817
--text-secondary    #4A4238
--accent            #C73E0A    // burnt orange
--divider           rgba(26, 24, 23, 0.18)
--rule-strong       #1A1817    // 1px black, used to separate sections
```

**Type:**
- **Fraunces** (serif) for all headlines, weight 300, italic for accent words. Display sizes 38–54sp.
- **Inter** for body and UI labels.
- **JetBrains Mono** at 9–10sp uppercase for numeric metadata ("01 — PDF · 18 MIN").

**Components:**
- *Square corners on cards/buttons* (radius 0). The pill is replaced by a hard-edged rectangle.
- Numbered sections everywhere, with a strong 1px black rule separating major blocks.
- Bottom navigation uses small uppercase labels only — no icons.

This direction is best if you want Delegent AI to feel like a *published* product (a craft tool, an editorial app) rather than a SaaS dashboard. It will not appeal to everyone, but those who like it will *really* like it.

---

## 5. Screen-by-screen rebuild notes

### Welcome / Login
Centred 64dp italic-C mark, headline "Your *quiet* coworker." with the italic word in `--accent`, one short lede sentence, and a single primary button at the bottom. No card around the Google sign-in — the button is the call.

### Home
Page eyebrow ("Tuesday · 5 May") in label style, headline "Ready for the *next task.*" with italic accent, one-sentence lede, three-up stat strip (Messenger / Files / Capacity) bordered top and bottom by hairlines and separated by vertical hairlines, a single status line ("● Online · Ready when you message it") below the stats, and one ghost button "Choose messenger & plan" pinned above the bottom nav. That's it. The current "card containing a card containing chips" pattern goes away.

### Connections
Same eyebrow + headline + lede pattern. Then a hairline-separated list of three rows: Telegram (active, sage dot, "Connect →" tertiary action), WhatsApp (warn dot, "Coming later"), Signal (mute dot, "Unavailable"). The current heavy card+icon-tile per messenger collapses into clean rows.

### Files
Eyebrow / headline / lede, then hairline-separated list rows with: italic-numbered eyebrow (file type · time), title in 18sp, one-line meta, right-aligned status (dot + uppercase label). No icons in the row — the file type is in the eyebrow.

### Menu (drawer)
Top: large name "Alex" + lede ("Google account · Pro Office"). Then a hairline-separated list of destinations, single-line, no icons, with `→` glyph at the right. Sign out is a ghost button at the bottom. Drop the per-row mini icons that the current build has.

### Profile
Eyebrow + "Profile" headline + lede. Key/value list (Name, Google, Region, Plan) as hairline rows, with the label in eyebrow style on the left and value in body on the right. Two buttons at the bottom: "Manage plan" (primary) and "Sign out" (ghost).

### Setup guide
Eyebrow shows step state ("Setup · Step 1 of 2"). Headline "Choose *messenger.*" with italic accent. Hairline-separated radio rows — the radio is a 18dp circle, becomes a 5dp ring with the surface colour inside when selected. Active state for an entire row is *only* the filled radio — no full-row colour wash, no bordered card. Then a sub-heading for Step 2 (Plan) and the same pattern.

### Use cases
List of 5–7 numbered items. Italic "01" in sage as the eyebrow, 18sp title, 12sp single-line meta. No green checkmark icons. The numbering carries the rhythm.

### FAQs
Same as Use cases pattern — italic numbered eyebrow, question in 16sp/500 as the title, two-line answer at 13sp `--text-secondary`. Hairline between items. No accordion needed at this length.

### Monthly capacity
Eyebrow ("May · Pro Office"), big headline "*Comfortable.*" (full italic), lede. Then a single capacity bar with "USED · 62%" label above. Below, three hairline rows for "Best for / Files / If it gets busy". Ghost button "Review setup choices" at the bottom. The current heavy card-in-card pattern collapses into one quiet page that finally lets the *italic word* "Comfortable" be the hero.

---

## 6. Android-specific implementation notes

The agent should build this in **Jetpack Compose with Material 3**, theming the M3 colour roles to the tokens above.

### 6.1 Material 3 colour role mapping (Quiet, light)

```
md.sys.color.surface              -> #FAFAF7
md.sys.color.surface-container    -> #F2F1ED   // sheets, dialog backgrounds only
md.sys.color.on-surface           -> #0E0E0C
md.sys.color.on-surface-variant   -> #6F6E68
md.sys.color.outline-variant      -> #E5E2DA   // hairlines
md.sys.color.outline              -> #C8C5BD
md.sys.color.primary              -> #2A4A3A
md.sys.color.on-primary           -> #FAFAF7
md.sys.color.primary-container    -> #E8EFE7
md.sys.color.on-primary-container -> #2A4A3A
md.sys.color.secondary            -> #B8956E   // status warn
md.sys.color.error                -> reuse #B8956E or define separately
```

For dark (Studio), apply the inverted tokens from §3 to the same roles.

### 6.2 Typography (Material 3 type roles)

```
displayMedium    Inter 400 / 32sp / -0.5%   (page headlines)
displaySmall     Inter 400 / 28sp / -0.3%
titleLarge       Inter 500 / 18sp           (list titles)
bodyLarge        Inter 400 / 15sp           (lede + body)
bodyMedium       Inter 400 / 13sp / 1.5lh   (metadata, FAQ answers)
labelLarge       Inter 500 / 14sp           (button labels)
labelMedium      Inter 500 / 11sp / +14% / UPPERCASE   (eyebrows, eyebrow rows)
```

For italic accents inside `displayMedium` / `displaySmall`, use a `Text` composable with an `AnnotatedString` and apply a `SpanStyle(fontFamily = InstrumentSerif, fontStyle = FontStyle.Italic, color = Accent)` to the accent word(s).

### 6.3 Components

- **No cards.** Wrap list sections in plain `Column`s separated by `HorizontalDivider(color = outlineVariant, thickness = 1.dp)`. If the agent reaches for `Card`, it should pause and re-read this brief.
- **Top app bar:** `CenterAlignedTopAppBar` with no title text on most screens — just navigation icon and a single trailing avatar. Title text is part of the page body, not the bar.
- **Bottom nav:** `NavigationBar` with three `NavigationBarItem`s. Set `containerColor = Color.Transparent` and add a `HorizontalDivider` above the bar. Set `indicatorColor = Color.Transparent` (no pill behind the active icon — colour change does the work).
- **Buttons:** `Button` with `shape = CircleShape` for primary; `OutlinedButton` with `border = BorderStroke(1.dp, onSurface)` for ghost.
- **Radio rows:** custom row using `RadioButton` with `colors = RadioButtonDefaults.colors(selectedColor = onSurface, unselectedColor = outline)`.
- **Status dot:** a 6.dp `Box` with `background(color = statusColor, shape = CircleShape)` followed by inline text.

### 6.4 Animation

Use `MaterialTheme`'s motion tokens — durations from `MotionTokens.DurationShort2` (200ms) and easings from `EasingTokens.EmphasizedDecelerate`. Avoid Compose's spring-based defaults for nav transitions — they read as too playful for this design.

### 6.5 Assets

- Replace the robot icon with a vector drawable of the italic "C" monogram on a rounded square. One asset, recoloured via `tint` for light/dark.
- Use Lucide icons via the `composeIcons-lucide` library or hand-bundle the SVGs. Stroke width 1.5px, regular weight only.
- Adaptive icon: black-on-cream for the light theme system icon, cream-on-black for dark.

---

## 7. Sequencing for the rebuild

Suggested order if the agent is building this from scratch:

1. **Theme & tokens** — set up the light + dark `ColorScheme` and the `Typography` object first. Verify by viewing a sample list row in both themes.
2. **Brand mark composable** — italic-C-on-square, parameterised on size and colour scheme.
3. **Top bar + Bottom nav** — build the chrome once, reuse everywhere.
4. **Common list row** — title, meta, trailing status. This component appears on Connections, Files, Use cases, FAQ.
5. **Welcome / Login screen** — simplest screen, validates the type system end-to-end.
6. **Home** — introduces the stat strip and the ghost button.
7. **Files / Connections / Use cases / FAQs** — all share the same row pattern.
8. **Setup wizard** — radio row pattern.
9. **Profile / Menu / Capacity** — key/value rows + capacity bar.
10. **Motion polish + dark mode QA** — pass over every screen at the end.

---

## 8. What "done" looks like

A user opens the app and the first thing they notice is **whitespace**. The headline is the loudest thing on screen, and one italic word in it carries the brand. There are no boxes inside boxes. The bottom of the screen is mostly empty — and that feels intentional, not unfinished. The whole thing reads as a quiet, confident tool that respects their attention.

That is the target.
