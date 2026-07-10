/**
 * Ensemble voice-group metadata — the bass plugin's voice-group shape,
 * verbatim discipline: membership is per-member scene-data under
 * `track:<dbId>:ensembleVoice`, the anchor is voiceIndex 0 and carries the
 * group prompt under the standard prompt key, and regeneration reconciles
 * positionally (reused voices KEEP the user's presets).
 */

import type {
  GroupParseSpec,
  ResolvedTrackGroup,
  GeneratorTrackState,
} from '@signalsandsorcery/plugin-sdk';

export const ENSEMBLE_VOICE_META_KEY = 'ensembleVoice';
/** Anchor-held ensemble config (voiceCount + style), same scene-data channel. */
export const ENSEMBLE_CONFIG_KEY = 'ensembleConfig';

export interface EnsembleVoiceMeta {
  /** dbId of the anchor (voice 0). */
  groupId: string;
  /** 0 = top voice; increases downward. */
  voiceIndex: number;
  /** Spec label shown in the voice row ("high florid line"). */
  label: string;
  /** Role stamped on the voice's track ('lead', 'strings', '808s', …). */
  role: string;
}

export function asEnsembleVoiceMeta(val: unknown): EnsembleVoiceMeta | null {
  if (!val || typeof val !== 'object') return null;
  const m = val as Partial<EnsembleVoiceMeta>;
  if (typeof m.groupId !== 'string' || typeof m.voiceIndex !== 'number') return null;
  return {
    groupId: m.groupId,
    voiceIndex: m.voiceIndex,
    label: typeof m.label === 'string' ? m.label : '',
    role: typeof m.role === 'string' ? m.role : '',
  };
}

export const ensembleVoiceGroupSpec: GroupParseSpec<EnsembleVoiceMeta> = {
  metaKey: ENSEMBLE_VOICE_META_KEY,
  asMeta: asEnsembleVoiceMeta,
  groupIdOf: (m) => m.groupId,
  sortMembers: (a, b) => a.meta.voiceIndex - b.meta.voiceIndex,
};

export function ensembleGroupIsComplete(
  group: ResolvedTrackGroup<EnsembleVoiceMeta, GeneratorTrackState>,
): boolean {
  return group.members.some((m) => m.meta.voiceIndex === 0);
}

// --- reconcile planner (pure; the bass plugin's shape) ---

export interface ReconcileMember {
  dbId: string;
  engineId: string;
  voiceIndex: number;
}

export interface ReconcilePlan {
  reuse: Array<{ dbId: string; engineId: string; bucketIndex: number }>;
  createBucketIndexes: number[];
  remove: Array<{ dbId: string; engineId: string }>;
}

/**
 * Pair existing members with the new voice list positionally: index 0 (the
 * anchor) is always reused, so the groupId and the prompt key never move;
 * extra voices are created, surplus members removed. Reused voices keep
 * their presets unconditionally.
 */
export function planReconcile(existing: ReconcileMember[], bucketCount: number): ReconcilePlan {
  const sorted = [...existing].sort((a, b) => a.voiceIndex - b.voiceIndex);
  const reuse: ReconcilePlan['reuse'] = [];
  const createBucketIndexes: number[] = [];
  const remove: ReconcilePlan['remove'] = [];
  for (let i = 0; i < bucketCount; i++) {
    const member = sorted[i];
    if (member) reuse.push({ dbId: member.dbId, engineId: member.engineId, bucketIndex: i });
    else createBucketIndexes.push(i);
  }
  for (let i = bucketCount; i < sorted.length; i++) {
    remove.push({ dbId: sorted[i].dbId, engineId: sorted[i].engineId });
  }
  return { reuse, createBucketIndexes, remove };
}

// --- ensemble config (anchor-held) ---

export interface EnsembleConfig {
  voiceCount: number;
  style: string;
}

export function asEnsembleConfig(val: unknown): EnsembleConfig | null {
  if (!val || typeof val !== 'object') return null;
  const c = val as Partial<EnsembleConfig>;
  if (typeof c.voiceCount !== 'number' || typeof c.style !== 'string') return null;
  return { voiceCount: c.voiceCount, style: c.style };
}

/**
 * Deterministic prompt hints for the FIRST generate (before the group header
 * with its explicit controls exists): "4 voices" / "3-part" sets the count,
 * a literal style word sets the style. Explicit config always wins.
 */
export function parsePromptHints(prompt: string): { voiceCount?: number; style?: string } {
  const hints: { voiceCount?: number; style?: string } = {};
  const count = /(\d+)\s*[- ]?\s*(?:voice|part|line)s?\b/i.exec(prompt);
  if (count) hints.voiceCount = parseInt(count[1], 10);
  const style = /\b(counterpoint|chorale|interlock)\b/i.exec(prompt);
  if (style) hints.style = style[1].toLowerCase();
  return hints;
}
