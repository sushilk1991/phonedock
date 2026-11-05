# PhoneDock design guide

How the Mac app looks, reads and moves. Tokens and shared components live in
`app/Sources/PhoneDock/Theme.swift`; agent names, error copy and toasts live in `Feedback.swift`. Use the tokens.
Don't use color literals (`Color(red:…)`, `.orange`, `.purple`, `.green`) in views.

## Principles

1. **The device is the hero.** Chrome stays in the background. The device screen never moves, rescales or
   animates on its own.
2. **Show state, not plumbing.** No commands, IDs, ports, PIDs or config keys by default. Raw detail is one click
   away, under Details.
3. **Who's in control is always obvious.** Agent = purple + sparkles, you = indigo + person, needs you = orange +
   raised hand. Color is never the only signal.
4. **Native first.** System controls, materials, shortcuts and Liquid Glass. Custom UI only where PhoneDock means
   something the system can't express.
5. **Quiet until it matters.** No counters, fps or "Live" pills. Interrupt only when a person is needed.

## Color

Accent is **indigo**. Apply it once at the root with `.tint(Theme.Accent.fill)`. Use `Accent.fill` for fills and
selection, `Accent.text` for text and inline links (`.buttonStyle(.pdLink)`; the system `.link` style ignores the tint
and draws system blue). Segmented pickers keep the system's neutral selected segment (`.pdSegmented()`), as in the
approved mockups: an indigo-filled segment would be the loudest thing in the chrome.

### Surfaces, ink and lines

| Token | Light | Dark | Use |
|---|---|---|---|
| `Surface.window` | system `windowBackgroundColor` | system | chrome, inspector, sheets |
| `Surface.content` | system `controlBackgroundColor` | system | lists, form rows, code and log wells |
| `Surface.stage` | `#E8E8EC` | `#161618` | behind the device frame; the Settings panes |
| `Surface.card` | `#FFFFFF` | `#2A2A2D` | cards, glass fallback |
| `Ink.primary` | system `labelColor` | system | all primary text |
| `Ink.secondary` | `#5C5C61` | `#AEAEB2` | all secondary text (system secondary is below 4.5:1 on white). Sidebar rows keep system `.secondary`. With Increase Contrast: `#3A3A3E` / `#D1D1D6` |
| `Ink.tertiary` | system `tertiaryLabelColor` | system | placeholders, disabled, decorative only |
| `Ink.onFill` | white | white | text on accent, agent-strong and handoff-strong fills |
| `Line.separator` | system `separatorColor` | system | dividers |
| `Line.card` | black 8% | white 10% | card and floating-bar outlines (black 35% / white 40% with Increase Contrast) |
| `Accent.fill` | `#5856D6` | `#5E5CE6` | prominent buttons, selection |
| `Accent.text` | `#5856D6` | `#A5A3FF` | links, "you" text |

Sidebar, toolbar and inspector use system materials. Never give them custom backgrounds.

### Status

Every status pairs a color with a shape or symbol and a text label (`PDStatus.label`).

| Token | Light | Dark | Shape | Label |
|---|---|---|---|---|
| `Status.running` | `#248A3D` | `#30D158` | filled dot | Running |
| `Status.booting` | `#9A7B00` | `#FFD60A` | dot + expanding ring | Starting / Shutting down |
| `Ink.secondary` | `#5C5C61` | `#AEAEB2` | 1.5 pt ring | Off |
| `Status.error` · `errorText` | `#D70015` · `#C0000F` | `#FF453A` · `#FF6961` | filled dot | Needs attention |
| `Status.agent` · `agentText` | `#AF52DE` · `#7A2FA8` | `#BF5AF2` · `#D08CFF` | `sparkles` | Agent in control |
| `Status.agentStrong` · `agentTint` | `#7A2FA8` · `#E5DAEA` | `#8E44C8` · `#433749` | button fill · background | |
| `Status.human` | `#5856D6` | `#7D7AFF` | `person.fill` | You’re in control |
| `Status.handoff` · `handoffText` | `#C2410C` · `#9A3D00` | `#FF9F0A` · `#FF9F0A` | `hand.raised.fill` | Needs you |
| `Status.handoffStrong` · `handoffTint` | `#C2410C` · `#E7D7D1` | `#C2410C` · `#4B3F2D` | button/tile fill · background | |
| `Status.recording` | `#FF3B30` | `#FF453A` | static dot + timer | Recording |

