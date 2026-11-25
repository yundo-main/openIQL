import type { QueryAST } from './ast.js';
import { parse, type Limits } from './parser.js';
import { resolve, type ResolveOptions } from './resolver.js';
import type { ResolvedQuery } from './resolved.js';
import type { Schema } from './schema.js';

export * from './ast.js';
export * from './errors.js';
export * from './lexer.js';
export * from './parser.js';
export * from './schema.js';
export * from './resolved.js';
export * from './functions.js';
export * from './resolver.js';
export * from './printer.js';

/** Parse + validate + resolve in one step. Throws OpenIQLError subclasses. */
export function analyze(
  source: string,
  schema: Schema,
  options: ResolveOptions & { limits?: Partial<Limits> } = {},
): { ast: QueryAST; resolved: ResolvedQuery } {
  const ast = parse(source, options.limits);
  return { ast, resolved: resolve(ast, schema, { ...options, source }) };
}

/** Contract implemented by every backend adapter. */
export interface Adapter<TOutput, TOptions = unknown> {
  transpile(query: ResolvedQuery, options?: TOptions): TOutput;
}
