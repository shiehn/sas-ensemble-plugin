/**
 * The plugin-local meter layer (P8b): parity of the enforcement mirror with
 * the SDK's enforceVoice at the 4-qn bar, and meter-aware behavior (clip
 * clamp, per-real-bar chord attribution, per-real-bar density, fractional
 * bars) everywhere else. Also covers chordLookupsFromTiming's meter window.
 */
import {
  enforceVoice,
  type EnsembleNote,
  type EnsembleVoiceSpec,
} from '@signalsandsorcery/plugin-sdk';
import { enforceVoiceMetered, enforceVoiceMirror } from '../ensemble-meter';
import { chordLookupsFromTiming } from '../music-helpers';

const lead: EnsembleVoiceSpec = {
  voiceIndex: 0,
  label: 'high florid line',
  role: 'lead',
  registerLow: 60,
  registerHigh: 84,
  maxNotesPerBar: 3,
  rhythmPalette: 'eighths',
  harmonicDiscipline: 'chord tones',
  monoPreference: 'high',
};

const anchor: EnsembleVoiceSpec = {
  voiceIndex: 3,
  label: 'root anchor',
  role: 'bass',
  registerLow: 36,
  registerHigh: 60,
  maxNotesPerBar: 2,
  rhythmPalette: 'long tones',
  harmonicDiscipline: 'roots',
  rootOnly: true,
  monoPreference: 'low',
};

const note = (pitch: number, startBeat: number, durationBeats: number, velocity = 96): EnsembleNote => ({
  pitch,
  startBeat,
  durationBeats,
  velocity,
});

describe('enforceVoiceMirror — parity with SDK enforceVoice at qnPerBar=4', () => {
  // A battery exercising every pipeline step: out-of-clip drop, tail trim,
  // register fold, scale snap, simultaneous-onset drop, overlap trim, and
  // density thinning. The mirror at (4, 1) must be output-identical.
  const battery: EnsembleNote[] = [
    note(100, 0, 1),      // above register — fold
    note(61, 0.5, 0.5),   // out-of-scale (C#) — snap
    note(64, 1, 0.5),
    note(66, 1, 0.5),     // simultaneous with previous — drop (keep high)
    note(62, 1.25, 4),    // overlaps successor — trim
    note(65, 1.5, 0.25, 40),
    note(67, 2, 0.25, 45),
    note(69, 2.5, 0.25, 50),
    note(71, 3, 0.25, 55), // bar over density cap — weakest thinned
    note(72, 4.5, 0.5),
    note(60, 9, 1),       // outside the 2-bar clip — drop
    note(64, -1, 1),      // negative start — drop
  ];
  const opts = {
    bars: 2,
    scalePcs: new Set([0, 2, 4, 5, 7, 9, 11]),
    chordRootPcAtBar: (bar: number): number | null => (bar === 0 ? 9 : 5),
    chordPcsAtBar: (bar: number): Set<number> | null =>
      bar === 0 ? new Set([9, 0, 4]) : new Set([5, 9, 0]),
    maxNoteDurationBeats: 2,
  };

  it('free voice: identical notes and repairs', () => {
    const sdk = enforceVoice(battery, lead, opts);
    const mirror = enforceVoiceMirror(battery, lead, opts, 4, 1);
    expect(mirror.notes).toEqual(sdk.notes);
    expect(mirror.repairs).toEqual(sdk.repairs);
  });

  it('rootOnly anchor voice: identical notes and repairs', () => {
    const sdk = enforceVoice(battery, anchor, opts);
    const mirror = enforceVoiceMirror(battery, anchor, opts, 4, 1);
    expect(mirror.notes).toEqual(sdk.notes);
    expect(mirror.repairs).toEqual(sdk.repairs);
  });

  it('enforceVoiceMetered delegates to the SDK for omitted/4/invalid qnPerBar', () => {
    const sdk = enforceVoice(battery, lead, opts);
    expect(enforceVoiceMetered(battery, lead, opts).notes).toEqual(sdk.notes);
    expect(enforceVoiceMetered(battery, lead, { ...opts, quarterNotesPerBar: 4 }).notes).toEqual(sdk.notes);
    expect(enforceVoiceMetered(battery, lead, { ...opts, quarterNotesPerBar: NaN }).notes).toEqual(sdk.notes);
  });
});

