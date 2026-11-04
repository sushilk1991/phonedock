---
name: PhoneDock site
description: The public landing page in site/, a stage seen from the booth in dark show mode and light work-light mode.
colors:
  accent: "light-dark(#5856d6, #5e5ce6)"
  accent-ink: "light-dark(#5856d6, #a5a3ff)"
  agent: "light-dark(#af52de, #bf5af2)"
  agent-ink: "light-dark(#7a2fa8, #d08cff)"
  agent-strong: "light-dark(#7a2fa8, #8e44c8)"
  you: "light-dark(#5856d6, #7d7aff)"
  handoff: "light-dark(#c2410c, #ff9f0a)"
  handoff-ink: "light-dark(#9a3d00, #ff9f0a)"
  ok: "light-dark(#248a3d, #30d158)"
  ground: "light-dark(#e8e8ec, #0a0a0f)"
  ground-deep: "light-dark(#dedee4, #07070b)"
  paper: "light-dark(#ffffff, #12121a)"
  paper-2: "light-dark(#f6f6f8, #171722)"
  ink: "light-dark(#111114, #eeeef4)"
  ink-2: "light-dark(#55555b, #a9a9b9)"
  ink-3: "light-dark(#8c8c95, #5c5c6b)"
  line: "light-dark(rgb(17 17 20 / 0.11), rgb(255 255 255 / 0.085))"
  line-2: "light-dark(rgb(17 17 20 / 0.2), rgb(255 255 255 / 0.16))"
  handset-black: "#0c0c0e"
  on-fill: "#ffffff"
typography:
  display:
    fontFamily: "Archivo, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "clamp(2.5rem, 4.9vw, 4.875rem)"
    fontWeight: 800
    lineHeight: 0.98
    letterSpacing: "-0.034em"
    fontVariation: "'wdth' 110"
  headline:
    fontFamily: "Archivo, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "clamp(2rem, 3.9vw, 3.5rem)"
    fontWeight: 760
    lineHeight: 1.02
    letterSpacing: "-0.028em"
    fontVariation: "'wdth' 112"
  lede:
    fontFamily: "Archivo, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "clamp(1.5rem, 2.6vw, 2.25rem)"
    fontWeight: 620
    lineHeight: 1.24
    letterSpacing: "-0.016em"
    fontVariation: "'wdth' 104"
  quote:
    fontFamily: "Archivo, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "clamp(1.25rem, 2vw, 1.75rem)"
    fontWeight: 520
    lineHeight: 1.4
    letterSpacing: "-0.012em"
  title:
    fontFamily: "Archivo, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 680
    lineHeight: 1.6
    fontVariation: "'wdth' 108"
  sub:
    fontFamily: "Archivo, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "clamp(1.0625rem, 1.3vw, 1.25rem)"
    fontWeight: 420
    lineHeight: 1.55
  body:
    fontFamily: "Archivo, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 420
    lineHeight: 1.6
  small:
    fontFamily: "Archivo, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 420
    lineHeight: 1.6
  label:
    fontFamily: "Archivo, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 660
    letterSpacing: "0.1em"
    fontVariation: "'wdth' 80"
  key:
    fontFamily: "Archivo, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "1rem"
    fontWeight: 620
    lineHeight: 1
    fontVariation: "'wdth' 104"
  mono:
    fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "0.86em"
    fontWeight: 450
    letterSpacing: "-0.01em"
  code-block:
    fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "clamp(0.78rem, 0.95vw, 0.875rem)"
    fontWeight: 450
    lineHeight: 1.75
rounded:
  tag: "6px"
  brand-mark: "7px"
  chip: "8px"
  nav-button: "9px"
  control: "10px"
  field: "12px"
  media: "14px"
  panel: "16px"
  hub: "18px"
  handset-droid-screen: "19px"
  handset-droid-mobile: "22px"
  handset-ios-screen-mobile: "24px"
  handset-droid: "26px"
  handset-ios-screen: "29px"
  handset-ios-mobile: "30px"
  handset-ios: "36px"
  full: "50%"
spacing:
  xs: "8px"
  sm: "12px"
  md: "16px"
  lg: "20px"
  xl: "28px"
  2xl: "40px"
  gutter-wide: "56px"
  gutter-mid: "40px"
  gutter-narrow: "20px"
  section-wide: "112px"
  section-mid: "96px"
  section-narrow: "72px"
  wrap: "1240px"
