import { ZodTypeAny } from 'zod';
import { zodToJsonSchema as converter } from 'zod-to-json-schema';

export function zodToJsonSchema(schema: ZodTypeAny): Record<string, unknown> {
  const result = converter(schema, {
    name: 'Parameters',
    $refStrategy: 'none',
  }) as Record<string, unknown>;

  // zod-to-json-schema may wrap the result under definitions or $defs.
  const definitions = (result.definitions || result.$defs) as Record<string, unknown> | undefined;
  if (definitions?.Parameters) {
    return definitions.Parameters as Record<string, unknown>;
  }

  return result;
}
