/**
 * 🔗 Apply All (linkSounds) — the ensemble side of the linked-sound feature:
 * the config validator carries the flag, per-voice removal preserves it
 * (count shrink AND anchor handoff), and generation honors it — linked
 * groups share ONE sound (anchor's durable identity, first generation
 * shuffles the anchor once then copies), with a clean fallback to the
 * legacy per-voice shuffle when the services have no sound adapter.
 */

import type {
  GenerationServices,
  GeneratorTrackState,
  LLMToolUseRequest,
  TrackSoundSnapshot,
} from '@signalsandsorcery/plugin-sdk';
import { SUBMIT_ENSEMBLE_TOOL_NAME } from '@signalsandsorcery/plugin-sdk';
import { generateEnsemble } from '../ensemble-generation';
import {
  ENSEMBLE_CONFIG_KEY,
  ENSEMBLE_VOICE_META_KEY,
  asEnsembleConfig,
  type EnsembleVoiceMeta,
} from '../ensemble-voice-meta';
import { prepareVoiceRemoval } from '../remove-voice';

// ---------------------------------------------------------------------------
// Validator carry
// ---------------------------------------------------------------------------

describe('asEnsembleConfig linkSounds carry', () => {
  const base = { voiceCount: 3, style: 'counterpoint' };

  it('carries linkSounds: true and false', () => {
    expect(asEnsembleConfig({ ...base, linkSounds: true })?.linkSounds).toBe(true);
    expect(asEnsembleConfig({ ...base, linkSounds: false })?.linkSounds).toBe(false);
  });

  it('drops non-boolean linkSounds and leaves absent absent', () => {
    const nonBool = asEnsembleConfig({ ...base, linkSounds: 'yes' });
    expect(nonBool).not.toBeNull();
    expect(nonBool && 'linkSounds' in nonBool).toBe(false);
    const absent = asEnsembleConfig(base);
    expect(absent).not.toBeNull();
    expect(absent && 'linkSounds' in absent).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Per-voice removal preserves the toggle
// ---------------------------------------------------------------------------

describe('prepareVoiceRemoval linkSounds carry', () => {
  const keyFor = (dbId: string, suffix: string): string => `track:${dbId}:${suffix}`;
  const meta = (groupId: string, voiceIndex: number): EnsembleVoiceMeta => ({
    groupId,
    voiceIndex,
    label: `v${voiceIndex}`,
    role: 'strings',
  });

  function makeHost(seed: Record<string, unknown>): {
    host: { getSceneData: jest.Mock; setSceneData: jest.Mock };
    data: Map<string, unknown>;
  } {
    const data = new Map<string, unknown>(Object.entries(seed));
    return {
      host: {
        getSceneData: jest.fn(async (_s: string, key: string) => data.get(key) ?? null),
        setSceneData: jest.fn(async (_s: string, key: string, value: unknown) => {
          data.set(key, value);
        }),
      },
      data,
    };
  }

  it('keeps linkSounds through a non-anchor count shrink', async () => {
    const { host, data } = makeHost({
      'track:db-a:ensembleConfig': { voiceCount: 3, style: 'counterpoint', linkSounds: true },
    });
    await prepareVoiceRemoval({
      host,
      sceneId: 'scene-1',
      keyFor,
      members: [
        { dbId: 'db-a', meta: meta('db-a', 0) },
        { dbId: 'db-b', meta: meta('db-a', 1) },
        { dbId: 'db-c', meta: meta('db-a', 2) },
      ],
      deletedDbId: 'db-c',
    });
    expect(data.get('track:db-a:ensembleConfig')).toMatchObject({ voiceCount: 2, linkSounds: true });
  });

  it('keeps linkSounds through an anchor handoff', async () => {
    const { host, data } = makeHost({
      'track:db-a:ensembleConfig': { voiceCount: 3, style: 'counterpoint', linkSounds: true },
      'track:db-a:prompt': 'misty counterpoint',
    });
    await prepareVoiceRemoval({
      host,
      sceneId: 'scene-1',
      keyFor,
      members: [
        { dbId: 'db-a', meta: meta('db-a', 0) },
        { dbId: 'db-b', meta: meta('db-a', 1) },
        { dbId: 'db-c', meta: meta('db-a', 2) },
      ],
      deletedDbId: 'db-a',
    });
    // Config moved to the NEW anchor's key, flag intact.
    expect(data.get('track:db-b:ensembleConfig')).toMatchObject({ voiceCount: 2, linkSounds: true });
  });
});

// ---------------------------------------------------------------------------
// Generation honors the toggle
// ---------------------------------------------------------------------------

type VoicesArg = {
  voices: Array<{
    voiceIndex: number;
    notes: Array<{ pitch: number; startBeat: number; durationBeats: number; velocity: number }>;
  }>;
};

function llmResponse(args: VoicesArg): unknown {
  return {
    candidates: [
      { content: { role: 'model', parts: [{ functionCall: { name: SUBMIT_ENSEMBLE_TOOL_NAME, args } }] } },
    ],
  };
}

const CLEAN_VOICES: VoicesArg = {
  voices: [
    { voiceIndex: 0, notes: [
      { pitch: 81, startBeat: 0, durationBeats: 1, velocity: 100 },
      { pitch: 79, startBeat: 1.5, durationBeats: 0.5, velocity: 90 },
    ] },
    { voiceIndex: 1, notes: [
      { pitch: 64, startBeat: 0.5, durationBeats: 1.5, velocity: 85 },
    ] },
    { voiceIndex: 2, notes: [
      { pitch: 45, startBeat: 0, durationBeats: 4, velocity: 100 },
    ] },
  ],
};

const SNAP: TrackSoundSnapshot = {
  kind: 'preset',
  state: 'BASE64-SHARED',
  label: 'Warm Saw',
  stateType: 'valuetree',
} as TrackSoundSnapshot;

interface Harness {
  services: GenerationServices;
  track: GeneratorTrackState;
  calls: string[];
  sceneData: Map<string, unknown>;
  host: Record<string, jest.Mock>;
  copySnapshot: jest.Mock;
}

function makeHarness(opts: {
  storedConfig?: Record<string, unknown>;
  anchorSnap?: TrackSoundSnapshot | null;
  /** When true, shuffling the anchor makes getTrackSound start returning SNAP. */
  shuffleMintsAnchorPreset?: boolean;
  withSoundAdapter?: boolean;
} = {}): Harness {
  const calls: string[] = [];
  const sceneData = new Map<string, unknown>();
  if (opts.storedConfig) sceneData.set(`track:db-a:${ENSEMBLE_CONFIG_KEY}`, opts.storedConfig);
  let anchorSnap: TrackSoundSnapshot | null = opts.anchorSnap ?? null;

  const host: Record<string, jest.Mock> = {
    getSceneData: jest.fn(async (_scene: string, key: string) => sceneData.get(key) ?? null),
    setSceneData: jest.fn(async (_scene: string, key: string, value: unknown) => {
      calls.push(`setSceneData:${key}`);
      sceneData.set(key, value);
    }),
    deleteSceneData: jest.fn(async () => {}),
    getMusicalContext: jest.fn(async () => ({
      key: 'A', mode: 'minor', bpm: 120, bars: 1, genre: 'dnb',
      timeSignature: '4/4',
      chordProgression: [{ symbol: 'Am', startQn: 0, endQn: 4 }],
      contractPrompt: null,
    })),
    getGenerationContext: jest.fn(async () => ({
      chordProgression: { key: { tonic: 'A', mode: 'minor' }, chordsWithTiming: [], genre: null },
      concurrentTracks: [],
    })),
    generateWithLLMTools: jest.fn(async () => llmResponse(CLEAN_VOICES)),
    writeMidiClip: jest.fn(async (engineId: string) => { calls.push(`writeMidiClip:${engineId}`); return {}; }),
    setTrackRole: jest.fn(async () => {}),
    setTrackMute: jest.fn(async () => {}),
    shufflePreset: jest.fn(async (engineId: string) => {
      calls.push(`shufflePreset:${engineId}`);
      if (opts.shuffleMintsAnchorPreset && engineId === 'eng-a') anchorSnap = SNAP;
      return { presetName: `P-${engineId}`, presetCategory: 'Strings-hi' };
    }),
    getTrackSound: jest.fn(async (dbId: string) => (dbId === 'db-a' ? anchorSnap : null)),
    deleteTrack: jest.fn(async () => {}),
    showToast: jest.fn(),
  };

  const copySnapshot = jest.fn(async (engineId: string) => {
    calls.push(`copySnapshot:${engineId}`);
    return 'Warm Saw';
  });

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
    createFamilyTrack: jest.fn(async (suffix = '') => ({
      id: `eng-new${suffix}`,
      name: `ensemble${suffix}`,
      dbId: `db-new${suffix}`,
    })),
    resolvedGroups: jest.fn(() => []),
    ...(opts.withSoundAdapter === false ? {} : { sound: { copySnapshot } }),
  } as unknown as GenerationServices;

  const track = {
    handle: { id: 'eng-a', name: 'ensemble-1', dbId: 'db-a' },
    prompt: '3 voices, misty counterpoint',
    role: '',
    runtimeState: { muted: false, solo: false },
  } as unknown as GeneratorTrackState;

  return { services, track, calls, sceneData, host, copySnapshot };
}

const LINKED_CONFIG = {
  voiceCount: 3,
  style: 'counterpoint',
  instrumentation: 'strings',
  linkSounds: true,
};

describe('generateEnsemble with linkSounds', () => {
  it('linked regeneration: zero shuffles, anchor snapshot copied to every NEW voice, flag carried', async () => {
    const h = makeHarness({ storedConfig: LINKED_CONFIG, anchorSnap: SNAP });
    await generateEnsemble(h.track, h.services);

    expect(h.host.shufflePreset).not.toHaveBeenCalled();
    // Anchor reused; the 2 new voices copy the shared sound.
    expect(h.calls.filter((c) => c.startsWith('copySnapshot'))).toEqual([
      'copySnapshot:eng-new-v1',
      'copySnapshot:eng-new-v2',
    ]);
    expect(h.copySnapshot).toHaveBeenCalledWith('eng-new-v1', SNAP);
    // The config rewrite must not wipe the toggle.
    expect(h.sceneData.get(`track:db-a:${ENSEMBLE_CONFIG_KEY}`)).toMatchObject({ linkSounds: true });
    // Group metas still written as usual.
    expect(h.sceneData.get(`track:db-a:${ENSEMBLE_VOICE_META_KEY}`)).toMatchObject({ groupId: 'db-a' });
  });

  it('linked FIRST generation: shuffles the anchor exactly once, then copies to the rest', async () => {
    const h = makeHarness({
      storedConfig: LINKED_CONFIG,
      anchorSnap: null,
      shuffleMintsAnchorPreset: true,
    });
    await generateEnsemble(h.track, h.services);

    expect(h.calls.filter((c) => c.startsWith('shufflePreset'))).toEqual(['shufflePreset:eng-a']);
    expect(h.calls.filter((c) => c.startsWith('copySnapshot'))).toEqual([
      'copySnapshot:eng-new-v1',
      'copySnapshot:eng-new-v2',
    ]);
  });

  it('linked but no services.sound adapter: falls back to the legacy per-voice shuffle', async () => {
    const h = makeHarness({ storedConfig: LINKED_CONFIG, anchorSnap: SNAP, withSoundAdapter: false });
    await generateEnsemble(h.track, h.services);

    expect(h.calls.filter((c) => c.startsWith('copySnapshot'))).toHaveLength(0);
    expect(h.calls.filter((c) => c.startsWith('shufflePreset'))).toEqual([
      'shufflePreset:eng-new-v1',
      'shufflePreset:eng-new-v2',
    ]);
  });

  it('unlinked config keeps the historical per-voice shuffle path untouched', async () => {
    const h = makeHarness({
      storedConfig: { voiceCount: 3, style: 'counterpoint', instrumentation: 'strings' },
      anchorSnap: SNAP,
    });
    await generateEnsemble(h.track, h.services);

    expect(h.calls.filter((c) => c.startsWith('copySnapshot'))).toHaveLength(0);
    expect(h.calls.filter((c) => c.startsWith('shufflePreset'))).toEqual([
      'shufflePreset:eng-new-v1',
      'shufflePreset:eng-new-v2',
    ]);
    const written = h.sceneData.get(`track:db-a:${ENSEMBLE_CONFIG_KEY}`) as Record<string, unknown>;
    expect('linkSounds' in written).toBe(false);
  });
});
