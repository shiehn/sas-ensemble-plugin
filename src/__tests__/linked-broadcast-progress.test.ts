/**
 * 🔗 Apply-All progress + completion feedback (@since SDK 2.49.0) — the
 * observable contract of the SDK's runLinkedBroadcast, which drives the
 * blocking "Applying sound to all parts…" overlay and the completion toast
 * for linked ensemble/arp groups. Tested from this repo because the SDK
 * carries no jest of its own (SDK changes are exercised through the plugin
 * suites, per the monorepo test discipline).
 */

import {
  runLinkedBroadcast,
  type GroupBroadcastProgress,
} from '@signalsandsorcery/plugin-sdk';

type ToastCall = { type: 'success' | 'warning'; title: string; message?: string };

function makeSinks(): {
  progress: Array<GroupBroadcastProgress | null>;
  toasts: ToastCall[];
  onProgress: (p: GroupBroadcastProgress | null) => void;
  showToast: (type: 'success' | 'warning', title: string, message?: string) => void;
} {
  const progress: Array<GroupBroadcastProgress | null> = [];
  const toasts: ToastCall[] = [];
  return {
    progress,
    toasts,
    onProgress: (p) => progress.push(p),
    showToast: (type, title, message) => toasts.push({ type, title, message }),
  };
}

const targets = [
  { engineId: 'e1', label: 'Voice 2' },
  { engineId: 'e2', label: 'Voice 3' },
  { engineId: 'e3', label: 'Voice 4' },
];

describe('runLinkedBroadcast progress contract', () => {
  it('emits 0/N, one tick per target, then null — and a success toast when all apply', async () => {
    const sinks = makeSinks();
    const applied: string[] = [];
    const result = await runLinkedBroadcast({
      kind: 'sound',
      label: 'Warm Brass',
      targets,
      applyToTarget: async (t) => {
        applied.push(t.engineId);
      },
      onProgress: sinks.onProgress,
      showToast: sinks.showToast,
    });

    expect(applied).toEqual(['e1', 'e2', 'e3']);
    expect(result.failed).toEqual([]);
    expect([...result.appliedIds]).toEqual(['e1', 'e2', 'e3']);
    expect(sinks.progress.map((p) => (p === null ? null : p.done))).toEqual([0, 1, 2, 3, null]);
    expect(sinks.progress[0]).toMatchObject({ kind: 'sound', label: 'Warm Brass', total: 3 });
    expect(sinks.toasts).toEqual([
      { type: 'success', title: 'Linked sound applied to all parts', message: 'Warm Brass → 3 parts' },
    ]);
  });

  it('a failing target keeps the run going, still ticks progress, and warns with Skipped', async () => {
    const sinks = makeSinks();
    const errors: Array<{ engineId: string }> = [];
    const result = await runLinkedBroadcast({
      kind: 'sound',
      label: 'Warm Brass',
      targets,
      applyToTarget: async (t) => {
        if (t.engineId === 'e2') throw new Error('freeze gate refused');
      },
      onProgress: sinks.onProgress,
      showToast: sinks.showToast,
      onTargetError: (t) => errors.push({ engineId: t.engineId }),
    });

    expect(result.failed).toEqual(['Voice 3']);
    expect([...result.appliedIds]).toEqual(['e1', 'e3']);
    expect(errors).toEqual([{ engineId: 'e2' }]);
    // Failures tick too — the bar must reach N/N even when parts are skipped.
    expect(sinks.progress.map((p) => (p === null ? null : p.done))).toEqual([0, 1, 2, 3, null]);
    expect(sinks.toasts).toEqual([
      {
        type: 'warning',
        title: 'Linked sound applied to some parts only',
        message: 'Skipped: Voice 3',
      },
    ]);
  });

  it('falls back to the engineId in Skipped when a target has no label', async () => {
    const sinks = makeSinks();
    await runLinkedBroadcast({
      kind: 'sound',
      label: 'Warm Brass',
      targets: [{ engineId: 'e9' }],
      applyToTarget: async () => {
        throw new Error('nope');
      },
      onProgress: sinks.onProgress,
      showToast: sinks.showToast,
    });
    expect(sinks.toasts[0]).toMatchObject({ type: 'warning', message: 'Skipped: e9' });
  });

  it('does nothing for an empty target list — no progress, no toast', async () => {
    const sinks = makeSinks();
    const result = await runLinkedBroadcast({
      kind: 'sound',
      label: 'Warm Brass',
      targets: [],
      applyToTarget: async () => {},
      onProgress: sinks.onProgress,
      showToast: sinks.showToast,
    });
    expect(result.appliedIds.size).toBe(0);
    expect(sinks.progress).toEqual([]);
    expect(sinks.toasts).toEqual([]);
  });

  it('singular copy for a one-part group', async () => {
    const sinks = makeSinks();
    await runLinkedBroadcast({
      kind: 'sound',
      label: 'Warm Brass',
      targets: [{ engineId: 'e1', label: 'Voice 2' }],
      applyToTarget: async () => {},
      onProgress: sinks.onProgress,
      showToast: sinks.showToast,
    });
    expect(sinks.toasts).toEqual([
      { type: 'success', title: 'Linked sound applied to all parts', message: 'Warm Brass → 1 part' },
    ]);
  });

  it('instrument kind uses the instrument toast copy', async () => {
    const sinks = makeSinks();
    await runLinkedBroadcast({
      kind: 'instrument',
      label: 'Surge XT',
      targets: [{ engineId: 'e1', label: 'Voice 2' }],
      applyToTarget: async () => {},
      onProgress: sinks.onProgress,
      showToast: sinks.showToast,
    });
    expect(sinks.progress[0]).toMatchObject({ kind: 'instrument', label: 'Surge XT' });
    expect(sinks.toasts).toEqual([
      { type: 'success', title: 'Instrument applied to all parts', message: 'Surge XT → 1 part' },
    ]);
  });

  it('clears progress (null) even when a target throws synchronously-shaped errors', async () => {
    const sinks = makeSinks();
    await runLinkedBroadcast({
      kind: 'sound',
      label: 'X',
      targets,
      applyToTarget: () => {
        throw new Error('sync throw');
      },
      onProgress: sinks.onProgress,
      showToast: sinks.showToast,
    });
    expect(sinks.progress[sinks.progress.length - 1]).toBeNull();
  });
});
