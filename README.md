# Ensemble Generator Plugin

A [Signals & Sorcery](https://signalsandsorcery.com) plugin for jointly-composed counterpoint — describe one passage and get **2–6 voices composed together**, from a florid top line down to a sparse root-note anchor, each on its own Surge XT track.

<p align="center">
  <img src="assets/signals-and-sorcery.png" alt="Signals & Sorcery" width="420" />
</p>

> Part of the **[Signals & Sorcery](https://signalsandsorcery.com)** ecosystem.

## What it does

- One prompt ("solemn rising passage, modern baroque", "3 voices, misty counterpoint") composes ALL voices in a **single schema-forced LLM call** — the lines are planned together (imitation, staggered entrances, contrary motion), not generated one-by-one and hoped into harmony
- **A register + complexity hierarchy, enforced as data**: the top voice is the highest-pitched and most florid; complexity decreases with register; at 5-6 voices the bottom is an 808-register anchor playing **only each bar's chord root**
- A **mechanical validator** (not the LLM) enforces the hard contract per voice — register octave-fold, root pinning, in-key snap with chord-tone exemptions, per-voice monophony (voices overlap each other; that's the counterpoint), density caps
- **Style packs decide the soft rules**: `counterpoint` (parallel 5ths/8ves and voice crossings are defects, independence required), `chorale` (homorhythmic block harmony), `interlock` (meshing ostinato cells — parallels welcome). Violations earn ONE guided retry
- The voices land as **one voice-group**: the anchor row carries the prompt; the header adds voice-count (2–6) and style controls; any row's Generate regenerates the whole ensemble
- Each voice's Surge XT preset is chosen mechanically from its stamped role + actual register (`Strings-hi/low`, `Leads`, …); regeneration reconciles the group and **never replaces a sound you picked**
- Sees the rest of the scene (drums, existing synths) through the shared concurrent-tracks context, so the ensemble interlocks with the mix instead of talking over it

## The hierarchy

| Voice | Role | Register | Density | Discipline |
|---|---|---|---|---|
| top | lead | 72–96 | ≤8/bar | most florid; non-chord tones as passing/neighbor tones |
| … | strings | descending | descending | chord tones, smooth stepwise motion |
| bottom (5+) | 808s | 24–43 | ≤2/bar | **root pitch class only** |

## Install

From within Signals & Sorcery: **Settings > Manage Plugins > Add Plugin** and enter:

```
https://github.com/shiehn/sas-ensemble-plugin
```

Or clone manually into `~/.signals-and-sorcery/plugins/@signalsandsorcery/ensemble-generator/`.

## Capabilities

| Capability | Required |
|------------|----------|
| `requiresLLM` | Yes - joint multi-voice composition (schema-forced function calling) |
| `requiresSurgeXT` | Yes - per-voice synth preset loading |

## Dev

```bash
npm install
npm test        # jest — meta/reconcile, music helpers, ensemble-core behavior, the generation brain
npm run build   # tsup → dist (the app consumes dist via file: dep)
```

Requires `@signalsandsorcery/plugin-sdk` ≥ 2.42.0 (`ensemble-core`: voice specs, hard per-voice enforcement, soft cross-voice analysis, the `submit_ensemble` schema, the joint prompt).
