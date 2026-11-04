# Product

<!-- impeccable:product-schema 1 -->

> Inferred, not interviewed: written by a build agent from the lead's brief, README.md, docs/AGENTS-GUIDE.md and the
> launch notes. Every line below is sourced from those; nothing was confirmed with the user in an interview.

## Platform

web

## Stack

Public landing page: plain static HTML/CSS/JS in `site/`, Three.js vendored as an ES module, deployed to GitHub Pages
under `/phonedock/` (pinned by the brief). The product itself is a native macOS app (SwiftUI) plus a local Node
service; its own design guide is `design/DESIGN.md`.

## Users

Developers who already work with coding agents (Claude Code, Codex, Cursor, Pi, any MCP client) on a Mac. They want
their agent to operate a phone: to run their own phone automations, to research through an agent on a phone, and to
test the apps they build, including in CI.

## Product Purpose

PhoneDock is an open-source Mac app plus a local service that gives coding agents real phones: Android emulators,
iOS simulators, real Android phones over Wi-Fi, and real iPhones (beta, iOS 27, over Wi-Fi with no app on the phone).
The person watches every device live in a native Mac app and can step in at any moment.

## Positioning

The live view and the handoff: when the agent hits Face ID, a password or a CAPTCHA it asks for help, the person
presses Take Over, does the step, presses Done, and the agent continues. We couldn't find another tool with a human
handoff request flow for mobile; never claim none exists. Coverage of the four targets alone is not distinctive
(mobile-mcp, agent-device, SimMirror cover them); the combination of coverage, native live viewer and handoff is.

## Operating Context

- Setup is one command: `phonedock setup` registers the MCP server with every agent it finds and installs the agent
  skill.
- A session can be saved as a YAML flow and run in CI with `phonedock test` (JUnit, failure screenshots), or exported
  to Maestro.
- Leases keep agents (and the person) from colliding on one device.

## Capabilities and Constraints

- macOS only (macOS 15 or later). iPhone simulators need Xcode; Android needs the Android SDK.
- Real iPhone support is beta. On iOS 27+, one app at a time can show an iPhone's screen.
- Local: the service listens on 127.0.0.1, no telemetry. The agent's model provider still sees what the agent sends it
  (screenshots, UI text). Say so plainly.
- Apache-2.0. Repo: https://github.com/sushilk1991/phonedock. Download: the latest GitHub release (`.dmg`, signed and
  notarized).

## Brand Commitments

- Name: PhoneDock. Accent indigo `#5856D6` (light) / `#5E5CE6` (dark), from the app's AccentColor asset.
- App icon: indigo squircle, glass dock cradle holding a dark phone with the agent sparkle on its screen
  (`app/Sources/PhoneDock/AppIcon.swift`).
- In-app control language: agent = purple + sparkles, you = indigo + person, needs you = orange + raised hand. Real
  iPhones are labelled Beta.
- Voice: plain, specific, sentence case, no hype, no exclamation marks, no "only/first" claims.

## Evidence on Hand

- Real product footage is being captured from clean test devices into a media kit; only files marked final and
  privacy-scan passed may ship.
- No testimonials, users, stars, benchmarks or press exist yet. Do not fabricate any.

## Product Principles

1. The device is the hero; chrome stays quiet.
2. Who is in control is always obvious.
3. Show the mechanism, don't claim it.
4. State limits as plainly as features.

## Accessibility & Inclusion

WCAG 2.2 AA contrast, keyboard focus, alt text, semantic HTML, and a full reduced-motion path.
