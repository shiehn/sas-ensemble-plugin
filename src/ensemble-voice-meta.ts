/**
 * Ensemble voice-group metadata — the bass plugin's voice-group shape,
 * verbatim discipline: membership is per-member scene-data under
 * `track:<dbId>:ensembleVoice`, the anchor is voiceIndex 0 and carries the
 * group prompt under the standard prompt key, and regeneration reconciles
 * positionally (reused voices KEEP the user's presets).
 */

import type {
  GroupParseSpec,
  PluginHost,
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

/**
 * Stamp a NEWBORN track as a voice-group of ONE (anchor, voiceIndex 0) so
 * the group header — with its instrumentation/style/voices controls —
 * exists BEFORE the first generation instead of appearing only after it
 * (pre-fix, the first generate ran blind on defaults/hints and was a
 * throwaway). The arp plugin's `stampArpAnchor` pattern, verbatim; wired
 * via the panel-core's `onTrackCreated` adapter hook.
 *
 * The CONFIG is deliberately NOT stamped: generation resolves
 * stored > prompt hints > defaults, so pre-writing defaults would silently
 * override hints like "3-voice horn stabs". The header persists config only
 * when the user touches a control — explicit beats hints beats defaults.
 */
export async function stampEnsembleAnchor(
  host: Pick<PluginHost, 'setSceneData'>,
  sceneId: string,
  keyFor: (dbId: string, suffix: string) => string,
  dbId: string,
): Promise<void> {
  const meta: EnsembleVoiceMeta = { groupId: dbId, voiceIndex: 0, label: 'ensemble voice', role: '' };
  await host.setSceneData(sceneId, keyFor(dbId, ENSEMBLE_VOICE_META_KEY), meta);
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
  /**
   * Parent mode ('strings' | 'horns' | 'winds'). Optional because
   * pre-instrumentation groups stored only {voiceCount, style} — absent
   * reads as 'strings' (the historical behavior).
   */
  instrumentation?: string;
  /**
   * 🔗 Apply All: preset-level sound changes (shuffle / History restore /
   * Import) on ANY voice propagate the same sound to every voice, and
   * regeneration keeps all voices on the group's shared sound. Absent =
   * false (the historical per-voice behavior).
   */
  linkSounds?: boolean;
}

export function asEnsembleConfig(val: unknown): EnsembleConfig | null {
  if (!val || typeof val !== 'object') return null;
  const c = val as Partial<EnsembleConfig>;
  if (typeof c.voiceCount !== 'number' || typeof c.style !== 'string') return null;
  const config: EnsembleConfig = { voiceCount: c.voiceCount, style: c.style };
  if (typeof c.instrumentation === 'string') config.instrumentation = c.instrumentation;
  if (typeof c.linkSounds === 'boolean') config.linkSounds = c.linkSounds;
  return config;
}

/**
 * Deterministic prompt hints for the FIRST generate (before the user has
 * touched the header controls): "4 voices" / "3-part" sets the count, a
 * literal style word sets the style, and instrument-family words set the
 * parent instrumentation. "french horn" is claimed by WINDS before the
 * generic horn test runs (a french horn is a wind-family voice here, per
 * the mode design). Explicit config always wins.
 */
export function parsePromptHints(prompt: string): {
  voiceCount?: number;
  style?: string;
  instrumentation?: string;
} {
  const hints: { voiceCount?: number; style?: string; instrumentation?: string } = {};
  const count = /(\d+)\s*[- ]?\s*(?:voice|part|line|horn|player)s?\b/i.exec(prompt);
  if (count) hints.voiceCount = parseInt(count[1], 10);
  const style = /\b(counterpoint|chorale|interlock|stabs?|riffs?|unison)\b/i.exec(prompt);
  if (style) {
    const raw = style[1].toLowerCase();
    hints.style = raw === 'stab' ? 'stabs' : raw === 'riff' ? 'riffs' : raw;
  }
  // Family words — the french-horn carve-out must run before the horn test.
  const withoutFrenchHorns = prompt.replace(/\bfrench\s+horns?\b/gi, ' FRENCHHORN ');
  if (/FRENCHHORN/.test(withoutFrenchHorns) && !/\b(brass|trumpets?|sax(?:es|ophones?)?|trombones?)\b/i.test(prompt)) {
    hints.instrumentation = 'winds';
  } else if (/\b(horns?|brass|trumpets?|sax(?:es|ophones?)?|trombones?)\b/i.test(withoutFrenchHorns)) {
    hints.instrumentation = 'horns';
  } else if (/\b(winds?|woodwinds?|flutes?|clarinets?|oboes?|bassoons?)\b/i.test(prompt)) {
    hints.instrumentation = 'winds';
  } else if (/\b(strings?|violins?|violas?|cellos?)\b/i.test(prompt)) {
    hints.instrumentation = 'strings';
  }
  // A section-only style word ("stabs") is itself a horn signal.
  if (!hints.instrumentation && (hints.style === 'stabs' || hints.style === 'riffs' || hints.style === 'unison')) {
    hints.instrumentation = 'horns';
  }
  return hints;
}
