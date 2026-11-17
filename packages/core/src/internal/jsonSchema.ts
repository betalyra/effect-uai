import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec"
import { JsonSchema, Schema } from "effect"

/**
 * Effect's JSON Schema leaves objects open (`additionalProperties: true`),
 * matching its decoder. A schema the model must fill is a contract, and the
 * strict providers (OpenAI, Anthropic, Mistral) reject an open object, so
 * objects are closed here. Decoding is unchanged.
 */
const toJson = (
  schema: Schema.Top,
  target: StandardJSONSchemaV1.Target,
): Record<string, unknown> => {
  const doc = Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" })
  if (target === "draft-2020-12") {
    return {
      $schema: JsonSchema.META_SCHEMA_URI_DRAFT_2020_12,
      ...doc.schema,
      ...(Object.keys(doc.definitions).length > 0 && { $defs: doc.definitions }),
    }
  }
  if (target === "draft-07") {
    const doc07 = JsonSchema.toDocumentDraft07(doc)
    return {
      $schema: JsonSchema.META_SCHEMA_URI_DRAFT_07,
      ...doc07.schema,
      ...(Object.keys(doc07.definitions).length > 0 && { definitions: doc07.definitions }),
    }
  }
  // The Standard JSON Schema contract: a converter throws on a target it cannot produce.
  throw new Error(`Unsupported JSON Schema target: ${target}`)
}

/** An Effect schema as Standard Schema plus Standard JSON Schema, with closed objects. */
export const toStandard = <S extends Schema.Codec<any, any, never, any>>(
  schema: S,
): S & StandardSchemaV1<unknown, S["Type"]> & StandardJSONSchemaV1<unknown, S["Type"]> => {
  const standard = Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(schema))
  // `standard` is a fresh copy, so replacing its converter touches nothing shared.
  return Object.defineProperty(standard, "~standard", {
    value: {
      ...standard["~standard"],
      jsonSchema: {
        input: (options: StandardJSONSchemaV1.Options) => toJson(schema, options.target),
        output: (options: StandardJSONSchemaV1.Options) =>
          toJson(Schema.toType(schema), options.target),
      },
    },
    writable: true,
    configurable: true,
  })
}
