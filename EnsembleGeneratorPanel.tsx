/**
 * Ensemble panel — a thin GeneratorPanelAdapter over the SDK panel-core
 * (the bass plugin's container with a different brain). One voice-group per
 * ensemble: the anchor (voice 0) carries the prompt; the group header adds
 * the three explicit intent controls — INSTRUMENTATION (Strings / Horns /
 * Winds, the parent mode), style (gated by the parent: woven trio for
 * strings/winds, section trio for horns), and voice count (2-6) — persisted
 * in scene-data under the anchor (`track:<anchorDbId>:ensembleConfig`).
 *
 * Newborn tracks are stamped as a voice-group of ONE (`onTrackCreated`, the
 * arp plugin's pattern) so all three controls exist BEFORE the first
 * expensive generation — never config-by-regeneration.
 *
 * Per-voice sound choice stays mechanical and category-level: each voice's
 * role ('strings' / 'brass' / 'winds' / …) + its actual register drive
 * shufflePreset's pick. Surge XT is a placeholder — users re-target sampled
 * libraries, which is why specs carry real instrument registers.
 */

import React, { useEffect, useMemo, useState } from 'react';
import type {
  PluginUIProps,
  PluginHost,
  PluginTrackHandle,
  GeneratorPanelAdapter,
  GeneratorTrackState,
  GroupRenderContext,
  ResolvedTrackGroup,
} from '@signalsandsorcery/plugin-sdk';
import {
  GeneratorPanelShell,
  useGeneratorPanelCore,
  createSurgeSoundAdapter,
  ConfirmDialog,
  GroupCollapseChevron,
  parseLLMNoteResponse,
  promptEnterToGenerate,
  defaultVoiceSpecs,
  buildEnsembleSystemPrompt,
  ENSEMBLE_MIN_VOICES,
  ENSEMBLE_MAX_VOICES,
  ENSEMBLE_INSTRUMENTATIONS,
  STYLES_FOR_INSTRUMENTATION,
  normalizeInstrumentation,
  styleForInstrumentation,
  type EnsembleInstrumentation,
  type EnsembleStyle,
} from '@signalsandsorcery/plugin-sdk';
import {
  ENSEMBLE_CONFIG_KEY,
  ENSEMBLE_VOICE_META_KEY,
  asEnsembleConfig,
  ensembleGroupIsComplete,
  ensembleVoiceGroupSpec,
  stampEnsembleAnchor,
  type EnsembleVoiceMeta,
} from './src/ensemble-voice-meta';
import {
  generateEnsemble,
  ENSEMBLE_MAX_TRACKS,
  DEFAULT_VOICE_COUNT,
  DEFAULT_STYLE,
} from './src/ensemble-generation';
import { prepareVoiceRemoval } from './src/remove-voice';

const ESTIMATED_GENERATION_MS = 30000; // one joint call + a possible guided retry

// ============================================================================
// Group row — header (prompt + instrumentation + style + voices + Generate +
// M/S/✕), voice rows
// ============================================================================