components:
  key:
    backgroundColor: "color-mix(in oklab, {colors.paper} 72%, transparent)"
    textColor: "{colors.ink}"
    typography: "{typography.key}"
    rounded: "{rounded.control}"
    padding: "0 20px 0 16px"
    height: "48px"
  key-hover:
    backgroundColor: "color-mix(in oklab, {colors.paper} 72%, transparent)"
    textColor: "{colors.ink}"
  key-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-fill}"
    typography: "{typography.key}"
    rounded: "{rounded.control}"
    padding: "0 20px 0 16px"
    height: "48px"
  key-primary-hover:
    backgroundColor: "color-mix(in oklab, {colors.accent} 88%, #fff)"
    textColor: "{colors.on-fill}"
  key-small:
    rounded: "{rounded.chip}"
    padding: "0 14px"
    height: "34px"
  key-take-over:
    backgroundColor: "{colors.agent-strong}"
    textColor: "{colors.on-fill}"
    rounded: "{rounded.chip}"
    padding: "0 14px"
    height: "34px"
  lamp:
    backgroundColor: "{colors.ink-3}"
    rounded: "{rounded.full}"
    size: "12px"
  cue-panel:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.panel}"
    padding: "8px 8px 8px 16px"
  cue-light:
    rounded: "{rounded.full}"
    size: "14px"
  command-field:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.field}"
    padding: "14px 14px 14px 20px"
  copy-button:
    backgroundColor: "{colors.paper-2}"
    textColor: "{colors.ink}"
    rounded: "{rounded.chip}"
    padding: "0 12px"
    height: "36px"
  clip-hold:
    backgroundColor: "rgb(18 18 20 / 0.72)"
    textColor: "{colors.on-fill}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "32px"
  nav-button:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "9px"
    padding: "0 12px"
    height: "36px"
  handset:
    backgroundColor: "{colors.handset-black}"
    rounded: "{rounded.handset-ios}"
    padding: "7px"
    width: "232px"
  prompt-book:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.panel}"
    padding: "40px"
  beta-tag:
    textColor: "{colors.handoff-ink}"
    rounded: "{rounded.tag}"
    padding: "4px 8px"
---

# Design System: PhoneDock site

This file covers the public landing page in `site/` only. The Mac app's design guide is `design/DESIGN.md`.

## Overview

**Creative North Star: "The Stage Seen from the Booth"**

The page is a stage manager's view of a show. Phones stand on their marks under a light rig, an agent calls the show, and a cue light hands the one step it can't do to a person. Dark mode is show mode: matte black tinted indigo, cool light pools, a faint haze beam over each phone. Light mode is work-light mode: the app's pale stage grey with white paper and graphite ink. Both themes come from one set of `light-dark()` custom properties on `:root`, and the 3D stage reads its own colours from the `LOOKS` table in `site/js/stage.js`.

Saturated colour belongs to state. The three control colours from the Mac app (agent purple, you indigo, needs-you orange) mark who is in control, and the accent indigo fills the primary key. Everything else is ground, paper, ink and hairline rules. Sections are long ruled lists and two-column grids on the bare ground, with very few boxed containers. The real product carries the proof: the 3D hero, a screen recording of the handoff, captured phone screens in CSS handsets and a phone recording in the Prompts run-sheet.

Motion is gentle and always optional. The hero stage, the wire packets in How it works, the handoff ring and the reveals all stop under `prefers-reduced-motion`. Recordings play only while on screen and always carry a Pause/Play control.

**Key Characteristics:**
- Two themes from one token set, switched by `light-dark()` and a stored toggle.
- Archivo variable, expanded and heavy for headlines. JetBrains Mono only for tool calls, commands and YAML.
- Buttons are cue-light keys with a lamp dot.
- State colour appears only as round cue lights, lamp dots and state-coloured text or fills.
- Hairline-ruled lists (run-sheet, setup steps, handoff steps, FAQ) carry most sections.
- A Three.js stage in the hero, with a rendered poster for reduced motion and no WebGL.

## Colors

A neutral grey stage with three saturated state colours and one indigo accent, all inherited from the Mac app.

### Primary
- **Rig Indigo** (`accent`): the fill of the primary key ("Download for Mac"), text selection and the skip link. Its ink twin `accent-ink` carries links, focus rings, YAML keys, the main setup step number and lamp dots on hover.

