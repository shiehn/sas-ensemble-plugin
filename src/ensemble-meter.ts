/**
 * Plugin-local meter layer over the SDK's ensemble-core (P8b
 * multi-time-signature).
 *
 * ensemble-core (SDK 2.50.0) is meter-UNAWARE: `buildEnsembleSystemPrompt`
 * carries no meter text and `enforceVoice` hard-codes the 4-qn bar
 * (clip clamp, per-bar chord attribution, per-bar density thinning). The
 * P8a SDK branch is frozen, so this module supplies the meter behavior
 * PLUGIN-side:
 *
 *   - `buildEnsembleSystemPromptWithMeter` — the SDK prompt verbatim, plus
 *     the SDK's per-family meter rules APPENDED when the scene meter is not
 *     4/4 (formatPluginMeterGuidance returns '' for 4/4/unparseable — the
 *     byte-identity contract, pinned in __tests__/meter-prompt.test.ts).
 *   - `enforceVoiceMetered` — delegates to the SDK's `enforceVoice`
 *     UNCHANGED for 4-qn bars (the legacy path stays byte-identical), and
 *     runs a faithful meter-parameterized mirror of the same six-step
 *     pipeline for every other meter. The mirror is parity-pinned against
 *     the SDK at qnPerBar=4 (ensemble-meter.test.ts), so upstream drift in
 *     enforce-voice breaks tests here instead of silently forking.
 *
 * DEFERRED (SDK follow-up): fold the meter parameter into ensemble-core
 * itself (EnforceVoiceOptions.quarterNotesPerBar + a meter arg on the
 * prompt builder) in the next SDK minor, then delete the mirror below.
 * Instrumentation modes and counterpoint/section rules are deliberately
 * untouched — only the TIME arithmetic generalizes.
 */

import {
  MIN_NOTE_DURATION_BEATS,
  buildEnsembleSystemPrompt,
  enforceVoice,
  foldPitchToRegister,
  formatPluginMeterGuidance,
  nearestPitchWithPc,
  type EnforceVoiceOptions,
  type EnforceVoiceResult,
  type EnsembleInstrumentation,
  type EnsembleNote,
  type EnsembleStyle,
  type EnsembleVoiceSpec,
} from '@signalsandsorcery/plugin-sdk';

/**
 * The SDK system prompt with the scene meter's family rules appended.
 * Omitted / '4/4' / unparseable meters return the SDK prompt BYTE-IDENTICAL
 * (formatPluginMeterGuidance yields '' for those), so 4/4 scenes send
 * exactly the pre-meter prompt.
 */
export function buildEnsembleSystemPromptWithMeter(
  specs: readonly EnsembleVoiceSpec[],
  style: EnsembleStyle,
  instrumentation: EnsembleInstrumentation = 'strings',
  timeSignature: string = '4/4'
): string {
  const base = buildEnsembleSystemPrompt(specs, style, instrumentation);
  const meterRules = formatPluginMeterGuidance(timeSignature);
  if (!meterRules) return base;
  // The clarifier remaps the base rules' 4/4-flavored vocabulary ("weak
  // beats", downbeat anticipation, notes-per-bar caps) onto THIS meter —
  // the coordination physics (woven vs section) is unchanged.
  return `${base}\n\n${meterRules}\n- "Weak beats", "downbeats" and barlines in the rules above are defined by THIS meter's grouping — a bar spans the quarter notes stated here, NOT 4. Anticipating a downbeat means attacking just before one of the group starts listed above, and every notes-per-bar cap applies to this meter's bar.`;
}

export interface EnforceVoiceMeteredOptions extends EnforceVoiceOptions {
  /**
   * QUARTER notes per bar of the scene meter (panel-core's
   * `panelQuarterNotesPerBar`): 4/4 → 4, 6/8 → 3, 7/8 → 3.5. Omitted or
   * invalid → 4, which routes through the SDK's enforceVoice unchanged.
   */
  quarterNotesPerBar?: number;
  /**
   * QUARTER notes per DENOMINATOR beat (1 for /4 meters, 0.5 for /8) —
   * the grid used for the density-thinning "on a beat" strength bonus.
   * Omitted → 1 (the legacy quarter-note grid).
   */
  quarterNotesPerSlot?: number;
}

