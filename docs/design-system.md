# MORROW design system

> A sophisticated computational environment that happens to be living inside your computer.

Source of truth: `packages/design-system/src`. Primitives: `packages/ui/src`.
Tokens are defined in TypeScript and emitted at build time as CSS custom properties
(`--m-*`) through the Vite module `virtual:morrow-tokens.css`. They are never injected
at runtime, because the desktop CSP blocks runtime `<style>` elements (D62). Components
reference tokens only.

## Principle

The interface communicates state through structure, not decoration. Every element
must communicate identity, communicate state, improve comprehension, or establish
atmosphere — otherwise it does not exist.

## Colour

Near-black charcoal foundation (never `#000`), warm off-white text, **one** restrained
identity accent, and state colours that carry meaning only.

| Token | Value | Use |
|---|---|---|
| `background-deep` | `#08090a` | Behind the environment |
| `background` | `#0d0e10` | Base |
| `surface` / `surface-raised` / `surface-inset` | `#121316` / `#17191c` / `#0a0b0c` | Architectural planes; inset = recessed |
| `border` / `border-subtle` / `border-strong` | `#272a2f` / `#1b1d21` / `#383c43` | Structure lines |
| `text-primary` / `secondary` / `muted` / `disabled` | `#e6e3dc` / `#a8a59e` / `#72706a` / `#46453f` | Text hierarchy |
| `accent` | `#c9b58a` (pale brass) | MORROW's own presence: focus, the active section, primary intent |
| `success` / `warning` / `error` / `info` | `#8fae8b` / `#d49a5a` / `#d0706a` / `#8aa4bf` | State only |
| `glass` / `glass-raised` / `glass-deep` | 0.58 / 0.72 / 0.62 alpha | Translucent material (see Material) |
| `hairline` / `wash` / `scrim` | | Top-edge light, hover wash, vignette |
| `smoke` / `smoke-deep` / `floor-lift` | `#7c8089` / `#545862` / `#16181b` | The environment only |

## Typography

IBM Plex Sans for readable content; IBM Plex Mono for identifiers, timestamps,
metadata and the structural "label" register (uppercase, tracked). Fonts are bundled
via `@fontsource` so MORROW renders identically offline.

Scale: `micro 10.5 · label 11 · meta 11.5 · bodySmall 12.5 · body 13.5 · bodyLarge 15 ·
title 17 · heading 21 · display 28` (display is the tracked mono wordmark register — no
marketing-scale type).

## Geometry

Radii: `xs 2 · sm 3 · md 4` for controls, and `lg 6 · xl 10` only for the planes content
sits on. Within a plane, structure is 1px lines: lists are rows divided by rules, not
stacks of cards. State marks are small squares, not glowing dots.

Sizes: controls `28 / 32 / 40px`, icons `14 / 16 / 20px`. Shell layout: rail `72px`,
presence bar `48px`, side panel `300px`, reading column `760px`, content `1120px`.

## Material and depth

Restrained glass: translucent planes over the environment with an 18px backdrop blur
(28px for overlays). There are no frosted slabs, and glass alpha stays between 0.4 and
0.8 (tested).

| Material | Use |
|---|---|
| `glass` | Panels: view sections, the task history, the home panels |
| `glass-raised` | What sits forward: the command field, decisions waiting on you, the notice |
| `glass-deep` | The shell itself (rail, presence bar) and recessed wells |

Elevation `e0–e3` pairs an outer shadow with an inset 1px top highlight, so a plane
catches light at its edge. `inset` is for recessed fields.

## Icons

`packages/ui/src/icons.tsx`: one family on a 20-unit grid, 1.3 stroke, square caps,
mitred joins. Icons inherit colour and are always paired with a name, or carry an
accessible label (`IconButton` requires one). There is one icon per product concept:
the six sections, task, permission, capability, runtime, the panel toggle, and a few
controls. There are no decorative icons.

## Controls and states

- **Buttons.** `primary` (brass, one per context), `secondary`, `ghost`, `danger`, in
  sizes `sm` and `md`. `IconButton` is for icon-only actions, and `aria-pressed` turns
  it brass.
- **Focus.** One focus ring everywhere: a 1px accent line, visible only for keyboard
  focus.
- **Loading.** `Progress` is a thin indeterminate line, shown only while a real request
  is in flight. It stops under reduced motion.
- **Empty.** `EmptyState` says what is absent and why.
- **Error.** `ErrorState` says what failed and why, when known.
- **Count.** Renders nothing at zero.

