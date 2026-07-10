/**
 * The brain, end to end against a stubbed host: schema-forced request shape,
 * hint-driven config, the create→clip→role→preset→meta ordering, empty-voice
 * dropping, the guided retry, budget refusal, and LIFO rollback.
 */

import type {
  GenerationServices,
  GeneratorTrackState,
  LLMToolUseRequest,
} from '@signalsandsorcery/plugin-sdk';
import { SUBMIT_ENSEMBLE_TOOL_NAME } from '@signalsandsorcery/plugin-sdk';
import { generateEnsemble, ENSEMBLE_MAX_TRACKS } from '../ensemble-generation';
import { ENSEMBLE_VOICE_META_KEY } from '../ensemble-voice-meta';

type VoicesArg = { voices: Array<{ voiceIndex: number; notes: Array<{ pitch: number; startBeat: number; durationBeats: number; velocity: number }> }> };

function llmResponse(args: VoicesArg): unknown {
  return {
    candidates: [
      { content: { role: 'model', parts: [{ functionCall: { name: SUBMIT_ENSEMBLE_TOOL_NAME, args } }] } },
    ],
  };
}

/** Three clean voices for a 3-voice ensemble (contrary-ish, independent onsets). */
const CLEAN_VOICES: VoicesArg = {
  voices: [
    { voiceIndex: 0, notes: [
      { pitch: 81, startBeat: 0, durationBeats: 1, velocity: 100 },
      { pitch: 79, startBeat: 1.5, durationBeats: 0.5, velocity: 90 },
      { pitch: 77, startBeat: 3, durationBeats: 1, velocity: 95 },
    ] },
    { voiceIndex: 1, notes: [
      { pitch: 64, startBeat: 0.5, durationBeats: 1.5, velocity: 85 },
      { pitch: 66, startBeat: 2.5, durationBeats: 1, velocity: 85 },
    ] },
    { voiceIndex: 2, notes: [
      { pitch: 45, startBeat: 0, durationBeats: 4, velocity: 100 },
    ] },
  ],
};

interface Harness {
  services: GenerationServices;
  track: GeneratorTrackState;
  calls: string[];
  llmRequests: LLMToolUseRequest[];
  sceneData: Map<string, unknown>;
  host: Record<string, jest.Mock>;
}