/**
 * Meter-aware `enforceVoice`. 4-qn bars (4/4 and anything omitted/invalid)
 * delegate to the SDK implementation — bit-for-bit the legacy behavior.
 * Other meters run the same pipeline with the bar window generalized:
 * clip clamp at bars×qnPerBar, chord attribution and density thinning per
 * REAL bar, and the density tie-break's "on a beat" bonus on the meter's
 * denominator-beat grid.
 */
export function enforceVoiceMetered(
  rawNotes: readonly EnsembleNote[],
  spec: EnsembleVoiceSpec,
  opts: EnforceVoiceMeteredOptions
): EnforceVoiceResult {
  const qnPerBar =
    opts.quarterNotesPerBar !== undefined &&
    Number.isFinite(opts.quarterNotesPerBar) &&
    opts.quarterNotesPerBar > 0
      ? opts.quarterNotesPerBar
      : 4;
  if (qnPerBar === 4) {
    return enforceVoice(rawNotes, spec, opts);
  }
  const beatUnit =
    opts.quarterNotesPerSlot !== undefined &&
    Number.isFinite(opts.quarterNotesPerSlot) &&
    opts.quarterNotesPerSlot > 0
      ? opts.quarterNotesPerSlot
      : 1;
  return enforceVoiceMirror(rawNotes, spec, opts, qnPerBar, beatUnit);
}

/**
 * Faithful mirror of SDK ensemble-core/enforce-voice.ts with the 4-qn bar
 * generalized to `qnPerBar` (six steps, same order, same repair wording)
 * and the density tie-break's beat grid generalized to `beatUnit`.
 *
 * Exported ONLY for the parity pin test, which runs this mirror at
 * qnPerBar=4/beatUnit=1 against the SDK's enforceVoice and requires
 * identical output — production code must call `enforceVoiceMetered`.
 */
