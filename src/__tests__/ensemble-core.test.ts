/**
 * ensemble-core behavior, exercised through the SDK package exactly as the
 * plugin consumes it (jest moduleNameMapper → the file:-installed dist).
 */

import {
  defaultVoiceSpecs,
  enforceVoice,
  analyzeEnsemble,
  describeViolations,
  parseEnsembleArgs,
  buildSubmitEnsembleParameters,
  buildEnsembleSystemPrompt,
  buildViolationRetrySuffix,
  STYLE_RULES,
  SUBMIT_ENSEMBLE_TOOL_NAME,
  type EnsembleNote,
} from '@signalsandsorcery/plugin-sdk';

const note = (pitch: number, startBeat: number, durationBeats = 1, velocity = 100): EnsembleNote =>
  ({ pitch, startBeat, durationBeats, velocity });

describe('defaultVoiceSpecs', () => {
  it('scales 2-6 voices, top-first, with a root-only anchor at 5+', () => {
    expect(defaultVoiceSpecs(2)).toHaveLength(2);
    const five = defaultVoiceSpecs(5);
    expect(five.map(s => s.voiceIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(five[0].registerLow).toBeGreaterThan(five[4].registerLow); // registers descend
    expect(five[0].maxNotesPerBar).toBeGreaterThan(five[4].maxNotesPerBar); // complexity descends
    expect(five[4].rootOnly).toBe(true);
    expect(five[4].role).toBe('808s');
    expect(defaultVoiceSpecs(99)).toHaveLength(6); // clamped
  });
});

describe('enforceVoice — hard contract', () => {
  const spec = { ...defaultVoiceSpecs(5)[4] }; // sub anchor: 24-43, ≤2/bar, rootOnly, mono low

  it('folds register, pins root-only voices to the bar chord root, keeps monophony', () => {
    const { notes, repairs } = enforceVoice(
      [
        note(60, 0, 2),        // way above register + not the root
        note(60.2, 0, 2),      // (kept distinct onset)
        note(31, 0, 4),        // simultaneous with the first → dropped (equal onset keeps LOWEST)
      ],
      spec,
      { bars: 1, chordRootPcAtBar: () => 9 /* A */ }
    );
    expect(notes.length).toBeLessThanOrEqual(2);
    for (const n of notes) {
      expect(n.pitch).toBeGreaterThanOrEqual(spec.registerLow);
      expect(n.pitch).toBeLessThanOrEqual(spec.registerHigh);
      expect(n.pitch % 12).toBe(9); // pinned to A
    }
    expect(repairs.length).toBeGreaterThan(0);
  });

  it('thins density to the cap keeping strong notes, and clamps to the clip', () => {
    const lead = defaultVoiceSpecs(5)[0]; // ≤8/bar
    const dense = Array.from({ length: 16 }, (_, i) => note(80, i * 0.25, 0.25, i === 0 ? 120 : 60));
    const outOfClip = note(80, 99, 1);
    const { notes } = enforceVoice([...dense, outOfClip], lead, { bars: 1 });
    expect(notes.length).toBe(lead.maxNotesPerBar);
    expect(notes.some(n => n.startBeat === 0)).toBe(true); // the accented downbeat survives
    expect(notes.every(n => n.startBeat < 4)).toBe(true);
  });

  it('snaps out-of-scale pitches but exempts chord tones', () => {
    const inner = defaultVoiceSpecs(5)[2];
    const aMinor = new Set([9, 11, 0, 2, 4, 5, 7]);
    const { notes } = enforceVoice(
      [
        note(61, 0),  // C#4 — not in A minor, not a chord tone → snapped
        note(68, 2),  // G#4 — not in A minor, but IS in the E7 chord → kept
      ],
      inner,
      {
        bars: 1,
        scalePcs: aMinor,
        chordPcsAtBar: () => new Set([4, 8, 11, 2]), // E7
      }
    );
    expect(aMinor.has(notes[0].pitch % 12)).toBe(true);
    expect(notes[1].pitch % 12).toBe(8); // G# survived via chord-tone exemption
  });
});

describe('analyzeEnsemble + describeViolations — soft rules by style', () => {
  it('detects parallel fifths, motion mix, and onset dependence', () => {
    // Two voices moving up a whole step in exact parallel fifths, attacking together.
    const upper = [note(76, 0), note(78, 1)];
    const lower = [note(69, 0), note(71, 1)];
    const analysis = analyzeEnsemble([upper, lower]);
    expect(analysis.pairs[0].parallelPerfects.length).toBe(1);
    expect(analysis.pairs[0].onsetIndependence).toBe(0);
    expect(analysis.homorhythmScore).toBe(1);

    const counterpointViolations = describeViolations(analysis, STYLE_RULES.counterpoint);
    expect(counterpointViolations.some(v => v.includes('Parallel fifths'))).toBe(true);
    expect(counterpointViolations.some(v => v.includes('attack together'))).toBe(true);

    // The same music is FINE in interlock except for independence…
    const interlockViolations = describeViolations(analysis, STYLE_RULES.interlock);
    expect(interlockViolations.some(v => v.includes('Parallel'))).toBe(false);
    // …and fine in chorale entirely (homorhythm is the style).
    const choraleViolations = describeViolations(analysis, STYLE_RULES.chorale);
    expect(choraleViolations.some(v => v.includes('attack together'))).toBe(false);
  });

  it('flags voice crossings and rewards contrary motion', () => {
    const upper = [note(60, 0), note(64, 2)];
    const lower = [note(65, 0), note(60, 2)]; // starts ABOVE the upper voice → crossing
    const analysis = analyzeEnsemble([upper, lower]);
    expect(analysis.pairs[0].crossings.length).toBeGreaterThan(0);
    expect(analysis.pairs[0].motion.contrary).toBe(1);
  });
});

describe('submit_ensemble schema + parsing', () => {
  it('builds a JSON-schema tool and parses well-formed args', () => {
    const params = buildSubmitEnsembleParameters(3) as { properties: { voices: { description: string } } };
    expect(params.properties.voices.description).toContain('3 voices');

    const parsed = parseEnsembleArgs(
      {
        voices: [
          { voiceIndex: 0, notes: [{ pitch: 80, startBeat: 0, durationBeats: 1, velocity: 100 }] },
          { voiceIndex: 2, notes: [{ pitch: 40, startBeat: 0, durationBeats: 2, velocity: 90 }] },
          { voiceIndex: 9, notes: [] }, // out of range → warning, ignored
        ],
      },
      3
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.voiceNotes[0]).toHaveLength(1);
    expect(parsed!.voiceNotes[1]).toHaveLength(0); // model skipped it
    expect(parsed!.voiceNotes[2]).toHaveLength(1);
    expect(parsed!.warnings.length).toBeGreaterThan(0);
  });

  it('rejects unusable payloads', () => {
    expect(parseEnsembleArgs(null, 3)).toBeNull();
    expect(parseEnsembleArgs({ voices: 'nope' }, 3)).toBeNull();
    expect(parseEnsembleArgs({ voices: [{ voiceIndex: 0, notes: [] }] }, 3)).toBeNull(); // zero notes anywhere
  });
});

describe('ensemble prompt', () => {
  it('states the ensemble rules, per-voice contracts, and the tool name', () => {
    const specs = defaultVoiceSpecs(4);
    const prompt = buildEnsembleSystemPrompt(specs, 'counterpoint');
    expect(prompt).toContain(SUBMIT_ENSEMBLE_TOOL_NAME);
    expect(prompt).toContain('THE ENSEMBLE RULES');
    expect(prompt).toContain('PER-VOICE CONTRACTS:');
    for (const spec of specs) {
      expect(prompt).toContain(`MIDI ${spec.registerLow}-${spec.registerHigh}`);
      expect(prompt).toContain(`max ${spec.maxNotesPerBar} notes/bar`);
    }
    expect(prompt).toContain('STYLE — COUNTERPOINT');

    expect(buildViolationRetrySuffix([])).toBe('');
    expect(buildViolationRetrySuffix(['Parallel fifths between voice 1 and voice 2 at beat 3']))
      .toContain('fix them while keeping everything that worked');
  });
});