Rules:
- Text tokens are chosen for at least 4.5:1 and status fills for 3:1 against the surfaces they sit on, in both
  appearances. `Ink.tertiary` is the exception and is decorative only.
- On a selected sidebar row, status dots get a 1 pt white halo (`StatusDot` does this).
- Never use system orange (`#FF9500`) as text in light mode, or white text on `#FF9F0A`.
- Recording and error share red; they differ by the timer. The timer is never red text.

### On the device and the frame

| Token | Value | Use |
|---|---|---|
| `Inspect.stroke` · `fill` · `halo` | `#FF2D92` · `#FF2D92` 14% · white 85% | UI-tree highlight: 2 pt stroke, 1 pt halo. The only chrome drawn on device pixels |
| `DeviceFrame.bezel` | `#0B0B0C` | bezel, 3.5% of width |
| `DeviceFrame.rim` | `#2C2C2E` / `#3A3A3E` | 1 pt rim |
| `DeviceFrame` corners | iOS 12%, Android 7% of width | continuous corners |
| `DeviceFrame.shadow` | black 18% / 50% | device elevation |
| `Elevation.card` | black 6% / none | card shadow (r2, y1) |
| `Elevation.float` | black 18% | floating-bar fallback shadow (r12, y4) |

## Type

macOS text styles only. Any number that changes in place uses monospaced digits. Nothing smaller than 10 pt.

| Token | Style | Size | Use |
|---|---|---|---|
| `Fonts.display` | `.title2` semibold | 17 | empty-state titles, stopped-device name |
| `Fonts.title` | `.title3` semibold | 15 | sheet titles, handoff reason |
| `Fonts.headline` | `.headline` | 13 bold | section headers, card and toast titles |
| `Fonts.body` | `.body` | 13 | default text, list titles |
| `Fonts.callout` | `.callout` | 12 | descriptions, banner meta |
| `Fonts.meta` | `.subheadline` | 11 | sidebar subtitles, secondary lines |
| `Fonts.caption` / `eyebrow` | `.caption` / semibold, uppercase, tracking 0.4 | 10 | footnotes, eyebrows |
| `Fonts.mono` / `monoSmall` | system monospaced | 11 / 10 | logs, UI tree, crash text / IDs, Details wells |
| `Fonts.numeric` | `.body` monospaced digits | 13 | sizes, counts, timers |
| `Fonts.countdown` | `.title2` rounded semibold, monospaced digits | 17 | handoff countdown |

## Spacing and radii

| `Theme.Space` | xxs | xs | s | m | l | xl | xxl | xxxl | windowTop |
|---|---|---|---|---|---|---|---|---|---|
| pt | 2 | 4 | 6 | 8 | 12 | 16 | 20 | 28 | 14 |

- `s` separates a label from its control. `l` is the gap around separators and the inspector padding. `xxl` is the
  window and sheet margin. `windowTop` sits below the toolbar.
- Radii (`Theme.Radius`): badge 4, control and well 6, card and toast 10, panel 14. Floating bars and pills are
  capsules. Always `.continuous` corners.
- The stage reserves `Theme.Stage.topSlot` (72 pt, room for a handoff reason on two lines) above the device and
  `bottomSlot` (56 pt) below it, so bars appearing or disappearing never move or rescale the screen. Bars in the top
  slot sit 8 pt above the device. On a stage narrower than `stackBelowWidth` (660 pt,
  e.g. the minimum window with sidebar and inspector open) the top slot is `topSlotStacked` (112 pt) so the handoff
  card can stack instead of truncating. The slot depends only on the stage width, never on what the bar shows.

