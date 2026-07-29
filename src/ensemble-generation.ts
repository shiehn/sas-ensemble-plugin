/**
 * Ensemble generation strategy — the brain.
 *
 * ONE schema-forced LLM call composes ALL voices together
 * (host.generateWithLLMTools, mode 'ANY', submit_ensemble tool), then the
 * ensemble-core mechanical layer enforces the hard contract per voice
 * (register fold, root-only anchor, in-scale snap, per-voice monophony,
 * density caps, stab-length ceiling) and the soft cross-voice rules are
 * analyzed; violations earn ONE guided retry (quota-conscious), keeping
 * whichever attempt scores better.
 *
 * The INSTRUMENTATION axis (strings / horns / winds — ensemble-core's
 * instrumentation.ts) picks the voice-spec table, the rule family (woven
 * vs section), and the style list; per-voice roles ('strings' / 'brass' /
 * 'winds' / …) come from the specs and are category-level only — Surge XT
 * is a placeholder sound, so registers are real instrument ranges.
 *
 * Track lifecycle follows the bass plugin verbatim: positional reconcile
 * (reused voices KEEP the user's presets), clips written before presets,
 * metas last, LIFO rollback on failure, everything spawns muted.
 *
 * NOTE: generateWithLLMTools is a raw Gemini passthrough — unlike
 * generateWithLLM it does NOT auto-prefix the musical context, so this
 * strategy assembles key/BPM/chords/contract + the concurrent-tracks block
 * into the user content itself.
 */

import type {
  GeneratorTrackState,
  GenerationServices,
  PluginTrackHandle,
  MidiClipData,
  LLMToolUseRequest,
  LLMFunctionDeclaration,
} from '@signalsandsorcery/plugin-sdk';
import {
  formatConcurrentTracks,
  defaultVoiceSpecs,
  analyzeEnsemble,
  describeViolations,
  buildViolationRetrySuffix,
  buildSubmitEnsembleParameters,
  parseEnsembleArgs,
  panelClipEndSeconds,
  panelMeter,
  panelQuarterNotesPerBar,
  parseTimeSignature,
  SUBMIT_ENSEMBLE_TOOL_NAME,
  ENSEMBLE_MIN_VOICES,
  ENSEMBLE_MAX_VOICES,
  STYLE_RULES,
  normalizeInstrumentation,
  styleForInstrumentation,
  type EnsembleInstrumentation,
  type EnsembleNote,
  type EnsembleStyle,
  type EnsembleVoiceSpec,
  type ParsedEnsemble,
} from '@signalsandsorcery/plugin-sdk';
import { buildEnsembleSystemPromptWithMeter, enforceVoiceMetered } from './ensemble-meter';
import {
  ENSEMBLE_CONFIG_KEY,
  ENSEMBLE_VOICE_META_KEY,
  asEnsembleConfig,
  parsePromptHints,
  planReconcile,
  type EnsembleVoiceMeta,
  type ReconcileMember,
} from './ensemble-voice-meta';
import { chordLookupsFromTiming, scalePcsFor } from './music-helpers';

export const ENSEMBLE_MAX_TRACKS = 16;
export const DEFAULT_VOICE_COUNT = 5;
export const DEFAULT_STYLE: EnsembleStyle = 'counterpoint';
/** The generation model — tools-capable; matches the platform's BEST tier. */
export const ENSEMBLE_MODEL = 'gemini-3.1-pro-preview';
export const ENSEMBLE_MAX_OUTPUT_TOKENS = 16384;
export const ENSEMBLE_TEMPERATURE = 0.85;

interface FilledVoice {
  spec: EnsembleVoiceSpec;
  notes: EnsembleNote[];
}

