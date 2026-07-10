import {
  asEnsembleConfig,
  asEnsembleVoiceMeta,
  ensembleGroupIsComplete,
  parsePromptHints,
  planReconcile,
} from '../ensemble-voice-meta';

describe('asEnsembleVoiceMeta', () => {
  it('narrows valid metas and rejects malformed ones', () => {
    expect(asEnsembleVoiceMeta({ groupId: 'db-a', voiceIndex: 2, label: 'inner voice', role: 'strings' }))
      .toEqual({ groupId: 'db-a', voiceIndex: 2, label: 'inner voice', role: 'strings' });
    expect(asEnsembleVoiceMeta({ groupId: 'db-a' })).toBeNull();
    expect(asEnsembleVoiceMeta(null)).toBeNull();
    expect(asEnsembleVoiceMeta('nope')).toBeNull();
    // Missing label/role degrade to '' rather than rejecting the member.
    expect(asEnsembleVoiceMeta({ groupId: 'g', voiceIndex: 0 }))
      .toEqual({ groupId: 'g', voiceIndex: 0, label: '', role: '' });
  });
});

describe('ensembleGroupIsComplete', () => {
  it('requires the anchor (voiceIndex 0)', () => {
    const member = (voiceIndex: number) => ({
      dbId: `db-${voiceIndex}`,
      track: {} as never,
      meta: { groupId: 'db-0', voiceIndex, label: '', role: '' },
    });
    expect(ensembleGroupIsComplete({ groupId: 'db-0', members: [member(0), member(1)] } as never)).toBe(true);
    expect(ensembleGroupIsComplete({ groupId: 'db-0', members: [member(1), member(2)] } as never)).toBe(false);
  });
});

describe('planReconcile', () => {
  const member = (voiceIndex: number) => ({
    dbId: `db-${voiceIndex}`,
    engineId: `eng-${voiceIndex}`,
    voiceIndex,
  });

  it('reuses positionally, creates extras, removes surplus — anchor always reused', () => {
    const grow = planReconcile([member(0), member(1)], 4);
    expect(grow.reuse).toEqual([
      { dbId: 'db-0', engineId: 'eng-0', bucketIndex: 0 },
      { dbId: 'db-1', engineId: 'eng-1', bucketIndex: 1 },
    ]);
    expect(grow.createBucketIndexes).toEqual([2, 3]);
    expect(grow.remove).toEqual([]);

    const shrink = planReconcile([member(0), member(1), member(2)], 1);
    expect(shrink.reuse).toEqual([{ dbId: 'db-0', engineId: 'eng-0', bucketIndex: 0 }]);
    expect(shrink.createBucketIndexes).toEqual([]);
    expect(shrink.remove).toEqual([
      { dbId: 'db-1', engineId: 'eng-1' },
      { dbId: 'db-2', engineId: 'eng-2' },
    ]);
  });

  it('sorts by voiceIndex before pairing so scrambled input cannot displace the anchor', () => {
    const plan = planReconcile([member(2), member(0), member(1)], 2);
    expect(plan.reuse[0]).toEqual({ dbId: 'db-0', engineId: 'eng-0', bucketIndex: 0 });
    expect(plan.remove).toEqual([{ dbId: 'db-2', engineId: 'eng-2' }]);
  });
});

describe('parsePromptHints', () => {
  it('extracts voice count and style words deterministically', () => {
    expect(parsePromptHints('a solemn 4-voice passage')).toEqual({ voiceCount: 4 });
    expect(parsePromptHints('3 part chorale for evening')).toEqual({ voiceCount: 3, style: 'chorale' });
    expect(parsePromptHints('minimal interlock, 6 lines')).toEqual({ voiceCount: 6, style: 'interlock' });
    expect(parsePromptHints('misty strings')).toEqual({});
  });
});

describe('asEnsembleConfig', () => {
  it('narrows stored config', () => {
    expect(asEnsembleConfig({ voiceCount: 5, style: 'counterpoint' }))
      .toEqual({ voiceCount: 5, style: 'counterpoint' });
    expect(asEnsembleConfig({ voiceCount: '5' })).toBeNull();
    expect(asEnsembleConfig(null)).toBeNull();
  });
});