### Secondary
- **Agent Purple** (`agent`): the agent-driving cue light, the role light for "Agent driving", the live wire packet in How it works and the agent's cursor, trail and tap ring in the 3D stage. `agent-ink` colours call numbers and YAML strings. `agent-strong` fills the Take Over key in the cue panel.
- **You Indigo** (`you`): the cue light and step light when the person is driving.

### Tertiary
- **Needs-You Orange** (`handoff`): the cue light and its pulsing ring when the agent asks for help, the handoff step light, the dash before each limit in Privacy and limits. `handoff-ink` colours the handoff state text and the Beta tag. Light mode uses burnt orange so the colour also works as text.
- **Pass Green** (`ok`): `PASS` lines in the terminal page and the copy button after a copy. It is the one saturated colour outside the app's control set.

### Neutral
- **Stage Grey / Stage Black** (`ground`): the page background and the 3D scene background and fog.
- **Deep Ground** (`ground-deep`): alternate band behind the Handoff and Flows sections, bounded by `line` rules.
- **Prompt-Book Paper** (`paper`, `paper-2`): the few raised surfaces (cue panel, hub card, prompt book, command fields) and secondary fills (copy button, run-sheet Pause control).
- **Graphite Ink** (`ink`, `ink-2`, `ink-3`): headings and strong text, body and secondary text, idle lamps and quiet marks.
- **Hairlines** (`line`, `line-2`): section rules, list rules, borders on keys and panels. `line` also fills inline code and hover backgrounds.

### Named Rules
**The State Colour Rule.** Purple, indigo and orange mean agent, you and needs-you everywhere on the page and in the 3D scene. Don't use them for decoration.

**The Shared Palette Rule.** Control colours match `design/DESIGN.md` exactly, per theme. New state colours start in the app's guide, then come here.

## Typography

**Display Font:** Archivo variable, self-hosted (`site/fonts/archivo-var.woff2`, weight 400 to 850, width 75% to 125%), with the system sans as fallback.
**Body Font:** Archivo at normal width.
**Label/Mono Font:** JetBrains Mono variable, self-hosted (`site/fonts/jetbrains-mono-var.woff2`).

**Character:** Archivo pushed wide and heavy reads like stencilled stage signage at headline size and stays plain and readable at body size. JetBrains Mono marks anything a person or agent would actually type or receive.

### Hierarchy
- **Display** (800, width 110%): the hero headline only, about 9.5em wide at most. The closing "Give your agent a phone" heading uses the same voice a little wider (116%).
- **Headline** (760, width 112%): section headings. Balanced wrapping.
- **Lede** (620, width 104%): the one large statement that opens "What it is", capped at 44ch.
- **Quote** (520): the prompt in each run-sheet row.
- **Title** (680 to 700, width 108%, 1.0625 to 1.25rem): setup step titles, device names, Privacy and limits subheads.
- **Sub** (420): the line under each section heading, in `ink-2`, capped at 38rem.
- **Body** (420, 1.0625rem, line-height 1.6): running text. Strong text is 650.
- **Small** (0.9375rem): captions, run-sheet notes, device notes, setup notes.
- **Label** (660, 0.75rem, width 80%, letter-spacing 0.1em, uppercase): only the "Agent" and "Devices" column labels in the How it works diagram. The Beta tag uses the same condensed caps at 0.6875rem.
- **Key** (620, 1rem, width 104%): text on keys.
- **Mono** (450, 0.86em): inline tool calls and commands. Code blocks run at up to 0.875rem with line-height 1.75.

### Named Rules
**The Wide Headline Rule.** Headlines use Archivo at 110% to 116% width with negative tracking (-0.028em to -0.035em). Body text stays at 100% width.

**The Typed Text Rule.** JetBrains Mono appears only for tool calls (`get_ui`, `tap`, `request_human`), shell commands and flow YAML or terminal output. Prose, labels and buttons never use it.

## Layout

Content sits in a centred wrap of up to 1240px with side gutters of 56px, 40px below 1080px and 20px below 820px. Sections are separated by vertical padding of 112px (96px below 1080px, 72px below 820px), with the opening "What it is" and the closing call slightly taller. Each section opens with a heading block up to 44rem wide and 40 to 64px of space below it.

The hero is full-bleed and at least 100svh tall on wide screens. Copy sits top-left in a column up to 44rem, and the 3D stage fills the frame behind it, fading out over its last 16%. On wide screens (1081px and up) the cue panel is placed by script just above the PhoneDock window in the scene, using the window's projected top edge, or the measured anchor on the poster. Below 1080px the hero stacks: stage first, then the cue panel overlapping it by 40px, then the copy.