## Components

**`StatusDot(status:)`** 8 pt. Filled for running, error, agent, human, handoff and recording; a ring for off; an
expanding ring while starting or shutting down (static under Reduce Motion). It carries its label as tooltip and
accessibility label.

**Cards (`.pdCard()`)** `Surface.card`, 1 pt `Line.card`, radius 10, `Elevation.card`. Opaque: status must stay
legible, and glass over a changing device screen flickers.

**`SectionHeader`** Headline title with small borderless actions on the right. Used for inspector sections. In Info,
a hairline (`Divider`, 12 pt above) separates Info, Snapshots and Advanced.

**Snapshot rows** Name and date, with **Restore…** always visible (small bordered). A hover-only button can't be found,
reached with Tab or read by VoiceOver. Delete… is in the row's context menu and is a VoiceOver action.

**Long operations (`AppModel.busy`)** Saving or restoring a snapshot and cloning take a device out of use for a while.
An iOS simulator shuts down and starts again. While one runs, the device shows what is happening instead of its
power state: "Saving snapshot…", "Restoring snapshot…" or "Cloning…". This appears in the sidebar subtitle, Info's
Status (with a small spinner), the Snapshots section and the stage, which shows an indeterminate bar rather than
Off + Start. Start, Shut Down, Delete…, Save…, Restore… and Clone… are off until it ends. The Save, Restore and Clone
prompts for a running iOS simulator add "‹name› shuts down while this runs, then starts again."

**Floating bar (`.pdFloatingBar()`)** A capsule in Liquid Glass on macOS 26 or later; `.regularMaterial` with a
0.5 pt `Line.card` outline and the float shadow on earlier versions. Used for the hardware bar, the stage top bar
and toasts. Never put glass or material over the device screen.

**Hardware bar** Floats in the bottom slot: Home, Back (Android only), App Switcher · Volume −, Volume +, Lock ·
Rotate. Hide what the device can't do instead of disabling it. Screenshot, Record, Open in Separate Window and
Power live in the toolbar. No fps anywhere.

**`StageTopBar(device:)`** Floats in the top slot and never overlaps device pixels. It fades in and out over
150 ms (instantly with Reduce Motion).