export async function generateEnsemble(
  track: GeneratorTrackState,
  services: GenerationServices
): Promise<void> {
  const { host } = services;
  const scene = services.activeSceneId;
  if (!scene) throw new Error('No active scene — select a scene first.');
  const prompt = (track.prompt ?? '').trim();
  if (!prompt) throw new Error('Describe the ensemble first (e.g. "solemn 4-voice passage, rising tension").');

  // ── group / anchor resolution (bass shape) ─────────────────────────────
  const groups = services.resolvedGroups<EnsembleVoiceMeta>(ENSEMBLE_VOICE_META_KEY);
  const promptedDbId = track.handle.dbId;
  const existingGroup = groups.find((g) => g.members.some((m) => m.dbId === promptedDbId)) ?? null;
  const anchorMember = existingGroup?.members.find((m) => m.meta.voiceIndex === 0);
  const anchorTrack = anchorMember ? anchorMember.track : track;
  const anchorDbId = anchorTrack.handle.dbId;
  const anchorPrompt = (anchorTrack.prompt ?? '').trim() || prompt;

  // ── config: stored (header controls) > prompt hints > defaults ────────
  const storedRaw = await host
    .getSceneData(scene, services.trackDataKey(anchorDbId, ENSEMBLE_CONFIG_KEY))
    .catch(() => null);
  const stored = asEnsembleConfig(storedRaw);
  const hints = parsePromptHints(anchorPrompt);
  const instrumentation: EnsembleInstrumentation = normalizeInstrumentation(
    stored?.instrumentation ?? hints.instrumentation
  );
  // styleForInstrumentation clamps into the mode's own list — a group
  // switched to Horns with 'counterpoint' still stored lands on 'stabs',
  // never on a style the mode can't honor.
  const style: EnsembleStyle = styleForInstrumentation(
    instrumentation,
    stored?.style ?? hints.style ?? null
  );
  const voiceCount = Math.max(
    ENSEMBLE_MIN_VOICES,
    Math.min(ENSEMBLE_MAX_VOICES, stored?.voiceCount ?? hints.voiceCount ?? DEFAULT_VOICE_COUNT)
  );
  const specs = defaultVoiceSpecs(voiceCount, instrumentation);

  // ── musical + sibling context (tools path has NO auto-prefix) ─────────
  const musical = await host.getMusicalContext();
  const bars = musical.bars > 0 ? musical.bars : 4;
  const bpm = musical.bpm > 0 ? musical.bpm : 120;
  // Scene meter (P8b): '4/4' for absent/malformed values — every derived
  // number below then reproduces the legacy 4/4 arithmetic exactly.
  const meter = panelMeter(musical);
  const qnPerBar = panelQuarterNotesPerBar(musical);
  // panelMeter guarantees parseability; qnPerSlot drives the density
  // tie-break's beat grid (1 for /4 meters, 0.5 for /8).
  const qnPerSlot = parseTimeSignature(meter).qnPerSlot;

  let concurrentBlock = '';
  try {
    const genCtx = await host.getGenerationContext(anchorTrack.handle.id);
    // Don't make the model write "around" its own previous voices.
    const groupDbIds = new Set((existingGroup?.members ?? []).map((m) => m.dbId));
    concurrentBlock = formatConcurrentTracks({
      ...genCtx,
      concurrentTracks: genCtx.concurrentTracks.filter(
        (t) => !(t.dbId !== undefined && groupDbIds.has(t.dbId))
      ),
    });
  } catch {
    /* sibling context is best-effort, never a gate */
  }

  const chordText = musical.chordProgression.length > 0
    ? musical.chordProgression.map((c) => `${c.symbol} (beats ${c.startQn}-${c.endQn})`).join(', ')
    : 'none';
  const contextText = [
    'Musical Context:',
    `- Key: ${musical.key} ${musical.mode}`,
    `- BPM: ${bpm}`,
    // 4/4 renders `bars * 4` exactly (byte-identity); the meter line only
    // appears on non-4/4 scenes.
    `- Bars: ${bars} (clip = ${bars * qnPerBar} quarter-note beats)`,
    meter !== '4/4' ? `- Time signature: ${meter} (each bar = ${qnPerBar} quarter notes)` : null,
    musical.genre ? `- Genre: ${musical.genre}` : null,
    `- Chord Progression: ${chordText}`,
    musical.contractPrompt ? `- Scene Contract: ${musical.contractPrompt}` : null,
  ].filter(Boolean).join('\n');

  // 4/4 = the SDK prompt byte-identical; other meters append family rules.
  const systemPrompt = buildEnsembleSystemPromptWithMeter(specs, style, instrumentation, meter);
  const baseUser = `${contextText}\n\n${concurrentBlock ? `${concurrentBlock}\n\n` : ''}User request: "${anchorPrompt}"`;

  // ── the joint call (+ at most ONE guided retry) ────────────────────────
  const submitDeclaration: LLMFunctionDeclaration = {
    name: SUBMIT_ENSEMBLE_TOOL_NAME,
    description: `Submit the complete ${voiceCount}-voice ensemble as structured notes.`,
    parameters: buildSubmitEnsembleParameters(voiceCount) as LLMFunctionDeclaration['parameters'],
  };

  const callModel = async (userText: string): Promise<ParsedEnsemble | null> => {
    const request: LLMToolUseRequest = {
      model: ENSEMBLE_MODEL,
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userText }] }],
      tools: [{ functionDeclarations: [submitDeclaration] }],
      toolConfig: {
        functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [SUBMIT_ENSEMBLE_TOOL_NAME] },
      },
      generationConfig: {
        temperature: ENSEMBLE_TEMPERATURE,
        maxOutputTokens: ENSEMBLE_MAX_OUTPUT_TOKENS,
      },
    };
    const response = await host.generateWithLLMTools(request);
    for (const candidate of response.candidates ?? []) {
      for (const part of candidate.content?.parts ?? []) {
        if (part.functionCall && part.functionCall.name === SUBMIT_ENSEMBLE_TOOL_NAME) {
          return parseEnsembleArgs(part.functionCall.args, voiceCount);
        }
      }
    }
    return null;
  };

  const scalePcs = scalePcsFor(musical.key, musical.mode) ?? undefined;
  // Bar windows in the scene meter (4/4 = the legacy bar*4 grid).
  const { chordRootPcAtBar, chordPcsAtBar } = chordLookupsFromTiming(musical.chordProgression, meter);
  const enforceAll = (parsed: ParsedEnsemble): ReturnType<typeof enforceVoiceMetered>[] =>
    specs.map((spec) =>
      enforceVoiceMetered(parsed.voiceNotes[spec.voiceIndex] ?? [], spec, {
        bars,
        chordRootPcAtBar,
        chordPcsAtBar,
        scalePcs,
        // Stab styles carry a mechanical duration ceiling — a punch must
        // not come back from the model as a pad.
        maxNoteDurationBeats: STYLE_RULES[style].maxNoteDurationBeats,
        quarterNotesPerBar: qnPerBar,
        quarterNotesPerSlot: qnPerSlot,
      })
    );

  const first = await callModel(baseUser);
  if (!first) {
    throw new Error('The model returned no usable ensemble — try rephrasing the prompt.');
  }
  let enforced = enforceAll(first);
  let violations = describeViolations(
    analyzeEnsemble(enforced.map((v) => v.notes)),
    STYLE_RULES[style]
  );
  if (violations.length > 0) {
    const second = await callModel(baseUser + buildViolationRetrySuffix(violations)).catch(() => null);
    if (second) {
      const enforcedRetry = enforceAll(second);
      const violationsRetry = describeViolations(
        analyzeEnsemble(enforcedRetry.map((v) => v.notes)),
        STYLE_RULES[style]
      );
      if (violationsRetry.length < violations.length) {
        enforced = enforcedRetry;
        violations = violationsRetry;
      }
    }
  }

  // Voices the model left empty are dropped (fewer tracks, never empty clips).
  const filled: FilledVoice[] = specs
    .map((spec, i) => ({ spec, notes: enforced[i].notes }))
    .filter((v) => v.notes.length > 0);
  if (filled.length === 0) {
    throw new Error('The model returned no notes for any voice — try a more concrete prompt.');
  }

  // ── reconcile + budget ─────────────────────────────────────────────────
  const existingMembers: ReconcileMember[] = existingGroup
    ? existingGroup.members.map((m) => ({
        dbId: m.dbId,
        engineId: m.track.handle.id,
        voiceIndex: m.meta.voiceIndex,
      }))
    : [{ dbId: anchorDbId, engineId: anchorTrack.handle.id, voiceIndex: 0 }];
  const plan = planReconcile(existingMembers, filled.length);
  const liveCount = services.tracks.length;
  if (liveCount - plan.remove.length + plan.createBucketIndexes.length > ENSEMBLE_MAX_TRACKS) {
    throw new Error(
      `This ensemble would exceed the ${ENSEMBLE_MAX_TRACKS}-track panel budget — reduce the voice count or delete tracks first.`
    );
  }

  const clipFor = (notes: EnsembleNote[]): MidiClipData => ({
    startTime: 0,
    // Scene-loop span in the scene meter (4/4 = the legacy bars*4*60/bpm).
    endTime: panelClipEndSeconds({ bars, bpm, timeSignature: meter }),
    tempo: bpm,
    notes: notes.map((n) => ({
      pitch: n.pitch,
      startBeat: n.startBeat,
      durationBeats: n.durationBeats,
      velocity: n.velocity,
      channel: 0,
    })),
  });

  // ── execute: create → clips → role+mute → presets (new only) → metas ──
  const created: PluginTrackHandle[] = [];
  try {
    const memberByBucket = new Map<number, { engineId: string; dbId: string; isNew: boolean }>();
    for (const r of plan.reuse) {
      memberByBucket.set(r.bucketIndex, { engineId: r.engineId, dbId: r.dbId, isNew: false });
    }
    for (const bucketIndex of plan.createBucketIndexes) {
      const handle = await services.createFamilyTrack(`-v${bucketIndex}`);
      created.push(handle);
      memberByBucket.set(bucketIndex, { engineId: handle.id, dbId: handle.dbId, isNew: true });
    }

    // Clips FIRST (preset range-analysis reads real pitches), then role + mute.
    for (let i = 0; i < filled.length; i++) {
      const member = memberByBucket.get(i)!;
      await host.writeMidiClip(member.engineId, clipFor(filled[i].notes));
      await host.setTrackRole(member.engineId, filled[i].spec.role).catch(() => {});
      await host.setTrackMute(member.engineId, true).catch(() => {});
      if (!member.isNew) {
        services.updateTrack(member.engineId, (t) => ({
          ...t,
          runtimeState: { ...t.runtimeState, muted: true },
        }));
      }
    }

    // Presets: 🔗 Apply All groups share ONE sound; otherwise per-voice shuffle.
    const linkSounds = stored?.linkSounds === true;
    if (linkSounds && services.sound && host.getTrackSound) {
      // Every voice carries the group's shared sound — the anchor's durable
      // identity. First-ever generation (no persisted anchor preset yet):
      // shuffle the ANCHOR once (the host persists it), then copy to the rest.
      let snap = await host.getTrackSound(anchorDbId).catch(() => null);
      if (!snap || snap.kind !== 'preset') {
        try {
          await host.shufflePreset(anchorTrack.handle.id, [], { description: prompt });
          snap = await host.getTrackSound(anchorDbId).catch(() => null);
        } catch {
          /* non-fatal — voices fall back to default patches */
        }
      }
      if (snap && snap.kind === 'preset') {
        for (let i = 0; i < filled.length; i++) {
          const member = memberByBucket.get(i)!;
          // Reused voices keep their sound — it IS the shared sound.
          if (!member.isNew) continue;
          try {
            await services.sound.copySnapshot(member.engineId, snap);
          } catch {
            /* non-fatal — default patch */
          }
        }
      }
    } else {
      // Presets for NEW voices only — reused voices keep the user's pick.
      const appliedNames: string[] = [];
      for (let i = 0; i < filled.length; i++) {
        const member = memberByBucket.get(i)!;
        if (!member.isNew) continue;
        try {
          // Semantic retrieval: the ensemble prompt plus this voice's character
          // label ("horn section — high florid line") so each voice draws a
          // register-appropriate patch instead of a random category pick.
          const result = await host.shufflePreset(member.engineId, appliedNames, {
            description: `${prompt} — ${filled[i].spec.label}`,
          });
          appliedNames.push(result.presetName);
        } catch {
          /* non-fatal — default patch */
        }
      }
    }

    // Metas LAST — a mid-flight failure above leaves the OLD group intact.
    for (let i = 0; i < filled.length; i++) {
      const member = memberByBucket.get(i)!;
      const meta: EnsembleVoiceMeta = {
        groupId: anchorDbId,
        voiceIndex: i,
        label: filled[i].spec.label,
        role: filled[i].spec.role,
      };
      await host.setSceneData(scene, services.trackDataKey(member.dbId, ENSEMBLE_VOICE_META_KEY), meta);
    }
    await host.setSceneData(scene, services.trackDataKey(anchorDbId, ENSEMBLE_CONFIG_KEY), {
      voiceCount,
      style,
      instrumentation,
      // Carry 🔗 Apply All through the rewrite — the validator strips unknown
      // fields, so dropping it here would silently turn the toggle off.
      ...(stored?.linkSounds === undefined ? {} : { linkSounds: stored.linkSounds }),
    });

    // Surplus voices: delete track + its group/soundHistory keys.
    for (const surplus of plan.remove) {
      await host.deleteTrack(surplus.engineId).catch(() => {});
      await host
        .deleteSceneData(scene, services.trackDataKey(surplus.dbId, ENSEMBLE_VOICE_META_KEY))
        .catch(() => {});
      await host
        .deleteSceneData(scene, services.trackDataKey(surplus.dbId, 'soundHistory'))
        .catch(() => {});
    }
  } catch (err) {
    // LIFO rollback — remove any tracks created this pass, newest first.
    for (const handle of [...created].reverse()) {
      try {
        await host.deleteTrack(handle.id);
      } catch {
        /* best effort */
      }
      await host
        .deleteSceneData(scene, services.trackDataKey(handle.dbId, ENSEMBLE_VOICE_META_KEY))
        .catch(() => {});
    }
    throw err instanceof Error ? err : new Error(String(err));
  }

  // ── success patch on the anchor + reload ──────────────────────────────
  services.updateTrack(anchorTrack.handle.id, (t) => ({
    ...t,
    isGenerating: false,
    error: null,
    role: filled[0].spec.role,
    hasMidi: true,
    generationProgress: 0,
    editNotes: clipFor(filled[0].notes).notes,
    editBars: bars,
    editBpm: bpm,
    editBeatsPerBar: qnPerBar,
  }));
  services.markEditLoaded(anchorTrack.handle.id);
  host.showToast(
    'success',
    'Ensemble generated',
    `${filled.length} voice${filled.length === 1 ? '' : 's'} · ${instrumentation} · ${style}` +
      (violations.length > 0 ? ` · ${violations.length} soft rule note(s)` : '')
  );
  await services.reloadTracks(true);
}
