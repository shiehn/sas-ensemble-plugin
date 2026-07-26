/**
 * The INSTRUMENTATION axis (strings / horns / winds), exercised through the
 * SDK package exactly as the plugin consumes it, plus the plugin-side
 * config/hints/stamp wiring and a horns end-to-end generation pass.
 *
 * The load-bearing claims: horns are a SECTION (rhythmic unison required,
 * parallels welcome, stabs trimmed short, roles 'brass'), strings behavior
 * is byte-identical to the pre-instrumentation plugin, and every mode's
 * registers stay octave-fold-safe.
 */

import type {
  GenerationServices,
  GeneratorTrackState,
  LLMToolUseRequest,
  MidiClipData,
  EnsembleNote,
} from '@signalsandsorcery/plugin-sdk';
import {
  defaultVoiceSpecs,
  buildEnsembleSystemPrompt,
  analyzeEnsemble,
  describeViolations,
  enforceVoice,
  styleForInstrumentation,
  normalizeInstrumentation,
  STYLES_FOR_INSTRUMENTATION,
  DEFAULT_STYLE_FOR_INSTRUMENTATION,
  ENSEMBLE_INSTRUMENTATIONS,
  ENSEMBLE_MIN_VOICES,
  ENSEMBLE_MAX_VOICES,
  HORN_MAX_NOTES_PER_BAR,
  STYLE_RULES,
  SUBMIT_ENSEMBLE_TOOL_NAME,
} from '@signalsandsorcery/plugin-sdk';
import { generateEnsemble } from '../ensemble-generation';
import {
  ENSEMBLE_VOICE_META_KEY,
  asEnsembleConfig,
  parsePromptHints,
  stampEnsembleAnchor,
} from '../ensemble-voice-meta';

const note = (pitch: number, startBeat: number, durationBeats = 1, velocity = 100): EnsembleNote =>
  ({ pitch, startBeat, durationBeats, velocity });

describe('defaultVoiceSpecs by instrumentation', () => {
  it('strings stays the pre-instrumentation default (backward compatibility)', () => {
    expect(defaultVoiceSpecs(5)).toEqual(defaultVoiceSpecs(5, 'strings'));
    const five = defaultVoiceSpecs(5, 'strings');
    expect(five[4].role).toBe('808s'); // the electronic sub anchor survives untouched
  });

  it('horns: all brass, equal density caps, real section registers, JB trio at 3', () => {
    const trio = defaultVoiceSpecs(3, 'horns');
    expect(trio.map(s => s.label)).toEqual(['lead trumpet', 'tenor sax', 'baritone sax']);
    for (const s of trio) {
      expect(s.role).toBe('brass');
      expect(s.maxNotesPerBar).toBe(HORN_MAX_NOTES_PER_BAR); // the section speaks one rhythm — equal caps
      expect(s.rootOnly).toBeUndefined(); // no 808-style pinned anchor in a horn section
    }
    const six = defaultVoiceSpecs(6, 'horns');
    expect(six.map(s => s.label)).toEqual([
      'lead trumpet', 'second trumpet', 'alto sax', 'tenor sax', 'trombone', 'baritone sax',
    ]);
  });

  it('winds: all winds role, the quintet at 5', () => {
    const quintet = defaultVoiceSpecs(5, 'winds');
    expect(quintet.map(s => s.label)).toEqual(['flute', 'oboe', 'clarinet', 'french horn', 'bassoon']);
    for (const s of quintet) expect(s.role).toBe('winds');
  });

  it('every mode/size: registers descend top-down and stay octave-fold-safe (≥ 12 semitones)', () => {
    for (const instrumentation of ENSEMBLE_INSTRUMENTATIONS) {
      for (let n = ENSEMBLE_MIN_VOICES; n <= ENSEMBLE_MAX_VOICES; n++) {
        const specs = defaultVoiceSpecs(n, instrumentation);
        expect(specs).toHaveLength(n);
        for (let i = 0; i < specs.length; i++) {
          expect(specs[i].registerHigh - specs[i].registerLow).toBeGreaterThanOrEqual(12);
          if (i > 0) {
            expect(specs[i].registerLow).toBeLessThanOrEqual(specs[i - 1].registerLow);
          }
        }
      }
    }
  });
});

