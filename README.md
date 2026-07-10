# @signalsandsorcery/ensemble-generator

Ensemble arranger for Signals & Sorcery: one prompt becomes **2–6 voices
composed together** — a single schema-forced LLM call (`submit_ensemble`
function calling) plans all lines jointly, then the SDK's `ensemble-core`
mechanical layer enforces the hard contract per voice and reports soft
style violations (one guided retry).

## The hierarchy (the product intent, as data)

| Voice | Role | Register | Density | Discipline |
|---|---|---|---|---|
| top | lead | 72–96 | ≤8/bar | most florid; NCTs as passing tones |
| … | strings | descending | descending | chord tones, smooth motion |
| bottom (5+) | 808s | 24–43 | ≤2/bar | **root pitch class only** |

Styles: `counterpoint` (default), `chorale`, `interlock` — style picks which
soft rules count (parallel 5ths/8ves, voice crossing, onset independence).

## Shape

Bass-plugin lifecycle, verbatim: one voice-group per ensemble (anchor =
voice 0 carries the prompt; header adds voice-count + style controls,
persisted in `track:<anchorDbId>:ensembleConfig`); positional reconcile on
regenerate (reused voices keep the user's presets); clips before presets;
metas last; LIFO rollback. Per-voice sounds are mechanical: stamped roles +
actual register drive `shufflePreset` (`Strings-hi/low`, `Leads`, …).

Any voice row's Generate regenerates the whole ensemble from the anchor's
prompt — an ensemble is one component, not N independent tracks.

## Dev

```bash
npm install
npm test        # jest (meta/reconcile, music helpers, ensemble-core, the brain)
npm run build   # tsup → dist (the app consumes dist via file: dep)
```