Most sections are ruled grids: a three-column role row, a three-column call list, a four-up device lineup that aligns names with subgrid, a three-part run-sheet (kind, prompt, note), a 5:7 handoff grid, and 4:8 FAQ. Grids collapse to two columns then one at the 1080px and 820px breakpoints. Spacing steps are 8, 12, 16, 20, 28 and 40px, with gaps that scale through `clamp()`.

### Named Rules
**The Inner Padding Rule.** A bordered or filled container keeps at least 8px of inner padding between its edge and its content.

## Elevation & Depth

The page is mostly flat. Real depth lives in the 3D stage: fog, a matte floor, spotlights with soft pools, and in dark mode a faint additive haze cone above each phone (opacity 0.11). The phone in play is fully lit and the others idle at a dimmer level. On the 2D page a handful of objects lift off the ground with long, soft, negatively spread shadows, and each also has a hairline edge. The hero copy, lists and grids never cast shadows.

### Shadow Vocabulary
- **Panel lift** (`box-shadow: 0 18px 40px -26px rgb(0 0 0 / 0.65)`): the cue panel.
- **Hub lift** (`box-shadow: 0 24px 60px -36px rgb(0 0 0 / 0.5)`): the PhoneDock card in the How it works diagram.
- **Book lift** (`box-shadow: 0 40px 90px -50px rgb(0 0 0 / 0.45)`): the open prompt book in Flows.
- **Media lift** (`box-shadow: 0 0 0 1px var(--line-2), 0 40px 100px -50px rgb(0 0 0 / 0.55)`): the handoff recording.
- **Handset lift** (`box-shadow: 0 0 0 1px var(--line-2), 0 34px 60px -38px rgb(0 0 0 / 0.75)`): CSS handsets.

### Named Rules
**The Lit Is Live Rule.** Light marks what is active: the phone in play gets the spotlight, the lit handoff step follows the recording, and the closing pool brightens when it scrolls into view.

## Shapes

Corners are gently rounded and scale with the object: 6px for tags and inline code, 8px for small keys, nav links and copy buttons, 10px for keys and media controls, 12px for command fields, 14px for the handoff video, 16px for the cue panel and prompt book, 18px for the hub card. Handsets imitate real phones (36px outer and 29px screen for iPhone, 26px and 19px for Android, smaller on mobile) with a pill island or punch-hole drawn in CSS. Cue lights, lamps, role lights and step lights are rings with a filled core (a 1.5px border around a padded content-box fill). Borders are 1px hairlines in `line` or `line-2`. The FAQ disclosure is a drawn chevron. The flow page carries one hand-drawn pencil bracket as an inline SVG.

## Components

### Buttons (Keys)
Keys look like the buttons on a stage manager's cue desk. Each key has a lamp dot before its label.
- **Shape:** gently rounded (10px), 48px tall, padding 0 20px 0 16px, 1px `line-2` border on a 72% `paper` wash.
- **Lamp:** a 12px ring with a 2px inset dot, idle in `ink-3`. On hover or focus the lamp lights in `accent-ink` and the border darkens to `ink-2`. Pressing moves the key down 1px.
- **Primary:** `accent` fill, white text, a translucent white lamp that turns solid white on hover. The fill lightens by mixing 12% white on hover.
- **Small:** 34px tall, 8px corners, 0.875rem. Used for Take Over (`agent-strong` fill, white text) and Done in the cue panel. These carry no lamp.
- **Disabled:** 45% opacity, no press movement.
- **Mobile:** below 480px keys in an action row share the width and centre their labels, and "View on GitHub" shortens to "GitHub".

### Cue Panel
A small paper panel that says who is in control of the hero demo. It shows a 14px cue light in the state colour, the state in 640 weight `ink` ("Claude Code is driving", "Claude Code is waiting for you", "You’re driving"), the current call in mono or plain text, and a Pause/Play control. In the handoff state the border warms toward orange, the light gets a pulsing ring (1.4s), and Take Over then Done appear and respond to the visitor. Placed above the window it is one row, 32rem wide, so its width doesn't jump between calls. Without motion or WebGL it holds the handoff moment and its buttons still work, announced through a polite live region.

