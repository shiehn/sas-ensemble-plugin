/**
 * Per-voice removal: the pure plan and the scene-data surgery (config
 * shrink, anchor handoff, last-voice / miss no-ops).
 */

import { ENSEMBLE_MIN_VOICES } from '@signalsandsorcery/plugin-sdk';
import { planVoiceRemoval, prepareVoiceRemoval, type VoiceRemovalMember } from '../remove-voice';
import {
  ENSEMBLE_CONFIG_KEY,
  ENSEMBLE_VOICE_META_KEY,
  type EnsembleVoiceMeta,
} from '../ensemble-voice-meta';

const keyFor = (dbId: string, suffix: string): string => `track:${dbId}:${suffix}`;

function member(
  dbId: string,
  voiceIndex: number,
  overrides: Partial<EnsembleVoiceMeta> = {},
): VoiceRemovalMember {
  return {
    dbId,
    meta: { groupId: 'a', voiceIndex, label: `v${voiceIndex}`, role: 'lead', ...overrides },
  };
}

function makeStubHost(initial: Record<string, unknown> = {}): {
  data: Map<string, unknown>;
  host: { getSceneData: jest.Mock; setSceneData: jest.Mock };
} {
  const data = new Map<string, unknown>(Object.entries(initial));
  return {
    data,
    host: {
      getSceneData: jest.fn(async (_scene: string, key: string) => data.get(key) ?? null),
      setSceneData: jest.fn(async (_scene: string, key: string, value: unknown) => {
        data.set(key, value);
      }),
    },
  };
}

describe('planVoiceRemoval', () => {
  it('drops the deleted member and keeps voiceIndex order', () => {
    const plan = planVoiceRemoval([member('c', 2), member('a', 0), member('b', 1)], 'b');
    expect(plan.survivors.map((m) => m.dbId)).toEqual(['a', 'c']);
    expect(plan.anchorDbId).toBe('a');
    expect(plan.newAnchorDbId).toBeNull();
  });

  it('promotes the lowest surviving voice when the anchor is deleted', () => {
    const plan = planVoiceRemoval([member('a', 0), member('b', 1), member('c', 2)], 'a');
    expect(plan.newAnchorDbId).toBe('b');
  });

  it('reports no handoff when the last voice is deleted', () => {
    const plan = planVoiceRemoval([member('a', 0)], 'a');
    expect(plan.survivors).toEqual([]);
    expect(plan.newAnchorDbId).toBeNull();
  });
});

describe('prepareVoiceRemoval', () => {
  const members = [member('a', 0), member('b', 1), member('c', 2)];

  it('shrinks the stored voice count on a non-anchor delete (style kept)', async () => {
    const { data, host } = makeStubHost({
      [keyFor('a', ENSEMBLE_CONFIG_KEY)]: { voiceCount: 3, style: 'chorale' },
    });
    await prepareVoiceRemoval({ host, sceneId: 's', keyFor, members, deletedDbId: 'c' });
    expect(data.get(keyFor('a', ENSEMBLE_CONFIG_KEY))).toEqual({
      voiceCount: 2,
      style: 'chorale',
    });
    // No handoff: survivor metas untouched, no prompt copy.
    expect(host.setSceneData).toHaveBeenCalledTimes(1);
  });

  it('does not invent a config when none is stored', async () => {
    const { host } = makeStubHost();
    await prepareVoiceRemoval({ host, sceneId: 's', keyFor, members, deletedDbId: 'c' });
    expect(host.setSceneData).not.toHaveBeenCalled();
  });

  it('hands the group to the next voice when the anchor is deleted', async () => {
    const { data, host } = makeStubHost({
      [keyFor('a', ENSEMBLE_CONFIG_KEY)]: { voiceCount: 3, style: 'interlock' },
      [keyFor('a', 'prompt')]: 'sombre string trio',
    });
    await prepareVoiceRemoval({ host, sceneId: 's', keyFor, members, deletedDbId: 'a' });

    // Config + prompt moved to the new anchor, count shrunk.
    expect(data.get(keyFor('b', ENSEMBLE_CONFIG_KEY))).toEqual({
      voiceCount: 2,
      style: 'interlock',
    });
    expect(data.get(keyFor('b', 'prompt'))).toBe('sombre string trio');

    // Survivors re-pointed; the new anchor takes voiceIndex 0; label + role kept.
    expect(data.get(keyFor('b', ENSEMBLE_VOICE_META_KEY))).toEqual<EnsembleVoiceMeta>({
      groupId: 'b',
      voiceIndex: 0,
      label: 'v1',
      role: 'lead',
    });
    expect(data.get(keyFor('c', ENSEMBLE_VOICE_META_KEY))).toEqual<EnsembleVoiceMeta>({
      groupId: 'b',
      voiceIndex: 2,
      label: 'v2',
      role: 'lead',
    });
  });

  it('clamps the shrunk voice count at the ensemble minimum', async () => {
    const two = [member('a', 0), member('b', 1)];
    const { data, host } = makeStubHost({
      [keyFor('a', ENSEMBLE_CONFIG_KEY)]: { voiceCount: 2, style: 'counterpoint' },
    });
    await prepareVoiceRemoval({ host, sceneId: 's', keyFor, members: two, deletedDbId: 'b' });
    const cfg = data.get(keyFor('a', ENSEMBLE_CONFIG_KEY)) as { voiceCount: number };
    expect(cfg.voiceCount).toBe(ENSEMBLE_MIN_VOICES);
  });

  it('is a no-op for the last voice and for a missing selector', async () => {
    const solo = makeStubHost({
      [keyFor('a', ENSEMBLE_CONFIG_KEY)]: { voiceCount: 2, style: 'chorale' },
    });
    await prepareVoiceRemoval({
      host: solo.host,
      sceneId: 's',
      keyFor,
      members: [member('a', 0)],
      deletedDbId: 'a',
    });
    expect(solo.host.setSceneData).not.toHaveBeenCalled();

    const miss = makeStubHost();
    await prepareVoiceRemoval({ host: miss.host, sceneId: 's', keyFor, members, deletedDbId: 'zzz' });
    expect(miss.host.setSceneData).not.toHaveBeenCalled();
    expect(miss.host.getSceneData).not.toHaveBeenCalled();
  });
});