describe('style gating by instrumentation', () => {
  it('each parent offers its own trio and a default inside it', () => {
    expect(STYLES_FOR_INSTRUMENTATION.strings).toEqual(['counterpoint', 'chorale', 'interlock']);
    expect(STYLES_FOR_INSTRUMENTATION.horns).toEqual(['stabs', 'riffs', 'unison']);
    expect(STYLES_FOR_INSTRUMENTATION.winds).toEqual(['counterpoint', 'chorale', 'interlock']);
    for (const instrumentation of ENSEMBLE_INSTRUMENTATIONS) {
      expect(STYLES_FOR_INSTRUMENTATION[instrumentation])
        .toContain(DEFAULT_STYLE_FOR_INSTRUMENTATION[instrumentation]);
    }
  });

  it('clamps foreign styles to the mode default, keeps valid ones', () => {
    expect(styleForInstrumentation('horns', 'counterpoint')).toBe('stabs');
    expect(styleForInstrumentation('horns', 'riffs')).toBe('riffs');
    expect(styleForInstrumentation('strings', 'stabs')).toBe('counterpoint');
    expect(styleForInstrumentation('winds', 'interlock')).toBe('interlock');
    expect(styleForInstrumentation('winds', undefined)).toBe('chorale');
    expect(normalizeInstrumentation('horns')).toBe('horns');
    expect(normalizeInstrumentation('theremin orchestra')).toBe('strings');
    expect(normalizeInstrumentation(undefined)).toBe('strings');
  });
});

describe('mode-branched system prompt', () => {
  it('horns get SECTION rules (togetherness), not the woven anti-simultaneity rules', () => {
    const specs = defaultVoiceSpecs(3, 'horns');
    const prompt = buildEnsembleSystemPrompt(specs, 'stabs', 'horns');
    expect(prompt).toContain('funk horn-section arranger');
    expect(prompt).toContain('THE SECTION RULES');
    expect(prompt).toContain('same beats as Voice 1');
    expect(prompt).toContain('STYLE — STABS');
    expect(prompt).toContain(SUBMIT_ENSEMBLE_TOOL_NAME);
    expect(prompt).toContain('PER-VOICE CONTRACTS');
    // The woven rule that forbids the defining horn gesture must be GONE.
    expect(prompt).not.toContain('Avoid all voices attacking the same beat');
    expect(prompt).not.toContain('THE ENSEMBLE RULES');
  });

  it('strings keep the historical woven prompt; winds only swap the persona', () => {
    const strings = buildEnsembleSystemPrompt(defaultVoiceSpecs(4, 'strings'), 'counterpoint', 'strings');
    expect(strings).toContain('You are an ensemble composer.');
    expect(strings).toContain('THE ENSEMBLE RULES');
    // Two-arg legacy call = strings — byte-identical.
    expect(buildEnsembleSystemPrompt(defaultVoiceSpecs(4), 'counterpoint')).toBe(strings);

    const winds = buildEnsembleSystemPrompt(defaultVoiceSpecs(5, 'winds'), 'chorale', 'winds');
    expect(winds).toContain('wind-ensemble composer');
    expect(winds).toContain('THE ENSEMBLE RULES');
    expect(winds).toContain('STYLE — CHORALE');
  });
});

describe('section soft rules — togetherness required', () => {
  it('flags voices that do NOT attack together under stabs, and only there', () => {
    // Fully independent onsets: upper hits 0 and 2, lower hits 1 and 3.
    const apart = analyzeEnsemble([
      [note(76, 0), note(74, 2)],
      [note(57, 1), note(55, 3)],
    ]);
    const stabViolations = describeViolations(apart, STYLE_RULES.stabs);
    expect(stabViolations.some(v => v.includes("don't attack together enough"))).toBe(true);
    // The same music is legal counterpoint (independence is a virtue there).
    expect(describeViolations(apart, STYLE_RULES.counterpoint)
      .some(v => v.includes("don't attack together"))).toBe(false);

    // Lockstep hits: no togetherness violation, and parallels are welcome.
    const together = analyzeEnsemble([
      [note(76, 0), note(74, 1.5)],
      [note(69, 0), note(67, 1.5)], // exact parallel fifths below
    ]);
    const lockstep = describeViolations(together, STYLE_RULES.stabs);
    expect(lockstep).toHaveLength(0);
  });
});

describe('stab duration ceiling — mechanical', () => {
  it('trims pad-length notes to the style cap, leaves short punches alone', () => {
    const lead = defaultVoiceSpecs(3, 'horns')[0];
    const cap = STYLE_RULES.stabs.maxNoteDurationBeats;
    expect(cap).toBeDefined();
    const { notes, repairs } = enforceVoice(
      [note(76, 0, 3), note(74, 3, 0.5)],
      lead,
      { bars: 1, maxNoteDurationBeats: cap }
    );
    expect(notes[0].durationBeats).toBe(cap);
    expect(notes[1].durationBeats).toBe(0.5);
    expect(repairs.some(r => r.includes('stab ceiling'))).toBe(true);
    // No cap (riffs) → untouched.
    const uncapped = enforceVoice([note(76, 0, 3)], lead, { bars: 1 });
    expect(uncapped.notes[0].durationBeats).toBe(3);
  });
});

