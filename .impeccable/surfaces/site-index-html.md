---
version: 1
slug: "site-index-html"
primary_target: "site/index.html"
related_targets: []
---

Scope: public landing page, site/index.html (GitHub Pages, /phonedock/). Visitor mode: Persuade.
Audience: Mac developers who already run coding agents. Action: download the app; visit GitHub; copy `phonedock setup`.
Proof on hand: real screen recordings of Claude Code driving a real Android phone through PhoneDock (Google search, Play Store reviews, YouTube) with their real tool calls and answers; the real iPhone Instagram clip; the real handoff recording of the Mac app. AI stills (desk, five phones, face scan) are mood only and are disclosed in the footer. No testimonials, stars or benchmarks exist.
Constraints (pinned by the owner, v3): no hand-built fake UI. The Three.js stage, its drawn screens and the CSS handsets with mock screens are gone. Lead with use cases. Every claim about what the agent did is shown with real footage. Never show or name the phone's brand or model. Instagram only 0-23 s. Copy stays plain; no "X, not Y" lines; no bot-detection claims. Fast: first view under about 3 MB.
Unattended: built by a subagent from the lead's brief; no question round was possible. Direction pinned by the brief, so no roll; code-led.

## Direction contract

THESIS: Show the agent doing the job. A real phone plays real recordings while a terminal card beside it prints the agent's real calls in sync and ends on its real answer. It refuses the category page: a gradient hero with a drawn terminal and a mock phone over feature cards.

OWN-WORLD: The incumbent tokens stay: indigo accent, agent purple / you indigo / needs-you orange as state only, Archivo wide and heavy for display, JetBrains Mono only for calls and commands, cue-light keys. Show bands are dark in both themes: the hero over a defocused night-desk photograph with grain, the use-case reel and the handoff band. The device is a plain black slab with no brand marks. The agent card is the site's own dark mono card titled Claude Code, with a lamp, a clock that shows the recording's real time, and a progress rail per task.

STORY: Within a second the visitor sees a real phone being driven. They read the prompt, watch calls land as the screen changes, and read the answer. Then four real tasks side by side, the handoff, the devices, flows, setup, limits, download.

FIRST VIEWPORT: Copy top-left (headline, use-case-first sub, Download and GitHub keys, facts line). Right: the phone at about 70vh, and between them the agent card with three task tabs. Dark photo ground with a left scrim. On mobile: copy, then phone with the card under it.

FORM: Pinned by the brief (real-footage demo reel with a synced agent card). seed: none (pinned by the brief, no roll)

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, docs/site/DESIGN.md, and every shipping raster carrying its provenance
