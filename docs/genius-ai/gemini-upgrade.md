# Gemini upgrade: provider, schema reliability, repair

## Provider
- `src/genius/ai/gemini.ts`: Google Gemini `generateContent`, key in the `x-goog-api-key` header, structured output through `generationConfig.responseJsonSchema`. One step-down to plain JSON mode if the API rejects the schema. Thinking level per model; dropped once if the model rejects it.
- `src/genius/ai/quota.ts`: local RPM / TPM / RPD tracker per model plus a cooldown after a 429. It is a safety margin (Google counts per project, this lives in one server isolate), not an authoritative meter.
- `src/genius/ai/deepseek.ts`: optional, OFF. Constructed only with `GENIUS_PROVIDER=deepseek`, `DEEPSEEK_API_KEY` and `DEEPSEEK_ALLOW_PAID_USAGE=true`. Never a fallback. No provider-to-provider routing exists.
- Groq is removed (adapter, config, UI text, tests). A test fails if the word returns to `src/`.

## Schema reliability (one contract)
The zod schemas in `src/genius/blueprint/schema.ts` are the single contract. The prompt's compact schema, the JSON Schema sent to Gemini, the runtime validator and the compiler all derive from them (`ai-core.ts`, `strictSchema.ts`). Responses go through: JSON parse -> envelope -> safe normalisation -> six validation stages -> bounded repair -> preview.

Safe normalisation (`generate.ts`, `strictSchema.ts`) only changes what is unambiguous and lists every change (shown in the UI under "Repairs and normalisation"):
- documented `dateRange` wording (`last 7 days` -> `7d`, `this year` -> `year`, ...); an unknown value is left as written and reported as `SCHEMA_INVALID_VALUE`, never turned into `all`;
- a missing `filters` list -> `[]`; a missing `dateRange` -> `all` (no period filter);
- enum case/spacing, boolean/number strings when the type makes the meaning obvious;
- an unknown key that is only a spelling variant of a real key is renamed; any other unknown key is removed and reported.

Structured errors (`validation/index.ts`): `SCHEMA_INVALID_VALUE`, `SCHEMA_INVALID_TYPE`, `SCHEMA_MISSING_REQUIRED`, `SCHEMA_INVALID_FORMAT`, `SCHEMA_UNRECOGNIZED_KEYS`, with the exact path, allowed values, received value, a suggestion when safe, category and whether a person must act.

Repair (`service/run.ts`, `service/fragment-repair.ts`): schema errors are first repaired by sending ONLY the invalid fragments (nearest enclosing array item) with their errors to the fast model; the answer is spliced in only if the path was requested, the shape is unchanged and no `id` changed. If that does not help, one bounded full repair follows. Budget: 2 fragment + 2 full attempts, no identical request is repeated.

## Long input / output
- A request is never truncated: up to 40,000 characters it is sent whole, beyond that it is refused with a clear message.
- Output budgets are per operation (`models.ts`); truncation escalates to the strong model, then retries once with a larger budget; an incomplete answer is never applied.
- Apply is atomic (snapshot, write, verify, restore on failure) and every applied change is a version that can be undone.
