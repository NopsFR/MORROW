# MORROW design system

> A sophisticated computational environment that happens to be living inside your computer.

Source of truth: `packages/design-system/src`. Primitives: `packages/ui/src`.
Tokens are defined in TypeScript and installed as CSS custom properties (`--m-*`)
before first render (`installTokens`). Components reference tokens only.

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

## Typography

IBM Plex Sans for readable content; IBM Plex Mono for identifiers, timestamps,
metadata and the structural "label" register (uppercase, tracked). Fonts are bundled
via `@fontsource` so MORROW renders identically offline.

Scale: `micro 10.5 · label 11 · meta 11.5 · bodySmall 12.5 · body 13.5 · bodyLarge 15 ·
title 17 · heading 21 · display 28` (display is the tracked mono wordmark register — no
marketing-scale type).

## Geometry

Radii `0 / 2 / 3 / 4px`. Surfaces are planes separated by 1px lines; lists are rows
divided by rules, not stacks of cards. State marks are small squares, not glowing dots.
Focus is a 1px accent line.

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

## Environment

`apps/desktop/src/environment`. Layers, back to front: deep base → distant structure
(a floor plane receding to a faint horizon) → fog banks → a single distant warm light
→ film-grain texture → vignette. All sit a few percent above the base.

The environment's only input is the **ambient state**, derived from real runtime state
(`runtime/ambient.ts`):

| State | Trigger | Behaviour |
|---|---|---|
| IDLE | nothing active | slow drift, lowest illumination |
| LISTENING | composing an objective, or MORROW awaiting a permission decision | fog thins, light rises slightly |
| THINKING | a task is PLANNING / VERIFYING / RECOVERING | structure converges toward the focal point |
| EXECUTING | a task is EXECUTING / OBSERVING | the floor gains direction (slow forward flow) |
| ERROR | a task or tool failed (transient, 1.4s) | brief destabilisation, then recovery |
| COMPLETED | a task completed (transient, 2.4s) | settles |

Parameters are registered CSS properties (`@property`) so they interpolate over LONG.

## Identity

The mark in the rail and the app icon are **placeholders** (a frame with a horizon
line, `assets/brand/placeholder-mark.svg`). They are intentionally plain and must be
replaced by a real MORROW mark.

## Avoid

Cyberpunk, RGB, neon, crypto styling, giant gradients, heavy glass, rounded cards
everywhere, dashboard grids, hacker-movie effects, greeting copy.