describe('prompt hints — family words', () => {
  it('routes families, with the french-horn carve-out into winds', () => {
    expect(parsePromptHints('french horns and flutes, chorale')).toMatchObject({
      instrumentation: 'winds', style: 'chorale',
    });
    expect(parsePromptHints('big funk horn section').instrumentation).toBe('horns');
    expect(parsePromptHints('brass stabs')).toMatchObject({ instrumentation: 'horns', style: 'stabs' });
    expect(parsePromptHints('solemn string quartet').instrumentation).toBe('strings');
    expect(parsePromptHints('misty counterpoint').instrumentation).toBeUndefined();
    // A mixed brass+french-horn prompt leans horns.
    expect(parsePromptHints('french horn and trumpets').instrumentation).toBe('horns');
    // A section-only style word is itself a horn signal.
    expect(parsePromptHints('james brown stabs').instrumentation).toBe('horns');
    // "3 horns" carries the count too.
    expect(parsePromptHints('3 horns, tight riffs')).toMatchObject({
      voiceCount: 3, instrumentation: 'horns', style: 'riffs',
    });
  });
});

describe('config + anchor stamp', () => {
  it('asEnsembleConfig passes instrumentation through and drops junk', () => {
    expect(asEnsembleConfig({ voiceCount: 4, style: 'stabs', instrumentation: 'horns' }))
      .toEqual({ voiceCount: 4, style: 'stabs', instrumentation: 'horns' });
    expect(asEnsembleConfig({ voiceCount: 4, style: 'chorale' }))
      .toEqual({ voiceCount: 4, style: 'chorale' });
    expect(asEnsembleConfig({ voiceCount: 4, style: 'chorale', instrumentation: 7 }))
      .toEqual({ voiceCount: 4, style: 'chorale' });
  });

  it('stampEnsembleAnchor writes a group-of-one meta under the voice key', async () => {
    const setSceneData = jest.fn(async () => {});
    await stampEnsembleAnchor(
      { setSceneData } as never,
      'scene-1',
      (dbId, suffix) => `track:${dbId}:${suffix}`,
      'db-1'
    );
    expect(setSceneData).toHaveBeenCalledWith(
      'scene-1',
      `track:db-1:${ENSEMBLE_VOICE_META_KEY}`,
      { groupId: 'db-1', voiceIndex: 0, label: 'ensemble voice', role: '' }
    );
  });
});

// ── horns end to end: stored config → section prompt, brass roles, trim ─────

type VoicesArg = { voices: Array<{ voiceIndex: number; notes: Array<{ pitch: number; startBeat: number; durationBeats: number; velocity: number }> }> };

function llmResponse(args: VoicesArg): unknown {
  return {
    candidates: [
      { content: { role: 'model', parts: [{ functionCall: { name: SUBMIT_ENSEMBLE_TOOL_NAME, args } }] } },
    ],
  };
}

/** Three horns hitting the SAME onsets (0, 1.5, 3) — clean stabs in A minor. */
const SECTION_VOICES: VoicesArg = {
  voices: [
    { voiceIndex: 0, notes: [
      { pitch: 76, startBeat: 0, durationBeats: 2, velocity: 115 }, // pad-length → trimmed to the stab cap
      { pitch: 74, startBeat: 1.5, durationBeats: 0.5, velocity: 80 },
      { pitch: 72, startBeat: 3, durationBeats: 0.5, velocity: 110 },
    ] },
    { voiceIndex: 1, notes: [
      { pitch: 57, startBeat: 0, durationBeats: 0.5, velocity: 110 },
      { pitch: 55, startBeat: 1.5, durationBeats: 0.5, velocity: 78 },
      { pitch: 52, startBeat: 3, durationBeats: 0.5, velocity: 105 },
    ] },
    { voiceIndex: 2, notes: [
      { pitch: 45, startBeat: 0, durationBeats: 0.5, velocity: 110 },
      { pitch: 45, startBeat: 1.5, durationBeats: 0.5, velocity: 76 },
      { pitch: 45, startBeat: 3, durationBeats: 0.5, velocity: 105 },
    ] },
  ],
};

