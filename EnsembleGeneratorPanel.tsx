/**
 * Ensemble panel — a thin GeneratorPanelAdapter over the SDK panel-core
 * (the bass plugin's container with a different brain). One voice-group per
 * ensemble: the anchor (voice 0) carries the prompt; the group header adds
 * the two explicit intent controls the bass panel doesn't need — voice
 * count (2-6) and style (counterpoint / chorale / interlock) — persisted in
 * scene-data under the anchor (`track:<anchorDbId>:ensembleConfig`).
 *
 * Per-voice sound choice stays mechanical: each voice's role (lead /
 * strings / bass / 808s) + its actual register drive shufflePreset's
 * category pick, exactly like every other generator.
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
  parseLLMNoteResponse,
  defaultVoiceSpecs,
  buildEnsembleSystemPrompt,
  ENSEMBLE_MIN_VOICES,
  ENSEMBLE_MAX_VOICES,
  ENSEMBLE_STYLES,
  type EnsembleStyle,
} from '@signalsandsorcery/plugin-sdk';
import {
  ENSEMBLE_CONFIG_KEY,
  ENSEMBLE_VOICE_META_KEY,
  asEnsembleConfig,
  ensembleGroupIsComplete,
  ensembleVoiceGroupSpec,
  type EnsembleVoiceMeta,
} from './src/ensemble-voice-meta';
import {
  generateEnsemble,
  ENSEMBLE_MAX_TRACKS,
  DEFAULT_VOICE_COUNT,
  DEFAULT_STYLE,
} from './src/ensemble-generation';

const ESTIMATED_GENERATION_MS = 30000; // one joint call + a possible guided retry

// ============================================================================
// Group row — header (prompt + voices + style + Generate + M/S/✕), voice rows
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

  const [voiceCount, setVoiceCount] = useState<number>(DEFAULT_VOICE_COUNT);
  const [style, setStyle] = useState<EnsembleStyle>(DEFAULT_STYLE);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!scene) return undefined;
    void host.getSceneData(scene, configKey).then((raw) => {
      const cfg = asEnsembleConfig(raw);
      if (cfg && !cancelled) {
        setVoiceCount(Math.max(ENSEMBLE_MIN_VOICES, Math.min(ENSEMBLE_MAX_VOICES, cfg.voiceCount)));
        if ((ENSEMBLE_STYLES as readonly string[]).includes(cfg.style)) {
          setStyle(cfg.style as EnsembleStyle);
        }
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [host, scene, configKey]);

  const persistConfig = (next: { voiceCount: number; style: EnsembleStyle }): void => {
    if (!scene) return;
    void host.setSceneData(scene, configKey, next).catch(() => {});
  };

  const memberEngineIds = group.members.map((m) => m.track.handle.id);
  const allMuted = group.members.every((m) => m.track.runtimeState.muted);
  const anySolo = group.members.some((m) => m.track.runtimeState.solo);
  const isGenerating = group.members.some((m) => m.track.isGenerating);

  return (
    <div style={{ border: '1px solid #8B5CF6', borderRadius: 8, marginBottom: 8, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', background: 'rgba(139, 92, 246, 0.12)' }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: '#A78BFA' }}>ENSEMBLE</span>
        <input
          type="text"
          value={anchorTrack.prompt}
          placeholder='e.g. "solemn rising passage, modern baroque"'
          onChange={(e) => ctx.handlers.promptChange(anchorTrack.handle.id, e.target.value)}
          style={{ flex: 1, minWidth: 80, fontSize: 12, padding: '4px 6px', borderRadius: 4, border: '1px solid #4B5563', background: '#111827', color: '#E5E7EB' }}
          data-testid="ensemble-group-prompt"
        />
        <select
          value={voiceCount}
          onChange={(e) => {
            const next = parseInt(e.target.value, 10);
            setVoiceCount(next);
            persistConfig({ voiceCount: next, style });
          }}
          title="Voices"
          style={{ fontSize: 12 }}
          data-testid="ensemble-voice-count"
        >
          {Array.from({ length: ENSEMBLE_MAX_VOICES - ENSEMBLE_MIN_VOICES + 1 }, (_, i) => ENSEMBLE_MIN_VOICES + i).map((n) => (
            <option key={n} value={n}>{n} voices</option>
          ))}
        </select>
        <select
          value={style}
          onChange={(e) => {
            const next = e.target.value as EnsembleStyle;
            setStyle(next);
            persistConfig({ voiceCount, style: next });
          }}
          title="Style"
          style={{ fontSize: 12 }}
          data-testid="ensemble-style"
        >
          {ENSEMBLE_STYLES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <button
          onClick={() => ctx.handlers.generate(anchorTrack.handle.id)}
          disabled={isGenerating}
          title="Regenerate the whole ensemble"
          style={{ fontSize: 12 }}
          data-testid="ensemble-generate"
        >
          {isGenerating ? '…' : 'Generate'}
        </button>
        <button onClick={() => ctx.setGroupMute(memberEngineIds, !allMuted)} title="Mute group" style={{ fontSize: 12, opacity: allMuted ? 1 : 0.6 }}>M</button>
        <button onClick={() => ctx.setGroupSolo(memberEngineIds, !anySolo)} title="Solo group" style={{ fontSize: 12, opacity: anySolo ? 1 : 0.6 }}>S</button>
        <button onClick={() => setConfirmDelete(true)} title="Delete ensemble" style={{ fontSize: 12 }}>✕</button>
      </div>

      {group.members.map((m) => (
        <React.Fragment key={m.track.handle.id}>
          {ctx.renderDefaultTrackRow(m.track)}
        </React.Fragment>
      ))}

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
              [ENSEMBLE_VOICE_META_KEY, ENSEMBLE_CONFIG_KEY, 'prompt', 'soundHistory', 'role'],
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
    },
    createTrackOptions: () => ({ loadSynth: true, synthName: 'Surge XT' }),
    applyPortedTrackSound: async (handle: PluginTrackHandle) => {
      try {
        await host.shufflePreset(handle.id);
      } catch {
        /* non-fatal */
      }
    },
    // The core's generic path wants a system prompt; the real generation goes
    // through generateEnsemble (schema-forced tools call), so this is only a
    // sane fallback shape.
    buildSystemPrompt: () => buildEnsembleSystemPrompt(defaultVoiceSpecs(DEFAULT_VOICE_COUNT), DEFAULT_STYLE),
    parseNotesResponse: parseLLMNoteResponse,
    sound: surgeSound,
    shuffle: {
      shuffle: async (track, excludeNames) => {
        const result = await host.shufflePreset(track.handle.id, excludeNames);
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
