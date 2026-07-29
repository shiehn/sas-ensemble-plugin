/**
 * Meter-awareness of the ensemble system prompt (P8b multi-time-signature).
 *
 * BYTE-IDENTITY PIN: the snapshots below are recorded from the SDK's
 * `buildEnsembleSystemPrompt` — the exact string the plugin sent as its
 * system prompt BEFORE the meter wrapper existed. The plugin-side wrapper
 * (`buildEnsembleSystemPromptWithMeter`) must reproduce these bytes exactly
 * for omitted / '4/4' / unparseable meters. Never `--ci`-update these
 * snapshots as part of a meter change; a diff here means 4/4 behavior
 * drifted.
 */
import {
  buildEnsembleSystemPrompt,
  defaultVoiceSpecs,
} from '@signalsandsorcery/plugin-sdk';
import { buildEnsembleSystemPromptWithMeter } from '../ensemble-meter';

describe('SDK buildEnsembleSystemPrompt — 4/4 byte pins (pre-meter output)', () => {
  it('strings/counterpoint (5 voices)', () => {
    expect(buildEnsembleSystemPrompt(defaultVoiceSpecs(5, 'strings'), 'counterpoint', 'strings')).toMatchSnapshot();
  });

  it('horns/stabs (4 voices)', () => {
    expect(buildEnsembleSystemPrompt(defaultVoiceSpecs(4, 'horns'), 'stabs', 'horns')).toMatchSnapshot();
  });

  it('winds/chorale (4 voices)', () => {
    expect(buildEnsembleSystemPrompt(defaultVoiceSpecs(4, 'winds'), 'chorale', 'winds')).toMatchSnapshot();
  });
});

describe('buildEnsembleSystemPromptWithMeter — 4/4 byte identity', () => {
  it("omitted, explicit '4/4', and unparseable meters reproduce the SDK prompt byte-for-byte", () => {
    const specs = defaultVoiceSpecs(5, 'strings');
    const sdk = buildEnsembleSystemPrompt(specs, 'counterpoint', 'strings');
    expect(buildEnsembleSystemPromptWithMeter(specs, 'counterpoint', 'strings')).toBe(sdk);
    expect(buildEnsembleSystemPromptWithMeter(specs, 'counterpoint', 'strings', '4/4')).toBe(sdk);
    expect(buildEnsembleSystemPromptWithMeter(specs, 'counterpoint', 'strings', 'waltz')).toBe(sdk);
    const horns = buildEnsembleSystemPrompt(defaultVoiceSpecs(4, 'horns'), 'stabs', 'horns');
    expect(buildEnsembleSystemPromptWithMeter(defaultVoiceSpecs(4, 'horns'), 'stabs', 'horns', '4/4')).toBe(horns);
  });
});

describe('buildEnsembleSystemPromptWithMeter — non-4/4 meters', () => {
  it('6/8 keeps the SDK rules verbatim and appends compound-duple guidance + the vocabulary clarifier', () => {
    const specs = defaultVoiceSpecs(5, 'strings');
    const sdk = buildEnsembleSystemPrompt(specs, 'counterpoint', 'strings');
    const prompt = buildEnsembleSystemPromptWithMeter(specs, 'counterpoint', 'strings', '6/8');
    expect(prompt.startsWith(sdk)).toBe(true); // coordination physics untouched
    expect(prompt).toContain('Time signature 6/8 — meter rules:');
    expect(prompt).toContain('SECOND pulse');
    expect(prompt).toContain('defined by THIS meter\'s grouping');
  });

  it('7/8 horns append the asymmetric rules with the fractional bar span', () => {
    const specs = defaultVoiceSpecs(4, 'horns');
    const prompt = buildEnsembleSystemPromptWithMeter(specs, 'stabs', 'horns', '7/8');
    expect(prompt).toContain('Time signature 7/8 — meter rules:');
    expect(prompt).toContain('3.5 quarter notes');
    expect(prompt).toContain('2+2+3');
  });
});
