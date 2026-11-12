import { z } from 'zod'

/** The typed search specification. Zod only (no UI imports) so the server can use it in prompts and validation. */
export const SearchOp = z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'not_contains', 'in', 'empty', 'not_empty'])
const Scalar = z.union([z.string().max(200), z.number(), z.boolean(), z.null()])
export const SearchFilter = z.strictObject({ field: z.string().min(1).max(80), op: SearchOp, value: z.union([Scalar, z.array(Scalar).max(20)]).optional(), module: z.string().max(80).optional() })
export const RelatedCondition = z.strictObject({
  /** the related module (a parent of the searched records, or a child that points at them) */
  module: z.string().min(1).max(80),
  where: z.array(SearchFilter).min(1).max(4),
  /** true (default): at least one related record matches; false: none does */
  exists: z.boolean().optional(),
})
export const QuerySpec = z.strictObject({
  /** module names or ids; empty = every module the user may open */
  scope: z.array(z.string().max(80)).max(12).optional(),
  text: z.string().max(200).optional(),
  filters: z.array(SearchFilter).max(8).optional(),
  related: z.array(RelatedCondition).max(3).optional(),
  sort: z.array(z.strictObject({ field: z.string().max(80), dir: z.enum(['asc', 'desc']) })).max(2).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  offset: z.number().int().min(0).max(5000).optional(),
  aggregate: z.strictObject({ op: z.enum(['count', 'sum', 'avg', 'min', 'max']), field: z.string().max(80).optional() }).optional(),
})
export type QuerySpec = z.infer<typeof QuerySpec>
export type SearchFilter = z.infer<typeof SearchFilter>

