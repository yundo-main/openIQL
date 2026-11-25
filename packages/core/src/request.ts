import { ValidationError } from './errors.js';
import { parse, type Limits } from './parser.js';
import { resolve, type ResolveOptions } from './resolver.js';
import type { QueryAST } from './ast.js';
import type { ResolvedQuery } from './resolved.js';
import type { Schema } from './schema.js';

/**
 * HTTP search-entry parameters, mirroring the `?q=` / `?filter=` API spec.
 * `q` is a text query; `filter` is the standard JSON AST (object or JSON string).
 */
export interface RequestParams {
  q?: unknown;
  filter?: unknown;
}

export interface AnalyzedRequest {
  /** Which parameter was used, or null when neither was given. */
  source: 'q' | 'filter' | null;
  ast: QueryAST;
  resolved: ResolvedQuery;
}

const EMPTY: QueryAST = { where: null, orderBy: [] };

/**
 * Entry point for search endpoints: accepts `?q=` text queries and `?filter=`
 * JSON ASTs through one pipeline. Specifying both is a ValidationError;
 * specifying neither yields an unconditional (match-all) query.
 * The `filter` AST is validated as untrusted input (schema whitelist,
 * depth/arity limits) inside `resolve`.
 */
export function analyzeRequest(
  params: RequestParams,
  schema: Schema,
  options: ResolveOptions & { limits?: Partial<Limits> } = {},
): AnalyzedRequest {
  const hasQ = params.q !== undefined && params.q !== null;
  const hasFilter = params.filter !== undefined && params.filter !== null;
  if (hasQ && hasFilter) {
    throw new ValidationError("Specify either 'q' or 'filter', not both");
  }
  if (hasQ) {
    if (typeof params.q !== 'string') {
      throw new ValidationError(`'q' must be a string, got ${typeof params.q}`);
    }
    const ast = parse(params.q, options.limits);
    return { source: 'q', ast, resolved: resolve(ast, schema, { ...options, source: params.q }) };
  }
  if (hasFilter) {
    let ast: unknown = params.filter;
    if (typeof ast === 'string') {
      try {
        ast = JSON.parse(ast);
      } catch {
        throw new ValidationError("'filter' is not valid JSON");
      }
    }
    if (typeof ast !== 'object' || ast === null) {
      throw new ValidationError("'filter' must be a JSON AST object");
    }
    const resolved = resolve(ast as QueryAST, schema, options);
    return { source: 'filter', ast: ast as QueryAST, resolved };
  }
  return { source: null, ast: EMPTY, resolved: resolve(EMPTY, schema, options) };
}