| State | Shows |
|---|---|
| Nobody in control | nothing (the slot stays empty) |
| An agent is in control | `sparkles` (`Status.agent`) · "Claude Code is in control" · **Take Over** (`agentStrong`, white text); tooltip "Since 14:02" |
| You hold the device (you took over from an agent; the app takes a device no other way) | `person.fill` (`Status.human`) · "You’re in control" · **Hand Back** (tooltip "Let Claude Code continue"; the agent's name is remembered across launches, since the daemon keeps your lease when the app quits) |
| Handoff pending | one-row card on `handoffTint` with a `handoffStrong` tile and `hand.raised.fill`. Top line: "**Claude Code needs you** · Asked 2 min ago" (callout; the name in `handoffText`, "· You’re in control" once you hold it); below it the reason (headline, up to two lines, full text in the tooltip). Then the countdown (`Fonts.countdown`, "left" when there's room), a note button (popover, optional note), **Take Over** (`agentStrong`, only if you don't hold it), **Can’t Do It**, **Done** (`handoffStrong`). Narrower one-row stages drop "left" and Take Over's icon first. On a stacked stage the card has two rows: tile, who/when and the reason (up to two lines) with the countdown; then the answers, trailing, with their words. "· Asked …" drops before the name is cut. Icons only on a stage far narrower than the minimum window gives |
| Handoff expired | "This request has ended" · **Dismiss** |

Never show that control changed or a handoff resolved until the service confirms it. Taking over is always an
explicit click; the first click on the screen during a handoff doesn't take over.

**Toolbar** Title = device name with subtitle "Pixel 9 · Android 16" · Power ▾ (Start, Shut Down; ⌥ Cold Boot) ·
Screenshot · Record · Open in Separate Window · Inspector toggle. The sidebar's own toolbar band holds only the
Sidebar toggle, at its trailing end (top right of the sidebar), mirroring the Inspector toggle; with the sidebar
hidden the system's toggle sits by the traffic lights. Adding lives in the sidebar too: **Add Device** at the foot of
the sidebar (as Reminders has Add List; laid out like a row, `plus.circle` in the 20 pt glyph column, secondary ink)
opens the Add menu: New Device…, Connect a Phone…, Connect an Agent…. It sits under the update card, so it never
moves. With the sidebar hidden, the same menu is ＋▾ in the main toolbar. A connection pill appears only when something is wrong ("Reconnecting…", or "Can’t connect to
PhoneDock" with Try Again). While recording: a static red dot and a ticking timer.
The inspector's own toolbar band holds the inspector tabs (icon-only segmented picker, as in the mockup) and, at
its trailing end, the Inspector toggle (top right of the window, as in Xcode). With the inspector hidden the toggle
is the last item of the main toolbar. When the detail column is narrower than 470 pt, Open in Separate Window
leaves the toolbar first (it stays in the Device menu and the sidebar context menu), so ＋ never falls into ».

**Deleting a device** Device › Delete… (⌘⌫), plain ⌫ in the focused sidebar, or the row's context menu all open the
one confirmation (Cancel is the default). ⌘⌫ still deletes to the start of the line while a text field is being
edited, and ⌫ beeps on a device PhoneDock doesn't manage.

**`ProblemView(problem:)`** The inline error card: triangle glyph in `Status.error`, headline title, callout body
in `Ink.secondary`, an optional Try Again, and Show Details revealing the raw text in a `monoSmall` well with a
copy button. Max width 420.

**Toasts (`ToastHost`)** A floating capsule in the stage's bottom slot (over the hardware bar, never over device
pixels), max width 520: kind glyph, title, a short message, an optional action, Copy Details, and a close button. It
dismisses itself after 4 s, or 8 s when it has an action ("Recording saved" stays 10 s). Kinds: error
(`Status.error`), success (`Status.running`), info (`Accent.text`).

**The alert (`.pdProblemAlert`)** Title, body, [Copy Details] [OK]. OK is the default button (Return). Only for a
blocking action the person started.

**Stale screen** If frames stop for more than 3 s or the stream is reconnecting, dim the screen slightly and show a
small "Reconnecting…" capsule over its top edge. Never show a stale screen as live.

**Software update (`UpdateSidebarItem`)** A small card pinned under the sidebar's list. It is there only while
there's something to say, so with no update the sidebar ends at its last row: there's no "Up to date" line, and that
answer goes in a toast after App menu › Check for Updates… or in Settings › General › Updates. The card's fill is
`.quaternary` (60%), with a `Line.card` hairline at 0.5 pt and `Radius.card`, inset 10 pt like the rows. It is quieter
than a device row, not a banner. Its states:
- **Available.** `arrow.down.circle.fill` in `Accent.fill` (the arrow on `onFill`). The body line is "PhoneDock 0.2.0"
  (just "0.2.0" when the column is narrow), with "Update available" in `meta` under it, and a small prominent
  **Update** button.
- **In progress.** "Downloading PhoneDock 0.2.0…" with a linear bar and the percentage (`meta`, monospaced digits), and
  a small × to stop. Then "Installing…" and "Restarting PhoneDock…", with **Restart Now** if quitting stalls.
- **A problem.** `exclamationmark.triangle.fill` in `Status.error`, the title in plain words ("Couldn’t verify the
  update"), one `meta` sentence, **Try Again**, and the same small × to dismiss it. The raw error is in the tooltip
  and in Copy Details.

It slides up from the bottom edge (opacity only with Reduce Motion). A check someone started from the menu shows
"Checking for updates…" in the same card. Background checks never show anything until they find an update.

**Reserved symbols** `sparkles` means an agent and nothing else. `person.fill` = you, `hand.raised.fill` = needs
you, `exclamationmark.triangle.fill` = an error, `exclamationmark.octagon` = crashes. Use only SF Symbols that
already exist; a misspelled name renders nothing.

## Settings

The Settings window (⌘,, `SettingsView.swift`) keeps the system's toolbar tabs, 560 pt wide: **General**
(`gearshape`), **Agents** (`sparkles`: it is about agents) and **Advanced** (`gearshape.2`). The selected tab takes
the bundle's indigo accent (when the system accent is Multicolor). Everything under the toolbar is built from the main window's parts, so the two windows
read as one product:

- **The pane is the stage.** Each tab is a column on `Surface.stage` with the window margins (`xxl` at the sides and
  bottom, `windowTop` under the toolbar) and `xxl` between sections. Cards sit on it as on the main window's stage,
  in light and dark. The window takes the column's height, so each tab fits its content; past the room on screen
  the column scrolls and a fade marks the bottom edge. No fixed heights.
- **`SettingsSection(title, note:)`** A headline title (with an optional trailing accessory) `m` above its card, and
  an optional callout note in `Ink.secondary` under it. Title and note line up with the text inside the rows (`l` in).
- **`SettingsCard`** `.pdCard(padding: 0)` with a hairline between rows, inset `l`, like the agent list in Connect an
  Agent. Never a stock grouped `Form`: its grey boxes don't match the main window.
- **`SettingsRow(title, detail:) { control }`** Body title, one callout sentence in `Ink.secondary` under it, the
  control at the trailing edge, vertically centred; at least 40 pt tall. Toggles are switches whose label is the
  row's title. Buttons are text only.
- **Status headline (`SettingsStatusHeadline`)** The first row of a card that reports health: a `display`-size glyph,
  the state in words as a headline ("Running", "Everything is ready", "Ready" with "Optional: Corellium cloud isn’t
  set up."), and a `meta` line of detail ("Version 0.1.0 · Started by PhoneDock"). State words, not counts: a missing
  Beta or Experimental extra doesn't make PhoneDock less ready. Glyphs: `checkmark.circle.fill` in `Status.running`
  (ready), a small spinner (working), `exclamationmark.triangle.fill` in `Status.error` (a problem, with Try Again),
  `circle.dashed` in `Ink.secondary` (not set up: neutral, since the remedy may be a token rather than a download),
  `arrow.down.circle.fill` in `Accent.fill` (an update to install: the sidebar update item's glyph).
  A row's own state sits at its trailing edge as `SettingsStateLabel`: the glyph in its colour and the word in
  `Ink.secondary` ("✓ Ready", "✓ Connected", "Not set up").
- **Detail stays one click away.** Device support lists every kind of device (sidebar glyph, name, Beta badge,
  state) under Show Details, with the service's hints under How to Set Up. Agents keeps the copyable commands
  under Set Up by Hand. A problem is a full-width `ProblemView` next to the card it belongs to, never inside one.

| Tab | Sections |
|---|---|
| General | Notifications (Notify me when an agent needs help; a note that the Dock badge shows either way) · Startup (Open at login) · Updates, last: a status headline ("Up to date" with "You have 0.1.0 (1000) · Checked 2 minutes ago", "PhoneDock 0.2.0 is available" with Update, progress, or the problem with Try Again; before any check this session, a plain row with the version and when it last checked) with Check Now, then Check for updates automatically |
| Agents | Coding agents: Set Up… and each agent's state from setup's dry run · Set Up by Hand |
| Advanced | Background service: status, Restart Service…, Data folder, Diagnostics · Device support: one summary line, Show Details · Wi-Fi phones: the Local Network warning, then Check, which tries the phone's address with the app's Local Network permission and says what's in the way (a success says so when the running service is still blocked) |

## Copy

1. Sentence case for descriptions; Title Case for buttons, menu items and window titles. Curly quotes and
   apostrophes (“ ” ’).
2. Never show commands, flags, paths, PIDs, ports, HTTP statuses, error codes or config keys in primary copy.
   They go under Details or Copy Details.
3. Name things the way people do: Simulator, Emulator, iPhone, Android phone, PhoneDock. "Daemon" appears only in
   Settings › Advanced and the docs.
4. Buttons are verbs: Start, Shut Down, Take Over, Hand Back, Connect, Create. Add an ellipsis only when more input
   follows.
5. One sentence per description, at most two hints. No "Something went wrong", "Error:", "Please" or
   exclamation marks.
6. Show state words, not counts, unless the count helps a decision.
7. Real iPhones are labelled **Beta**: in Connect a Phone, in the sidebar subtitle ("iOS 27 · Beta") and in
   Info (a Beta badge). On iOS 27 or later they work without WebDriverAgent; never say an iPhone needs it unless it
   runs older iOS.

### The error pattern

- **Title**: what happened, in plain words. "Couldn’t start Pixel 9".
- **Body**: what to do next. "Try a cold boot from the Power menu."
- **Details**: the raw message, hints and code, behind Show Details or Copy Details.

Where it appears:
- Inline, where it happened (sheet, screen, inspector tab): `ProblemView`.
- A toast for one-off actions (key press, rotate, launch, lease conflict): `model.fail(title, error, device:)`.
- The alert only for blocking actions the person started: create, delete, connect, restart, install, restore and
  clone (`blocking: true`).
- Background polling never alerts.

`FriendlyError.from(_:title:device:)` builds the body from the service's error code (lease conflict, not
supported, timeout, boot failure, missing image, needs a person), falling back to the first hint.

Empty states say what's true: "Select a Device", "No Devices Yet" (with New Device…, Connect a Phone… and
Connect an Agent…), "No apps found", "No snapshots yet", "Refresh to inspect the screen", "No logs yet",
"No activity yet", "No crashes". When a feature can't work on a device, say so: "Crash reports aren’t available
for this device". Confirm before Restore (it replaces the current state) and before Delete.

## Agent names

Never show a raw owner string. Use `OwnerName.display(_)`, `device.controllerName` and
`handoff.requesterName`.

| Owner | Shown as |
|---|---|
| `mcp:claude-code:*` | Claude Code |
| `mcp:codex*:*` | Codex |
| other known MCP clients | Cursor, Windsurf, Gemini CLI, GitHub Copilot, VS Code, Zed |
| `mcp:<name>:*` | `<name>`, title-cased |
| `cli:*` | Terminal |
| `sdk:*` | A script |
| this app's own owner | You |
| other `app:*` owners | PhoneDock |
| missing or empty | An agent |

Activity reads as sentences grouped by actor: "Claude Code tapped Settings · 14:02". Group glyphs: `sparkles` for
agents, `person.fill` for you, `terminal` for Terminal and `curlybraces` for scripts.

## Motion

| What | Token | Reduce Motion |
|---|---|---|
| Hover, press, disclosure, Details | `Motion.quick` (0.12 s ease-out); expand with `Motion.expand { }` | instant for expanding content |
| Toasts, banners | `Motion.standard` (0.22 s snappy), move + opacity | opacity only |
| Slower, non-urgent changes | `Motion.gentle` (0.30 s smooth) | opacity only |
| Stage top bar | 150 ms opacity | none |
| Starting / shutting-down ring | 1.1 s ease-out loop | static |

Wrap decorative animation in `Motion.decorative(_:reduceMotion:)`, which returns nil under Reduce Motion.

Never animate:
- The device screen, frame or bezel. Put `.transaction { $0.animation = nil }` on the stage, and no `.animation`
  modifier on any container that holds it.
- Frame swaps (no crossfade), log appends or inspector tab switches.
- Sidebar order. Rows sort by name only and never jump when state changes.
- Countdown and recording digits.

Keep the main actor light: decode images off-main, allocate no formatters or regexes in `body`, and stop timers
when a view is hidden.