function makeHarness(opts: {
  llmResults?: unknown[];
  trackCount?: number;
  failClipWrite?: boolean;
} = {}): Harness {
  const calls: string[] = [];
  const llmRequests: LLMToolUseRequest[] = [];
  const sceneData = new Map<string, unknown>();
  const llmResults = [...(opts.llmResults ?? [llmResponse(CLEAN_VOICES)])];

  const host: Record<string, jest.Mock> = {
    getSceneData: jest.fn(async (_scene: string, key: string) => sceneData.get(key) ?? null),
    setSceneData: jest.fn(async (_scene: string, key: string, value: unknown) => {
      calls.push(`setSceneData:${key}`);
      sceneData.set(key, value);
    }),
    deleteSceneData: jest.fn(async () => { calls.push('deleteSceneData'); }),
    getMusicalContext: jest.fn(async () => ({
      key: 'A', mode: 'minor', bpm: 120, bars: 1, genre: 'dnb',
      timeSignature: '4/4',
      chordProgression: [{ symbol: 'Am', startQn: 0, endQn: 4 }],
      contractPrompt: 'late-night strings',
    })),
    getGenerationContext: jest.fn(async () => ({
      chordProgression: { key: { tonic: 'A', mode: 'minor' }, chordsWithTiming: [], genre: null },
      concurrentTracks: [{
        trackId: 'eng-drums', dbId: 'db-drums', name: 'Drums', role: 'kicks',
        presetCategory: null,
        notesByChord: [{ chord: 'Am', chordRangeQn: [0, 4] as [number, number], notes: [
          { pitch: 60, startBeat: 0, durationBeats: 0.25, velocity: 120 },
        ] }],
      }],
    })),
    generateWithLLMTools: jest.fn(async (request: LLMToolUseRequest) => {
      llmRequests.push(request);
      const next = llmResults.length > 1 ? llmResults.shift() : llmResults[0];
      return next;
    }),
    writeMidiClip: jest.fn(async (engineId: string) => {
      if (opts.failClipWrite) throw new Error('engine says no');
      calls.push(`writeMidiClip:${engineId}`);
      return {};
    }),
    setTrackRole: jest.fn(async (engineId: string, role: string) => { calls.push(`setTrackRole:${engineId}:${role}`); }),
    setTrackMute: jest.fn(async () => { calls.push('mute'); }),
    shufflePreset: jest.fn(async (engineId: string) => {
      calls.push(`shufflePreset:${engineId}`);
      return { presetName: `P-${engineId}`, presetCategory: 'Strings-hi' };
    }),
    deleteTrack: jest.fn(async (engineId: string) => { calls.push(`deleteTrack:${engineId}`); }),
    showToast: jest.fn(),
  };

  let createdCount = 0;
  const services = {
    host: host as never,
    activeSceneId: 'scene-1',
    tracks: Array.from({ length: opts.trackCount ?? 1 }, (_, i) => ({ id: i })),
    updateTrack: jest.fn(),
    setTracks: jest.fn(),
    reloadTracks: jest.fn(async () => {}),
    soundHistory: {} as never,
    engineToDbId: (id: string) => id,
    trackDataKey: (dbId: string, suffix: string) => `track:${dbId}:${suffix}`,
    markEditLoaded: jest.fn(),
    createFamilyTrack: jest.fn(async (suffix = '') => {
      createdCount += 1;
      calls.push(`createFamilyTrack:${suffix}`);
      return { id: `eng-new${suffix}`, name: `ensemble${suffix}`, dbId: `db-new${suffix}` };
    }),
    resolvedGroups: jest.fn(() => []),
  } as unknown as GenerationServices;

  const track = {
    handle: { id: 'eng-a', name: 'ensemble-1', dbId: 'db-a' },
    prompt: '3 voices, misty counterpoint',
    role: '',
    runtimeState: { muted: false, solo: false },
  } as unknown as GeneratorTrackState;

  return { services, track, calls, llmRequests, sceneData, host };
}