export function enforceVoiceMirror(
  rawNotes: readonly EnsembleNote[],
  spec: EnsembleVoiceSpec,
  opts: EnforceVoiceOptions,
  qnPerBar: number,
  beatUnit: number
): EnforceVoiceResult {
  const repairs: string[] = [];
  const clipEnd = opts.bars * qnPerBar;
  const barOf = (startBeat: number): number => Math.floor(startBeat / qnPerBar);

  // 1. Clip bounds + duration floor (+ the style's stab-length ceiling).
  let notes: EnsembleNote[] = [];
  for (const n of rawNotes) {
    if (!Number.isFinite(n.pitch) || !Number.isFinite(n.startBeat) || !Number.isFinite(n.durationBeats)) continue;
    if (n.startBeat >= clipEnd || n.startBeat < 0) {
      repairs.push(`voice ${spec.voiceIndex}: dropped note outside the ${opts.bars}-bar clip (start ${n.startBeat})`);
      continue;
    }
    let durationBeats = Math.max(
      MIN_NOTE_DURATION_BEATS,
      Math.min(n.durationBeats, clipEnd - n.startBeat)
    );
    if (opts.maxNoteDurationBeats !== undefined && durationBeats > opts.maxNoteDurationBeats) {
      durationBeats = Math.max(MIN_NOTE_DURATION_BEATS, opts.maxNoteDurationBeats);
      repairs.push(`voice ${spec.voiceIndex}: trimmed note at beat ${n.startBeat} to the style's ${opts.maxNoteDurationBeats}-beat stab ceiling`);
    }
    notes.push({ ...n, durationBeats });
  }

  // 2. Register fold.
  notes = notes.map(n => {
    const folded = foldPitchToRegister(Math.round(n.pitch), spec.registerLow, spec.registerHigh);
    if (folded !== n.pitch) {
      repairs.push(`voice ${spec.voiceIndex}: folded pitch ${n.pitch} into register ${spec.registerLow}-${spec.registerHigh} (${folded})`);
    }
    return { ...n, pitch: folded };
  });

  // 3. Root-only anchor voices: pin every note to the bar's chord root.
  if (spec.rootOnly && opts.chordRootPcAtBar) {
    notes = notes.map(n => {
      const bar = barOf(n.startBeat);
      const rootPc = opts.chordRootPcAtBar!(bar);
      if (rootPc === null) return n;
      const pinned = nearestPitchWithPc(n.pitch, rootPc, spec.registerLow, spec.registerHigh);
      if (pinned !== n.pitch) {
        repairs.push(`voice ${spec.voiceIndex}: pinned bar ${bar + 1} note to the chord root (${n.pitch} → ${pinned})`);
      }
      return { ...n, pitch: pinned };
    });
  }

  // 4. In-scale snap (chord tones exempt).
  if (opts.scalePcs && opts.scalePcs.size > 0 && !spec.rootOnly) {
    notes = notes.map(n => {
      const pc = ((n.pitch % 12) + 12) % 12;
      if (opts.scalePcs!.has(pc)) return n;
      const bar = barOf(n.startBeat);
      const chordPcs = opts.chordPcsAtBar?.(bar);
      if (chordPcs?.has(pc)) return n; // chordal color survives the key filter
      const snapped = foldPitchToRegister(
        snapToNearestPc(n.pitch, opts.scalePcs!),
        spec.registerLow,
        spec.registerHigh
      );
      if (snapped !== n.pitch) {
        repairs.push(`voice ${spec.voiceIndex}: snapped out-of-key pitch ${n.pitch} → ${snapped}`);
      }
      return { ...n, pitch: snapped };
    });
  }

  // 5. Per-voice monophony: sort by onset; at equal onsets keep the spec's
  //    preferred extreme; trim any note that overlaps its successor.
  notes.sort((a, b) => a.startBeat - b.startBeat || (spec.monoPreference === 'high' ? b.pitch - a.pitch : a.pitch - b.pitch));
  const mono: EnsembleNote[] = [];
  for (const n of notes) {
    const prev = mono[mono.length - 1];
    if (prev && Math.abs(prev.startBeat - n.startBeat) < 1e-9) {
      repairs.push(`voice ${spec.voiceIndex}: dropped simultaneous note ${n.pitch} at beat ${n.startBeat} (voice is one line)`);
      continue;
    }
    if (prev && prev.startBeat + prev.durationBeats > n.startBeat) {
      prev.durationBeats = Math.max(MIN_NOTE_DURATION_BEATS, n.startBeat - prev.startBeat);
    }
    mono.push({ ...n });
  }

  // 6. Per-bar density thinning: drop the weakest notes (short, quiet,
  //    off-beat) until each REAL bar fits the spec's cap.
  const byBar = new Map<number, EnsembleNote[]>();
  for (const n of mono) {
    const bar = barOf(n.startBeat);
    const bucket = byBar.get(bar) ?? [];
    bucket.push(n);
    byBar.set(bar, bucket);
  }
  const kept = new Set<EnsembleNote>(mono);
  for (const [bar, bucket] of byBar) {
    if (bucket.length <= spec.maxNotesPerBar) continue;
    const strength = (n: EnsembleNote): number => {
      const beatInBar = n.startBeat - bar * qnPerBar;
      const onBeat = Math.abs(beatInBar % beatUnit) < 1e-9 ? 1 : 0;
      return n.durationBeats * 4 + n.velocity / 127 + onBeat * 2;
    };
    const ranked = [...bucket].sort((a, b) => strength(a) - strength(b));
    const excess = bucket.length - spec.maxNotesPerBar;
    for (let i = 0; i < excess; i++) {
      kept.delete(ranked[i]);
    }
    repairs.push(`voice ${spec.voiceIndex}: thinned bar ${bar + 1} from ${bucket.length} to ${spec.maxNotesPerBar} notes (density cap)`);
  }

  return { notes: mono.filter(n => kept.has(n)), repairs };
}

/** Mirror of ensemble-core's private snapToNearestPc (ties resolve DOWN). */
function snapToNearestPc(pitch: number, pcs: ReadonlySet<number>): number {
  if (pcs.size === 0) return pitch;
  for (let d = 0; d <= 6; d++) {
    if (pcs.has((((pitch - d) % 12) + 12) % 12)) return pitch - d;
    if (pcs.has((((pitch + d) % 12) + 12) % 12)) return pitch + d;
  }
  return pitch;
}