## Motion — "MORROW doesn't animate. MORROW behaves."

All motion comes from six semantic categories (`motion.ts`):

| Category | Duration | For |
|---|---|---|
| INSTANT | 0 | State that must read immediately |
| FAST | 90ms | Hover/press/focus feedback |
| SHORT | 160ms | Small reveals, status changes |
| MEDIUM | 280ms | View changes, panels |
| LONG | 520ms | Environment responding to state |
| AMBIENT | 24s | Near-imperceptible drift |

Motion is **state-driven** (it happens because state changed), **interruptible**
(CSS transitions retarget mid-flight), and **reduced-motion aware**: under
`prefers-reduced-motion` durations collapse and all ambient/looping animation stops.

## Shell

`apps/desktop/src/shell`, decision D64:

- **Rail.** The identity, then the work sections, then (at the bottom) what MORROW works
  with. The active section has a brass edge, and its only badge is the decisions
  waiting on you.
- **Presence bar.** On the left, where you are (the section, plus the open task and its
  status). In the centre, one presence derived from real state (`runtime/presence.ts`,
  D65). On the right, the facts: decisions, open tasks, model, runtime. Each fact shows
  only when it applies and leads to where it is acted on.
- **Stage.** Sections render here. Secondary views are a column of glass panels, under
  a header with the section glyph, title and purpose.
- **Notice.** The last failed action, as a raised plane at the top of the stage.

The native window frame is kept (D66).

## Environment

`apps/desktop/src/environment`. Layers, back to front: deep base → distant structure
(a floor plane receding to a faint horizon) → far fog banks → a slow rising smoke → a
near fog pooled at the floor → a single distant warm light → film-grain texture →
vignette. All sit a few percent above the base, and their colours are tokens.

The environment's only input is the **ambient state**, derived from real runtime state
(`runtime/ambient.ts`):

| State | Trigger (real task status) | Behaviour |
|---|---|---|
| IDLE | nothing open | slow drift, lowest illumination |
| LISTENING | composing an objective, or a task is AWAITING_PERMISSION | fog thins, light rises slightly |
| PLANNING | a task is PLANNING | structure converges toward the focal point |
| EXECUTING | a task is EXECUTING / OBSERVING | the floor gains direction (slow forward flow) |
| WAITING | a task is WAITING (e.g. no model) | dimmer, slower |
| VERIFYING | a task is VERIFYING | gathered and still |
| RECOVERING | a task is RECOVERING | partial convergence, slight flow |
| COMPLETED | a task completed (transient, 2.4s) | settles |
| FAILED | a task or tool failed (transient, 1.4s) | brief destabilisation, then recovery |

With several tasks open, active work takes precedence: EXECUTING, then RECOVERING,
then VERIFYING, then PLANNING, then LISTENING, then WAITING.

## Task workspace

- **Idle.** Decisions waiting on you, the command field, then what is in progress and
  the five most recent tasks, then capabilities beside standing permissions. Being able
  to is not being allowed to. Each part appears only when there is something real to
  show.
- **Task open.** The selected task's live view, with the command field docked below
  it. Closing the view returns to idle.
- **Task history.** A glass panel of the 40 newest tasks, toggled from the presence bar.
- **Structure through lines, not cards.** Plan steps, checks and artifacts are rows
  separated by rules. The activity timeline is a single vertical line with small
  state marks, and tool calls expand in place using native `<details>`.
- **Decisions awaiting the user** (permission requests, memory proposals) are the only
  bordered planes. They carry a brass edge, because MORROW is waiting on you.
- **The active step** is marked with a brass rule and its step number.
- **Mono** is used for identifiers, times, capabilities, tool ids and observation content.
- **Verification** labels every check as either *checked by MORROW* or *judged by the
  model*, so model judgement is never presented as objective fact.

Parameters are registered CSS properties (`@property`) so they interpolate over LONG.

## Identity

The mark in the rail and the app icon are **placeholders** (a frame with a horizon
line, `assets/brand/placeholder-mark.svg`). They are intentionally plain and must be
replaced by a real MORROW mark.

## Avoid

Cyberpunk, RGB, neon, crypto styling, giant gradients, heavy (frosted, opaque-white)
glass, rounded cards everywhere, dashboard grids and widgets, hacker-movie effects,
greeting copy, and any element that does not correspond to real state or a real product
concept.