function EnsembleVoiceGroupRow({
  group,
  ctx,
}: {
  group: ResolvedTrackGroup<EnsembleVoiceMeta, GeneratorTrackState>;
  ctx: GroupRenderContext;
}): React.ReactElement {
  const anchor = group.members.find((m) => m.meta.voiceIndex === 0) ?? group.members[0];
  const anchorTrack = anchor.track;
  const scene = ctx.services.activeSceneId;
  const host = ctx.services.host;
  const configKey = ctx.services.trackDataKey(anchor.dbId, ENSEMBLE_CONFIG_KEY);

  const [instrumentation, setInstrumentation] = useState<EnsembleInstrumentation>('strings');
  const [voiceCount, setVoiceCount] = useState<number>(DEFAULT_VOICE_COUNT);
  const [style, setStyle] = useState<EnsembleStyle>(DEFAULT_STYLE);
  const [linkSounds, setLinkSounds] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!scene) return undefined;
    void host.getSceneData(scene, configKey).then((raw) => {
      const cfg = asEnsembleConfig(raw);
      if (cfg && !cancelled) {
        // Instrumentation first: the style domain depends on it (absent on
        // pre-instrumentation configs → 'strings', the historical behavior).
        const instr = normalizeInstrumentation(cfg.instrumentation);
        setInstrumentation(instr);
        setVoiceCount(Math.max(ENSEMBLE_MIN_VOICES, Math.min(ENSEMBLE_MAX_VOICES, cfg.voiceCount)));
        setStyle(styleForInstrumentation(instr, cfg.style));
        setLinkSounds(cfg.linkSounds === true);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
    // members.length: a per-voice delete rewrites the stored config (count
    // shrink) — re-sync the header controls when the group's shape changes.
  }, [host, scene, configKey, group.members.length]);

  const persistConfig = (next: {
    voiceCount: number;
    style: EnsembleStyle;
    instrumentation: EnsembleInstrumentation;
    linkSounds: boolean;
  }): void => {
    if (!scene) return;
    void host.setSceneData(scene, configKey, next).catch(() => {});
  };

  const memberEngineIds = group.members.map((m) => m.track.handle.id);
  const allMuted = group.members.every((m) => m.track.runtimeState.muted);
  const anySolo = group.members.some((m) => m.track.runtimeState.solo);
  const isGenerating = group.members.some((m) => m.track.isGenerating);
  const generateDisabled = isGenerating || !anchorTrack.prompt.trim();

  // Per-voice delete (TrackRow's own ConfirmDialog gates the click): scene-data
  // surgery first — config shrink, anchor handoff when voice 0 goes — then the
  // track + key scrub. Abort on surgery failure so the group is never left
  // half-re-pointed with the voice already gone.
  const handleVoiceDelete = (member: (typeof group.members)[number]): void => {
    void (async () => {
      try {
        if (scene) {
          await prepareVoiceRemoval({
            host,
            sceneId: scene,
            keyFor: ctx.services.trackDataKey,
            members: group.members.map((gm) => ({ dbId: gm.dbId, meta: gm.meta })),
            deletedDbId: member.dbId,
          });
        }
      } catch (err) {
        host.showToast('error', 'Failed to delete voice', err instanceof Error ? err.message : String(err));
        return;
      }
      await ctx.deleteGroup(
        [{ engineId: member.track.handle.id, dbId: member.dbId }],
        [ENSEMBLE_VOICE_META_KEY, ENSEMBLE_CONFIG_KEY, 'prompt', 'soundHistory', 'role', 'groupUi'],
      );
    })();
  };

  return (
    <div
      data-testid={`ensemble-group-${group.groupId}`}
      className="rounded-sm border border-sas-border bg-sas-panel-alt overflow-hidden"
      style={{ borderLeftColor: '#8B5CF6', borderLeftWidth: '3px' }}
    >
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-sas-border">
        <GroupCollapseChevron collapsed={ctx.collapsed} onToggle={ctx.onToggleCollapse} what="ensemble" />
        <span className="text-[9px] uppercase tracking-wide text-sas-muted whitespace-nowrap">
          Ensemble · {group.members.length} {group.members.length === 1 ? 'voice' : 'voices'}
        </span>
        <input
          type="text"
          value={anchorTrack.prompt}
          placeholder="Describe the ensemble…"
          onChange={(e) => ctx.handlers.promptChange(anchorTrack.handle.id, e.target.value)}
          onKeyDown={promptEnterToGenerate(
            () => ctx.handlers.generate(anchorTrack.handle.id),
            generateDisabled
          )}
          className="flex-1 min-w-0 bg-sas-panel border border-sas-border rounded-sm px-2 py-0.5 text-xs text-sas-text placeholder:text-sas-muted/50 focus:border-sas-accent focus:outline-none"
          data-testid="ensemble-group-prompt"
        />
        <select
          value={instrumentation}
          onChange={(e) => {
            const next = normalizeInstrumentation(e.target.value);
            // Keep the style when the new parent also offers it
            // (strings ↔ winds); otherwise fall to the parent's default
            // (horns → stabs) — never a style the mode can't honor.
            const nextStyle = styleForInstrumentation(next, style);
            setInstrumentation(next);
            setStyle(nextStyle);
            persistConfig({ voiceCount, style: nextStyle, instrumentation: next, linkSounds });
          }}
          title="Instrumentation — picks the voice registers, roles and rule family; the style menu follows it"
          className="text-xs bg-sas-panel border border-sas-border rounded-sm px-1 py-0.5 text-sas-text"
          data-testid="ensemble-instrumentation"
        >
          {ENSEMBLE_INSTRUMENTATIONS.map((m) => (
            <option key={m} value={m}>{m.charAt(0).toUpperCase() + m.slice(1)}</option>
          ))}
        </select>
        <select
          value={style}
          onChange={(e) => {
            const next = e.target.value as EnsembleStyle;
            setStyle(next);
            persistConfig({ voiceCount, style: next, instrumentation, linkSounds });
          }}
          title="Style"
          className="text-xs bg-sas-panel border border-sas-border rounded-sm px-1 py-0.5 text-sas-text"
          data-testid="ensemble-style"
        >
          {STYLES_FOR_INSTRUMENTATION[instrumentation].map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <select
          value={voiceCount}
          onChange={(e) => {
            const next = parseInt(e.target.value, 10);
            setVoiceCount(next);
            persistConfig({ voiceCount: next, style, instrumentation, linkSounds });
          }}
          title="Voices"
          className="text-xs bg-sas-panel border border-sas-border rounded-sm px-1 py-0.5 text-sas-text"
          data-testid="ensemble-voice-count"
        >
          {Array.from({ length: ENSEMBLE_MAX_VOICES - ENSEMBLE_MIN_VOICES + 1 }, (_, i) => ENSEMBLE_MIN_VOICES + i).map((n) => (
            <option key={n} value={n}>{n} voices</option>
          ))}
        </select>
        <button
          onClick={() => {
            const next = !linkSounds;
            setLinkSounds(next);
            persistConfig({ voiceCount, style, instrumentation, linkSounds: next });
          }}
          title={
            linkSounds
              ? 'Apply All is ON — Shuffle, History restore and Import on any voice apply the same sound to every voice'
              : 'Apply All — apply sound changes (Shuffle / History / Import) on any voice to all voices together'
          }
          className={`px-1.5 py-0.5 text-[10px] font-bold rounded-sm border transition-colors whitespace-nowrap ${
            linkSounds
              ? 'bg-sas-accent/20 border-sas-accent text-sas-accent'
              : 'bg-sas-panel border-sas-border text-sas-muted hover:border-sas-accent'
          }`}
          data-testid="ensemble-link-sounds"
        >
          🔗 All
        </button>
        <button
          onClick={() => ctx.handlers.generate(anchorTrack.handle.id)}
          disabled={generateDisabled}
          title="Regenerate the whole ensemble"
          className={`px-2 py-0.5 text-[10px] font-medium rounded-sm border transition-colors ${
            generateDisabled
              ? 'bg-sas-panel border-sas-border text-sas-muted/50 cursor-not-allowed'
              : 'bg-sas-accent/10 border-sas-accent/30 text-sas-accent hover:bg-sas-accent/20'
          }`}
          data-testid="ensemble-generate"
        >
          {isGenerating ? 'Generating…' : 'Generate'}
        </button>
        <button
          onClick={() => ctx.setGroupMute(memberEngineIds, !allMuted)}
          title="Mute group"
          className={`px-1.5 py-0.5 text-[10px] font-bold rounded-sm border transition-colors ${
            allMuted
              ? 'bg-red-500/20 border-red-500/40 text-red-400'
              : 'bg-sas-panel border-sas-border text-sas-muted hover:border-sas-accent'
          }`}
        >
          M
        </button>
        <button
          onClick={() => ctx.setGroupSolo(memberEngineIds, !anySolo)}
          title="Solo group"
          className={`px-1.5 py-0.5 text-[10px] font-bold rounded-sm border transition-colors ${
            anySolo
              ? 'bg-yellow-500/20 border-yellow-500/40 text-yellow-400'
              : 'bg-sas-panel border-sas-border text-sas-muted hover:border-sas-accent'
          }`}
        >
          S
        </button>
        <button
          onClick={() => setConfirmDelete(true)}
          title="Delete ensemble"
          className="px-1.5 py-0.5 text-[10px] rounded-sm border border-sas-border text-sas-muted hover:border-red-500/60 hover:text-red-400 transition-colors"
        >
          ✕
        </button>
      </div>

      {!ctx.collapsed && (
        <div className="p-1 space-y-1">
          {group.members.map((m) =>
            ctx.renderDefaultTrackRow(m.track, {
              // The prompt field shows the MECHANICAL voice label ("countermelody",
              // "bassline"); the ensemble intent lives on the group header (the
              // anchor's prompt key). Per-voice generate/copy are off (the group
              // owns those). Delete IS per-voice: it shrinks the group (and the
              // stored voice count) instead of regenerating.
              prompt: m.meta.label || 'ensemble voice',
              onPromptChange: undefined,
              onGenerate: undefined,
              onCopy: undefined,
              onDelete: () => handleVoiceDelete(m),
              linkedSoundHint:
                linkSounds && group.members.length > 1
                  ? `🔗 Sound changes apply to all ${group.members.length} parts`
                  : undefined,
              // One-shot sync — the only propagation control that works for
              // patches picked inside a custom plugin's own editor.
              onSyncSoundToGroup:
                linkSounds && group.members.length > 1
                  ? () => ctx.handlers.syncSoundToGroup(m.track.handle.id)
                  : undefined,
            }),
          )}
        </div>
      )}

      {confirmDelete && (
        <ConfirmDialog
          open={confirmDelete}
          title="Delete ensemble?"
          message={`Removes all ${group.members.length} voice tracks of this ensemble.`}
          confirmLabel="Delete"
          onConfirm={() => {
            setConfirmDelete(false);
            void ctx.deleteGroup(
              group.members.map((m) => ({ engineId: m.track.handle.id, dbId: m.dbId })),
              [ENSEMBLE_VOICE_META_KEY, ENSEMBLE_CONFIG_KEY, 'prompt', 'soundHistory', 'role', 'groupUi'],
            );
          }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </div>
  );
}

// ============================================================================
// Adapter + panel
// ============================================================================

function createEnsembleGeneratorAdapter(host: PluginHost): GeneratorPanelAdapter<EnsembleVoiceMeta> {
  const surgeSound = createSurgeSoundAdapter(host);
  return {
    identity: {
      familyKey: 'ensemble',
      familyLabel: 'Ensemble',
      trackNamePrefix: 'ensemble',
      logTag: 'EnsembleGeneratorPanel',
      accentColor: '#8B5CF6',
      transitionAccentColor: '#9333EA',
      placeholderAccentColor: '#6366F1',
      maxTracks: ENSEMBLE_MAX_TRACKS,
      estimatedGenerationMs: ESTIMATED_GENERATION_MS,
      addTrackLabel: 'Add Ensemble',
    },
    features: {
      instrumentPicker: true,
      bulkComposePlaceholders: false,
      exportMidi: true,
      transitionDesigner: false,
      importTracks: false,
      // Bus-strip DSP clusters (DUCK + WOB): kick-derived sidechain pump
      // (ghost grids work with no kicks) and tempo-locked motion — filter
      // wobble, amp gate/tremolo, auto-pan. Rendered per-sample in the
      // engine, identical live and bounced.
      busSidechain: true,
      busMotion: true,
    },
    createTrackOptions: () => ({ loadSynth: true, synthName: 'Surge XT' }),
    applyPortedTrackSound: async (handle: PluginTrackHandle) => {
      try {
        await host.shufflePreset(handle.id);
      } catch {
        /* non-fatal */
      }
    },
    // Every newborn track is anchored as a voice-group of ONE so the header
    // controls (instrumentation / style / voices) are visible BEFORE the
    // first generation — configure first, generate once (the arp pattern).
    onTrackCreated: async (handle, ctx) => {
      await stampEnsembleAnchor(host, ctx.activeSceneId, ctx.trackDataKey, handle.dbId);
    },
    // The core's generic path wants a system prompt; the real generation goes
    // through generateEnsemble (schema-forced tools call), so this is only a
    // sane fallback shape.
    buildSystemPrompt: () => buildEnsembleSystemPrompt(defaultVoiceSpecs(DEFAULT_VOICE_COUNT), DEFAULT_STYLE),
    parseNotesResponse: parseLLMNoteResponse,
    sound: {
      ...surgeSound,
      // 🔗 Apply All: ALL linked siblings of a voice, or null when the
      // group's toggle is OFF / the track is loose. The core filters per
      // broadcast kind (preset blobs go only to same-instrument siblings;
      // Pick-tab instrument swaps go to everyone).
      broadcastTargets: async (track, services) => {
        const scene = services.activeSceneId;
        if (!scene) return null;
        const groups = services.resolvedGroups<EnsembleVoiceMeta>(ENSEMBLE_VOICE_META_KEY);
        const group = groups.find((g) => g.members.some((m) => m.dbId === track.handle.dbId));
        if (!group || group.members.length < 2) return null;
        const anchor = group.members.find((m) => m.meta.voiceIndex === 0) ?? group.members[0];
        const raw = await host
          .getSceneData(scene, services.trackDataKey(anchor.dbId, ENSEMBLE_CONFIG_KEY))
          .catch(() => null);
        if (asEnsembleConfig(raw)?.linkSounds !== true) return null;
        return group.members.map((m) => ({
          engineId: m.track.handle.id,
          dbId: m.dbId,
          label: m.meta.label || m.track.handle.name,
        }));
      },
    },
    shuffle: {
      shuffle: async (track, excludeNames) => {
        const result = await host.shufflePreset(track.handle.id, excludeNames, {
          description: track.prompt,
        });
        return { appliedName: result.presetName };
      },
      isExhaustedError: (err) =>
        /no presets available/i.test(err instanceof Error ? err.message : String(err)),
    },
    generation: { generate: generateEnsemble },
    groupExtensions: [
      {
        ...ensembleVoiceGroupSpec,
        isComplete: ensembleGroupIsComplete,
        renderGroup: (group, ctx) => <EnsembleVoiceGroupRow group={group} ctx={ctx} />,
      },
    ],
  };
}

export function EnsembleGeneratorPanel(props: PluginUIProps): React.ReactElement {
  const adapter = useMemo(() => createEnsembleGeneratorAdapter(props.host), [props.host]);
  const core = useGeneratorPanelCore({ ui: props, adapter: adapter as GeneratorPanelAdapter });
  return <GeneratorPanelShell core={core} />;
}

export default EnsembleGeneratorPanel;