describe('enforceVoiceMetered — meter-aware bar windows', () => {
  it('3/4: the clip ends at bars×3 qn (a 4/4 clamp would keep beat-3 notes)', () => {
    const { notes, repairs } = enforceVoiceMetered(
      [note(64, 2.5, 2), note(64, 3, 1)],
      lead,
      { bars: 1, quarterNotesPerBar: 3 }
    );
    expect(notes).toHaveLength(1);
    expect(notes[0].startBeat).toBe(2.5);
    expect(notes[0].durationBeats).toBe(0.5); // trimmed to the 3-qn clip end
    expect(repairs.some((r) => r.includes('outside the 1-bar clip'))).toBe(true);
  });

  it('3/4 rootOnly: notes pin to the REAL bar\'s chord root, not the 4-qn block', () => {
    // Chords change per 3-qn bar: Am (bar 1) then F (bar 2).
    const { chordRootPcAtBar } = chordLookupsFromTiming(
      [
        { symbol: 'Am', startQn: 0, endQn: 3 },
        { symbol: 'F', startQn: 3, endQn: 6 },
      ],
      '3/4'
    );
    const { notes } = enforceVoiceMetered(
      [note(45, 0, 2), note(45, 3, 2)], // A2 in both bars
      anchor,
      { bars: 2, quarterNotesPerBar: 3, chordRootPcAtBar }
    );
    expect(notes[0].pitch % 12).toBe(9); // Am root stays A
    expect(notes[1].pitch % 12).toBe(5); // bar 2 (qn 3) pins to F — a 4-qn
    // block would still be "bar 0" here and wrongly keep A.
  });

  it('6/4: the density cap applies per 6-qn bar', () => {
    const sixNotes = [0, 1, 2, 3, 4, 5].map((b) => note(64, b, 0.5, 60 + b));
    const { notes } = enforceVoiceMetered(sixNotes, lead, {
      bars: 1,
      quarterNotesPerBar: 6,
    });
    expect(notes).toHaveLength(lead.maxNotesPerBar); // one 6-qn bar → one cap
  });

  it('7/8 (fractional 3.5-qn bars): clamp and bar attribution stay exact', () => {
    const { notes } = enforceVoiceMetered(
      [note(64, 3.25, 1), note(64, 7, 1)],
      lead,
      { bars: 2, quarterNotesPerBar: 3.5 }
    );
    expect(notes).toHaveLength(1);
    expect(notes[0].durationBeats).toBeCloseTo(1, 10); // 3.25+1 ≤ 7 — untrimmed
  });

  it('6/8 density tie-break: the on-beat bonus rides the eighth-note grid', () => {
    // Four equal-strength candidates in one 3-qn bar (cap 3): the only
    // off-eighth-grid onset (1.25) is the one thinned when beatUnit=0.5.
    const candidates = [note(64, 0, 0.25), note(64, 1.25, 0.25), note(64, 1.5, 0.25), note(64, 2.5, 0.25)];
    const { notes } = enforceVoiceMetered(candidates, lead, {
      bars: 1,
      quarterNotesPerBar: 3,
      quarterNotesPerSlot: 0.5,
    });
    expect(notes.map((n) => n.startBeat)).toEqual([0, 1.5, 2.5]);
  });
});

describe('chordLookupsFromTiming — meter windows', () => {
  const timing = [
    { symbol: 'Am', startQn: 0, endQn: 3 },
    { symbol: 'F', startQn: 3, endQn: 6 },
  ];

  it("'3/4' maps bar N to the 3-qn window", () => {
    const { chordRootPcAtBar } = chordLookupsFromTiming(timing, '3/4');
    expect(chordRootPcAtBar(0)).toBe(9);
    expect(chordRootPcAtBar(1)).toBe(5);
  });

  it('omitted and unparseable meters keep the legacy 4-qn grid', () => {
    const legacy = chordLookupsFromTiming(timing);
    const junk = chordLookupsFromTiming(timing, 'waltz');
    // bar 1 starts at qn 4 on the legacy grid — inside the F region [3, 6).
    expect(legacy.chordRootPcAtBar(1)).toBe(5);
    expect(junk.chordRootPcAtBar(1)).toBe(5);
    // bar 0 window [0, 4) starts inside Am.
    expect(legacy.chordRootPcAtBar(0)).toBe(9);
  });
});
