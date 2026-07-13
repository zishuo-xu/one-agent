/**
 * Extract the first top-level JSON object from a raw model output.
 *
 * The model may wrap the JSON in markdown fences or prefix it with explanatory
 * text. This helper strips the fences and tries to locate a JSON object before
 * the caller parses and validates it.
 */
export function extractJsonObject(raw: string): string | undefined {
  let cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();

  try {
    JSON.parse(cleaned);
    return cleaned;
  } catch {
    // Continue to regex fallback.
  }

  const match = cleaned.match(/\{[\s\S]*\}/);
  return match ? match[0] : undefined;
}