function makeHornsHarness(opts: { storedConfig?: unknown; prompt?: string } = {}): {
  services: GenerationServices;
  track: GeneratorTrackState;
  roleCalls: string[];
  llmRequests: LLMToolUseRequest[];
  sceneData: Map<string, unknown>;
  clips: Map<string, MidiClipData>;
} {
  const roleCalls: string[] = [];
  const llmRequests: LLMToolUseRequest[] = [];
  const sceneData = new Map<string, unknown>();
  const clips = new Map<string, MidiClipData>();
  if (opts.storedConfig !== undefined) {
    sceneData.set('track:db-a:ensembleConfig', opts.storedConfig);
  }

  const host = {
    getSceneData: jest.fn(async (_scene: string, key: string) => sceneData.get(key) ?? null),
    setSceneData: jest.fn(async (_scene: string, key: string, value: unknown) => { sceneData.set(key, value); }),
    deleteSceneData: jest.fn(async () => {}),
    getMusicalContext: jest.fn(async () => ({
      key: 'A', mode: 'minor', bpm: 110, bars: 1, genre: 'funk',
      timeSignature: '4/4',
      chordProgression: [{ symbol: 'Am', startQn: 0, endQn: 4 }],
      contractPrompt: null,
    })),
    getGenerationContext: jest.fn(async () => ({
      chordProgression: { key: { tonic: 'A', mode: 'minor' }, chordsWithTiming: [], genre: null },
      concurrentTracks: [],
    })),
    generateWithLLMTools: jest.fn(async (request: LLMToolUseRequest) => {
      llmRequests.push(request);
      return llmResponse(SECTION_VOICES);
    }),
    writeMidiClip: jest.fn(async (engineId: string, clip: MidiClipData) => { clips.set(engineId, clip); return {}; }),
    setTrackRole: jest.fn(async (engineId: string, role: string) => { roleCalls.push(`${engineId}:${role}`); }),
    setTrackMute: jest.fn(async () => {}),
    shufflePreset: jest.fn(async (engineId: string) => ({ presetName: `P-${engineId}`, presetCategory: 'Brass-hi' })),
    deleteTrack: jest.fn(async () => {}),
    showToast: jest.fn(),
  };

  const services = {
    host: host as never,
    activeSceneId: 'scene-1',
    tracks: [{ id: 0 }],
    updateTrack: jest.fn(),
    setTracks: jest.fn(),
    reloadTracks: jest.fn(async () => {}),
    soundHistory: {} as never,
    engineToDbId: (id: string) => id,
    trackDataKey: (dbId: string, suffix: string) => `track:${dbId}:${suffix}`,
    markEditLoaded: jest.fn(),
    createFamilyTrack: jest.fn(async (suffix = '') =>
      ({ id: `eng-new${suffix}`, name: `ensemble${suffix}`, dbId: `db-new${suffix}` })),
    resolvedGroups: jest.fn(() => []),
  } as unknown as GenerationServices;

  const track = {
    handle: { id: 'eng-a', name: 'ensemble-1', dbId: 'db-a' },
    prompt: opts.prompt ?? 'greasy funk punches',
    role: '',
    runtimeState: { muted: false, solo: false },
  } as unknown as GeneratorTrackState;

  return { services, track, roleCalls, llmRequests, sceneData, clips };
}

describe('generateEnsemble — horns path', () => {
  it('stored horns config drives the section prompt, brass roles, stab trim, and persists the mode', async () => {
    const h = makeHornsHarness({ storedConfig: { voiceCount: 3, style: 'stabs', instrumentation: 'horns' } });
    await generateEnsemble(h.track, h.services);

    // ONE call (the lockstep fixture violates nothing) with the SECTION prompt.
    expect(h.llmRequests).toHaveLength(1);
    const sys = h.llmRequests[0].systemInstruction?.parts?.[0]?.text ?? '';
    expect(sys).toContain('THE SECTION RULES');
    expect(sys).toContain('lead trumpet');
    expect(sys).not.toContain('Avoid all voices attacking the same beat');

    // Every voice stamps 'brass'.
    expect(h.roleCalls).toEqual(['eng-a:brass', 'eng-new-v1:brass', 'eng-new-v2:brass']);

    // The pad-length lead note came back as a stab (mechanical trim).
    const anchorClip = h.clips.get('eng-a');
    expect(anchorClip).toBeDefined();
    const first = anchorClip!.notes.find(n => n.startBeat === 0);
    expect(first?.durationBeats).toBe(STYLE_RULES.stabs.maxNoteDurationBeats);

    // Config round-trips with the mode.
    expect(h.sceneData.get('track:db-a:ensembleConfig'))
      .toEqual({ voiceCount: 3, style: 'stabs', instrumentation: 'horns' });
  });

  it('hint-driven horns: "james brown horn stabs, 3 horns" lands the section without stored config', async () => {
    const h = makeHornsHarness({ prompt: 'james brown horn stabs, 3 horns' });
    await generateEnsemble(h.track, h.services);
    const sys = h.llmRequests[0].systemInstruction?.parts?.[0]?.text ?? '';
    expect(sys).toContain('funk horn-section arranger');
    expect(sys).toContain('STYLE — STABS');
    expect(h.roleCalls.every(c => c.endsWith(':brass'))).toBe(true);
    expect(h.sceneData.get('track:db-a:ensembleConfig'))
      .toEqual({ voiceCount: 3, style: 'stabs', instrumentation: 'horns' });
  });
});
