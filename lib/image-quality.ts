import type { ChannelType, SafeImageModel } from '@/types';

/**
 * Channel types that actually forward the `quality` parameter upstream.
 *
 * Verified against lib/image-generator.ts:
 * - `openai-compatible` -> generateWithOpenAI sends `quality` as a JSON field of
 *   POST /v1/images/generations.
 * - `openai-edits` -> generateWithOpenAIEdits sends `quality` as a form field of
 *   POST /v1/images/edits.
 *
 * The apexerapi (gemini native) and openai-chat paths never forward it, so
 * exposing the control there would promise a choice the backend silently drops.
 */
const QUALITY_AWARE_CHANNEL_TYPES: ReadonlySet<ChannelType> = new Set<ChannelType>([
  'openai-compatible',
  'openai-edits',
]);

/**
 * Models whose upstream API accepts `quality`. Kept identical to the admin form
 * gate in app/admin/image-channels/page.tsx so both sides agree on which models
 * expose the control. Models whose name already encodes the quality (e.g.
 * `gpt-image-medium`) are intentionally excluded.
 */
const QUALITY_AWARE_API_MODEL = 'gpt-image-2';

export type ImageQualityOption = {
  value: string;
  label: string;
};

export const IMAGE_QUALITY_OPTIONS: ImageQualityOption[] = [
  { value: 'low', label: '\u4f4e' },
  { value: 'medium', label: '\u4e2d' },
  { value: 'high', label: '\u9ad8' },
];

export const DEFAULT_IMAGE_QUALITY = 'medium';

export function supportsQualityControl(model: SafeImageModel | undefined): boolean {
  if (!model) return false;
  return (
    QUALITY_AWARE_CHANNEL_TYPES.has(model.channelType) &&
    model.apiModel.toLowerCase().includes(QUALITY_AWARE_API_MODEL)
  );
}

/**
 * Qualities the picker may offer for `model`, in display order. An empty array
 * means the model cannot use the parameter at all.
 */
export function getQualityOptions(model: SafeImageModel | undefined): ImageQualityOption[] {
  if (!supportsQualityControl(model)) return [];
  const configured = model!.features.qualityOptions;
  // An empty or missing list means "every quality", matching the admin form
  // where an empty list renders all checkboxes as checked.
  if (!configured || configured.length === 0) return [...IMAGE_QUALITY_OPTIONS];
  return IMAGE_QUALITY_OPTIONS.filter((option) => configured.includes(option.value));
}

/**
 * Resolves the quality to send upstream: `undefined` when the model cannot use
 * it, the preferred value when allowed, otherwise the first allowed option.
 * Callers render and submit the same value, so the UI never shows a quality the
 * request does not carry.
 */
export function resolveImageQuality(
  model: SafeImageModel | undefined,
  preferred: string
): string | undefined {
  const options = getQualityOptions(model);
  if (options.length === 0) return undefined;
  return options.some((option) => option.value === preferred) ? preferred : options[0].value;
}

/**
 * Whether the given API model name participates in the `quality` parameter
 * pipeline. Mirrors the model-name leg of `supportsQualityControl`; the
 * channel-type leg requires a full `SafeImageModel` and is not checked here.
 * Useful for read paths (admin history, audit logs) that only have the model
 * string on hand.
 */
export function isQualityAwareModelName(model: string | undefined): boolean {
  if (!model) return false;
  return model.toLowerCase().includes(QUALITY_AWARE_API_MODEL);
}