### Hero Stage
A Three.js scene with three phones on marks, the PhoneDock window upstage in fog, and the agent's light cursor whose trail arcs into the window's activity list. Phone screens and the window are drawn on 2D canvases from captures of the real app (`site/js/screens.js`). Each theme has its own `LOOKS` entry for background, floor, light levels, beams, glow and the three state colours. With reduced motion, Save-Data, no WebGL2 or a failed load, the page keeps a rendered poster of the same scene at the handoff moment, one per theme and one for narrow screens.

### Ruled Lists
The main reading pattern. Rows are separated by 1px hairlines with a closing rule under the last row.
- **Run-sheet (Prompts to try):** kind, quoted prompt, note, with 32px rows. The last row adds a phone recording in a 132px CSS handset with its own Play/Pause control beside it.
- **Handoff steps:** three rows, each with a 14px step light. The lights follow the handoff recording's timeline (asks, take over, hand back) in orange, indigo and purple.
- **Setup steps:** large condensed-wide numerals (800, 2rem, width 120%) in a 64px column. The main step's numeral is indigo.
- **FAQ:** native `details` rows with a drawn chevron that turns on open. Summaries go indigo on hover.

### Recordings
The handoff video sits in a 14px-rounded frame with the media lift. A Pause/Play control (32px, 10px corners, dark translucent glass with 8px blur) sits 12px in from the bottom-right corner. In the run-sheet the control sits beside the handset on `paper-2`. Videos are muted, loop, play only while on screen, wait for Play under reduced motion, and carry descriptive labels.

### Handsets
CSS phones for the device lineup and the run-sheet recording: a near-black frame (`handset-black`) with 7px of bezel, a rounded screen inside, and an island or punch-hole drawn with `::after`. The run-sheet handset drops the island because the recording shows the phone's own.

### Command Fields
Copyable commands and prompts in a 12px-rounded `paper` field with a `line-2` border and padding 14px 14px 14px 20px. A 36px copy button on `paper-2` reads Copy, then Copied in green for 2.2s, or "Press ⌘C" with the text selected if the clipboard is blocked. The prompt variant sets its text in Archivo because a prompt is plain language for the agent to read.

### Prompt Book
An open two-page book in Flows on `paper` with 16px corners and the book lift. The left page holds the YAML flow with an indigo glow from the top, a pencil bracket and margin notes on its right. The right page holds terminal output with a gutter shadow along the spine. Below 820px the pages stack, the bracket hides, and the notes move under the code behind a dashed rule.

### Navigation
A fixed 64px bar, transparent over the hero, that takes a 94% `ground` wash and a bottom hairline after 24px of scroll. Links are `ink-2` at 0.9375rem with 8px-rounded hover fills in `line`. The theme toggle and GitHub link are 36px outlined buttons with 9px corners. Links hide below 1080px, and the GitHub label hides below 480px.

### Tags and Lights
- **Beta tag:** condensed caps (0.6875rem, width 85%), a currentColor border, `handoff-ink` text.
- **Role lights:** the same ring-and-core light as the cue panel, one per role in "What it is".

## Do's and Don'ts

### Do:
- **Do** take every colour from the custom properties on `:root` and give each new token a light and dark value through `light-dark()`.
- **Do** keep agent purple, you indigo and needs-you orange tied to agent, person and help-needed states, matching `design/DESIGN.md`.
- **Do** make buttons as keys: a lamp dot, 10px corners, 48px height, hairline border, and the indigo fill only for the primary action.
- **Do** set headlines in Archivo at 110% to 116% width, 760 to 800 weight, with negative tracking.
- **Do** keep JetBrains Mono for tool calls, commands, YAML and terminal output.
- **Do** keep at least 8px of inner padding in any bordered or filled container.
- **Do** give every moving element a reduced-motion path and every video a visible Pause/Play control.
- **Do** show the real product (renders of the app, screen recordings, captured screens) and mark each shipping raster's origin in its sidecar JSON.

### Don't:
- **Don't** use the state colours as decoration, gradients or section tints.
- **Don't** set prose, labels or buttons in JetBrains Mono.
- **Don't** add hard offset shadows. Lifted objects use the long, soft, negatively spread shadows listed above with a hairline edge.
- **Don't** use front-of-house theatre imagery (curtains, masks, velvet, marquee bulbs).
- **Don't** put a small uppercase label above a section heading. Condensed caps are kept for diagram column labels and the Beta tag.
