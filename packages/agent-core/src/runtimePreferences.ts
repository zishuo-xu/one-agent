export type InteractionLocale = 'auto' | 'zh-CN' | 'en-US';

export interface RuntimePreferences {
  locale: InteractionLocale;
  customInstructions: string;
}

export function runtimePreferenceInstruction(
  preferences: RuntimePreferences,
): string {
  const language = preferences.locale === 'zh-CN'
    ? 'Use Simplified Chinese for all user-visible content, including final answers, plan descriptions, explanations, summaries, and sub-agent reports. Keep code, API names, identifiers, paths, and required structured-output keys in their original form.'
    : preferences.locale === 'en-US'
      ? 'Use English for all user-visible content, including final answers, plan descriptions, explanations, summaries, and sub-agent reports. Keep code, API names, identifiers, paths, and required structured-output keys in their original form.'
      : 'Use the language of the user\'s latest request for all user-visible content, including final answers, plan descriptions, explanations, summaries, and sub-agent reports. Keep code, API names, identifiers, paths, and required structured-output keys in their original form.';
  const custom = preferences.customInstructions.trim();
  if (!custom) return language;
  return `${language} Follow these user preferences when they do not conflict with safety, tool rules, or required structured-output contracts:\n${custom}`;
}

export function resolveDisplayLocale(
  locale: InteractionLocale,
  sample = '',
): Exclude<InteractionLocale, 'auto'> {
  if (locale !== 'auto') return locale;
  return /[\u3400-\u9fff]/u.test(sample) ? 'zh-CN' : 'en-US';
}

export function localizedText(
  locale: InteractionLocale,
  sample: string,
  translations: { zhCN: string; enUS: string },
): string {
  return resolveDisplayLocale(locale, sample) === 'zh-CN'
    ? translations.zhCN
    : translations.enUS;
}