describe('generateEnsemble', () => {
  it('makes ONE schema-forced call and executes create→clip→role→preset→meta in order', async () => {
    const h = makeHarness();
    await generateEnsemble(h.track, h.services);

    // Request shape: forced function calling with our tool + assembled context.
    expect(h.llmRequests).toHaveLength(1);
    const req = h.llmRequests[0];
    expect(req.toolConfig?.functionCallingConfig?.mode).toBe('ANY');
    expect(req.toolConfig?.functionCallingConfig?.allowedFunctionNames).toEqual([SUBMIT_ENSEMBLE_TOOL_NAME]);
    const sys = req.systemInstruction?.parts?.[0]?.text ?? '';
    expect(sys).toContain('PER-VOICE CONTRACTS');
    const user = (req.contents[0].parts[0] as { text: string }).text;
    expect(user).toContain('Musical Context:');
    expect(user).toContain('Am (beats 0-4)');
    expect(user).toContain('Concurrent tracks in scene');
    expect(user).toContain('User request: "3 voices, misty counterpoint"');

    // 3 voices (hint-driven), anchor reused → 2 new tracks created.
    expect(h.calls.filter(c => c.startsWith('createFamilyTrack'))).toHaveLength(2);

    // Ordering: every clip write precedes every preset shuffle; metas come last.
    const firstShuffle = h.calls.findIndex(c => c.startsWith('shufflePreset'));
    const lastClip = h.calls.map((c, i) => (c.startsWith('writeMidiClip') ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
    expect(lastClip).toBeLessThan(firstShuffle);
    const firstMeta = h.calls.findIndex(c => c.startsWith(`setSceneData:track:db-a:${ENSEMBLE_VOICE_META_KEY}`));
    expect(firstMeta).toBeGreaterThan(firstShuffle);

    // Presets only for NEW voices (anchor reused keeps its patch).
    expect(h.calls.filter(c => c.startsWith('shufflePreset'))).toHaveLength(2);

    // Roles follow the 3-voice spec table: lead / strings / bass.
    expect(h.calls).toContain('setTrackRole:eng-a:lead');
    expect(h.calls.some(c => /setTrackRole:eng-new-v1:strings/.test(c))).toBe(true);
    expect(h.calls.some(c => /setTrackRole:eng-new-v2:bass/.test(c))).toBe(true);

    // Anchor meta has groupId = anchor dbId; config persisted.
    expect(h.sceneData.get(`track:db-a:${ENSEMBLE_VOICE_META_KEY}`)).toMatchObject({ groupId: 'db-a', voiceIndex: 0 });
    expect(h.sceneData.get('track:db-a:ensembleConfig')).toMatchObject({ voiceCount: 3, style: 'counterpoint' });
  });

  it('drops voices the model left empty instead of writing empty clips', async () => {
    const twoOfThree: VoicesArg = {
      voices: [CLEAN_VOICES.voices[0], { voiceIndex: 1, notes: [] }, CLEAN_VOICES.voices[2]],
    };
    const h = makeHarness({ llmResults: [llmResponse(twoOfThree)] });
    await generateEnsemble(h.track, h.services);
    // 2 filled voices → anchor + ONE created track, 2 clips.
    expect(h.calls.filter(c => c.startsWith('createFamilyTrack'))).toHaveLength(1);
    expect(h.calls.filter(c => c.startsWith('writeMidiClip'))).toHaveLength(2);
  });

  it('retries ONCE with the violation report when soft rules fail, keeping the better attempt', async () => {
    // Parallel-fifth homorhythmic pair → counterpoint violations on attempt 1.
    // All pitches DIATONIC to A minor so the enforce layer's scale snap
    // cannot accidentally repair the parallels before analysis sees them.
    const dirty: VoicesArg = {
      voices: [
        { voiceIndex: 0, notes: [
          { pitch: 76, startBeat: 0, durationBeats: 1, velocity: 100 }, // E5
          { pitch: 74, startBeat: 1, durationBeats: 1, velocity: 100 }, // D5
        ] },
        { voiceIndex: 1, notes: [
          { pitch: 69, startBeat: 0, durationBeats: 1, velocity: 100 }, // A4 (P5 below E5)
          { pitch: 67, startBeat: 1, durationBeats: 1, velocity: 100 }, // G4 (P5 below D5)
        ] },
        { voiceIndex: 2, notes: [{ pitch: 45, startBeat: 0, durationBeats: 4, velocity: 100 }] },
      ],
    };
    const h = makeHarness({ llmResults: [llmResponse(dirty), llmResponse(CLEAN_VOICES)] });
    await generateEnsemble(h.track, h.services);
    expect(h.llmRequests).toHaveLength(2);
    const retryUser = (h.llmRequests[1].contents[0].parts[0] as { text: string }).text;
    expect(retryUser).toContain('these problems');
    expect(retryUser).toMatch(/Parallel (fifths|octaves)/);
  });

  it('refuses to blow the track budget', async () => {
    const h = makeHarness({ trackCount: ENSEMBLE_MAX_TRACKS });
    await expect(generateEnsemble(h.track, h.services)).rejects.toThrow(/track panel budget/);
    expect(h.calls.filter(c => c.startsWith('createFamilyTrack'))).toHaveLength(0);
  });

  it('rolls back created tracks LIFO when a clip write fails', async () => {
    const h = makeHarness({ failClipWrite: true });
    await expect(generateEnsemble(h.track, h.services)).rejects.toThrow('engine says no');
    const deletes = h.calls.filter(c => c.startsWith('deleteTrack'));
    expect(deletes).toEqual(['deleteTrack:eng-new-v2', 'deleteTrack:eng-new-v1']);
  });
});
