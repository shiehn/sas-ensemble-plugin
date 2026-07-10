/**
 * @signalsandsorcery/ensemble-generator — plugin entry.
 *
 * Ensemble arranger: one prompt → the LLM composes 2-6 voices TOGETHER in a
 * single schema-forced call (register + complexity hierarchy: top voice
 * highest and most florid, bottom voice a sparse root anchor) → the
 * ensemble-core mechanical validator enforces registers, density caps,
 * per-voice monophony, and style rules. Each voice lands on its own
 * Surge XT track as one voice-group. See EnsembleGeneratorPanel.tsx and
 * src/ensemble-generation.ts.
 */

import type { ComponentType } from 'react';
import type {
  GeneratorPlugin,
  PluginHost,
  PluginUIProps,
  PluginSettingsSchema,
} from '@signalsandsorcery/plugin-sdk';
import { EnsembleGeneratorPanel } from './EnsembleGeneratorPanel';
import manifest from './plugin.json';

class EnsembleGeneratorPlugin implements GeneratorPlugin {
  readonly id = '@signalsandsorcery/ensemble-generator';
  readonly displayName = 'Ensemble';
  readonly version = '1.0.0';
  readonly description =
    'Ensemble arranger — one prompt becomes 2-6 jointly-composed counterpoint voices (register + complexity hierarchy, style packs: counterpoint / chorale / interlock), each on its own Surge XT track';
  readonly generatorType = 'midi' as const;
  readonly minHostVersion = '1.0.0';

  private host: PluginHost | null = null;

  async activate(host: PluginHost): Promise<void> {
    this.host = host;
    console.log('[EnsembleGeneratorPlugin] activated');
  }

  async deactivate(): Promise<void> {
    this.host = null;
  }

  getUIComponent(): ComponentType<PluginUIProps> {
    return EnsembleGeneratorPanel;
  }

  getSettingsSchema(): PluginSettingsSchema | null {
    return null;
  }
}

export default EnsembleGeneratorPlugin;
export { EnsembleGeneratorPlugin, EnsembleGeneratorPanel };
export const ensembleManifest = manifest;
