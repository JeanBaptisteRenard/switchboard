# 0002 — Steady-state indicator animations must be discrete (`steps()`), never smooth 60fps

**Status**: Accepted (2026-08-19)

## Context

After #122 removed the hidden-terminal parse/draw load, the app still burned
~23% renderer / ~27% GPU of a core at idle with busy sessions in the sidebar.
Per-thread `/proc` profiling showed the remainder was style/paint on the
renderer main thread plus continuous compositing — not terminal work. The
cause was the sidebar (and grid) status indicators: every steady-state
indicator was a smooth `infinite` CSS animation running at 60fps.

Measured costs on 2026-08-19 (isolated dev instance, 8 marked items,
30s `/proc` stat deltas, over an 8.6% renderer / 1.4% GPU baseline —
method in [testing-a-pr.md](../testing-a-pr.md#measuring-cpu-and-driving-the-ui)):

| Effect | Renderer | GPU |
|---|---|---|
| busy shimmer (`background-position` + `background-clip: text`, 60fps) | +45% | +71% |
| busy spinner (rotating border, `transform`, 60fps) | +20% | +38% |
| needs-attention ripple (2 expanding rings, 60fps) | +33% | +44% |
| smooth opacity fade, 60fps | ~0% | **+27%** |
| stepped shimmer, `steps(30)` = 10fps | +14% | +10% |
| discrete effects at 1–12 changes/s (`steps()`) | +1–9% | +1–9% |

Two distinct cost mechanisms:

1. **Main-thread repaint** — `background-position` with `background-clip: text`
   (and any non-composited property) repaints the element every frame on the
   renderer main thread. This is the shimmer's +45%.
2. **The compositing floor** — even a fully composited property (opacity,
   transform) forces the GPU process to re-composite every frame. On the
   reference machine that floor is ~27% of a core for ANY smooth 60fps
   animation, regardless of how small the animated element is. There is no
   "cheap" smooth infinite animation.

Frame-rate reduction via `steps()` was tried on the shimmer first
(`steps(30)`, then `steps(15)`): the cost drops roughly linearly with the
step rate, but a *moving gradient* looks visibly broken below 60fps —
rejected on looks. The way out is effects that are **discrete by nature**,
where the stepping IS the aesthetic.

## Decision

**No steady-state (`infinite`) animation may run smoothly at 60fps.**
Steady-state indicators use discrete `steps()` animations at a few changes
per second, and the effect is chosen so that stepping looks intentional:

- **Busy dot** → a braille spinner (`content` keyframes ⠋⠙⠹…, `steps(1)`,
  12.5 changes/s) — mirrors the CLI's own spinner, so the terminal-style
  discreteness reads as native.
- **Busy summary text** → static light-blue tint (`#7fd4f9`), no animation.
  Replaces the animated shimmer; color alone carries the "busy" identity.
- **Needs-attention dot** → 1Hz LED blink (`steps(1)` opacity) + a *static*
  halo (`box-shadow`) that keeps the old ripple's visual weight for free.
- **Group / grid running dots** → the existing `pulse-dot` keyframes with
  `steps(4)` timing instead of `ease-in-out`.

Transient animations (loading spinners, refresh buttons, toasts) may stay
smooth: they run for seconds, not for the lifetime of a session.

Rejected alternatives:

- **Smooth opacity fade** — renderer-free but pays the +27% compositing
  floor forever; rejected.
- **Stepped shimmer / stepped fade** — cheap but visibly janky for
  continuous-motion effects; rejected on looks.
- **Animated ellipsis / blinking caret** — cheap and thematically fine, but
  rejected on looks after a live side-by-side.
- **Compositor-friendly shimmer rewrite** (`transform` overlay + mask) —
  keeps 60fps fluidity but still pays the compositing floor, for a
  peripheral indicator; not worth it.

## Consequences

- Adding a new indicator? Default to a static style or a `steps()` effect
  at ≤ a few changes/s. A smooth `infinite` animation needs a measured
  justification in the PR.
- `grep -n 'animation:.*infinite' public/style.css` is the audit: every hit
  must be either `steps()` or a transient (loading/refresh) state.
- The old effects (shimmer, rotating border, ripple) are gone from
  `style.css`; this ADR is the record of why they must not come back on a
  "polish" pass.
