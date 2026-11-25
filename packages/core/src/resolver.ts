import type {
  ASTNode,
  ComparisonOperator,
  FunctionCallValue,
  LiteralValue,
  QueryAST,
  Span,
} from './ast.js';
import {
  LimitExceededError,
  OpenIQLError,
  UnknownFieldError,
  ValidationError,
  locate,
} from './errors.js';
import { BUILTIN_FUNCTIONS, type IQLFunction } from './functions.js';
import type { ResolvedNode, ResolvedQuery, ResolvedValue } from './resolved.js';
import type { ResolvedField, Schema } from './schema.js';

export interface ResolveContext {
  /** Identifier bound by `currentUser()`. */
  userId?: string;
  /** Clock used by time functions. Default: `new Date()`. */
  now?: Date;
}

export interface ResolveOptions {
  context?: ResolveContext;
  /** Extra functions (names are matched case-insensitively). Override built-ins on conflict. */
  functions?: Record<string, IQLFunction>;
  /** Original query text; when given, errors carry line/column. */
  source?: string;
  /** Maximum AST depth (guards against hostile JSON ASTs). Default 1000. */
  maxAstDepth?: number;
  /** Maximum ORDER BY items. Default 10. */
  maxOrderByItems?: number;
  /** Maximum IN-list size for JSON ASTs. Default 100. */
  maxInListSize?: number;
}

const COMPARISON_OPS: ReadonlySet<string> = new Set(['=', '!=', '>', '>=', '<', '<=', '~', '!~']);
const ORDERING_OPS: ReadonlySet<string> = new Set(['>', '>=', '<', '<=']);
const TEXT_OPS: ReadonlySet<string> = new Set(['~', '!~']);

const DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function parseDate(s: string): string | null {
  if (!DATE_RE.test(s)) return null;
  let t = s.replace(' ', 'T');
  if (!t.includes('T')) t += 'T00:00:00Z';
  else if (!/(Z|[+-]\d{2}:?\d{2})$/.test(t)) t += 'Z';
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Validates an AST (parsed or supplied as untrusted JSON) against a schema,
 * evaluates functions, coerces values to field types and returns a normalised tree.
 */
export function resolve(ast: QueryAST, schema: Schema, options: ResolveOptions = {}): ResolvedQuery {
  return new Resolver(schema, options).query(ast);
}

class Resolver {
  private readonly functions: Record<string, IQLFunction>;
  private readonly now: Date;
  private readonly userId: string | undefined;
  private readonly maxAstDepth: number;
  private readonly maxOrderBy: number;
  private readonly maxInList: number;

  constructor(
    private readonly schema: Schema,
    private readonly opts: ResolveOptions,
  ) {
    this.functions = { ...BUILTIN_FUNCTIONS };
    for (const [k, v] of Object.entries(opts.functions ?? {})) this.functions[k.toLowerCase()] = v;
    this.now = opts.context?.now ?? new Date();
    this.userId = opts.context?.userId;
    this.maxAstDepth = opts.maxAstDepth ?? 1000;
    this.maxOrderBy = opts.maxOrderByItems ?? 10;
    this.maxInList = opts.maxInListSize ?? 100;
  }

  private loc(span?: Span) {
    return span && this.opts.source !== undefined ? locate(this.opts.source, span.start) : undefined;
  }

  private fail(message: string, span?: Span): never {
    const loc = this.loc(span);
    throw new ValidationError(loc ? `${message} at line ${loc.line}, column ${loc.column}` : message, loc, span);
  }

  query(ast: QueryAST): ResolvedQuery {
    if (typeof ast !== 'object' || ast === null) this.fail('AST must be an object');
    const orderBy = ast.orderBy ?? [];
    if (!Array.isArray(orderBy)) this.fail("'orderBy' must be an array");
    if (orderBy.length > this.maxOrderBy) {
      throw new LimitExceededError(
        'maxOrderByItems',
        this.maxOrderBy,
        `ORDER BY has ${orderBy.length} items; the maximum is ${this.maxOrderBy}`,
      );
    }
    return {
      where: ast.where == null ? null : this.node(ast.where, 0),
      orderBy: orderBy.map((o) => {
        if (o?.direction !== 'ASC' && o?.direction !== 'DESC') {
          this.fail(`Invalid ORDER BY direction '${String(o?.direction)}'`, o?.span);
        }
        return { field: this.field(o.field, o.span), direction: o.direction };
      }),
    };
  }

  private field(name: unknown, span?: Span): ResolvedField {
    try {
      return this.schema.resolveField(name);
    } catch (e) {
      if (e instanceof UnknownFieldError) {
        const loc = this.loc(span);
        throw new UnknownFieldError(
          e.field,
          loc,
          span,
        );
      }
      throw e;
    }
  }

  private node(n: ASTNode, depth: number): ResolvedNode {
    if (depth > this.maxAstDepth) {
      throw new LimitExceededError('maxAstDepth', this.maxAstDepth, `AST nesting exceeds ${this.maxAstDepth}`);
    }
    if (typeof n !== 'object' || n === null) this.fail('AST node must be an object');
    switch (n.type) {
      case 'Logical':
        if (n.operator !== 'AND' && n.operator !== 'OR') {
          this.fail(`Invalid logical operator '${String(n.operator)}'`, n.span);
        }
        return {
          type: 'Logical',
          operator: n.operator,
          left: this.node(n.left, depth + 1),
          right: this.node(n.right, depth + 1),
        };
      case 'Not':
        return { type: 'Not', operand: this.node(n.operand, depth + 1) };
      case 'Comparison': {
        const field = this.field(n.field, n.span);
        if (!COMPARISON_OPS.has(n.operator)) this.fail(`Invalid operator '${String(n.operator)}'`, n.span);
        this.checkOperator(field, n.operator, n.span);
        return {
          type: 'Comparison',
          field,
          operator: n.operator,
          value: this.coerce(n.value, field, TEXT_OPS.has(n.operator)),
        };
      }
      case 'List': {
        const field = this.field(n.field, n.span);
        if (n.operator !== 'IN' && n.operator !== 'NOT IN') this.fail(`Invalid operator '${String(n.operator)}'`, n.span);
        if (!Array.isArray(n.values) || n.values.length === 0) this.fail('IN list must not be empty', n.span);
        if (n.values.length > this.maxInList) {
          throw new LimitExceededError(
            'maxInListSize',
            this.maxInList,
            `IN list has ${n.values.length} elements; the maximum is ${this.maxInList}`,
          );
        }
        return {
          type: 'List',
          field,
          operator: n.operator,
          values: n.values.map((v) => this.coerce(v, field, false)),
        };
      }
      case 'NullCheck': {
        const field = this.field(n.field, n.span);
        if (n.operator !== 'IS EMPTY' && n.operator !== 'IS NOT EMPTY') {
          this.fail(`Invalid operator '${String(n.operator)}'`, n.span);
        }
        return { type: 'NullCheck', field, operator: n.operator };
      }
      case 'History': {
        const field = this.field(n.field, n.span);
        if (n.operator === 'WAS') {
          if (!n.value) this.fail("'WAS' requires a value", n.span);
          return { type: 'History', field, operator: 'WAS', value: this.evaluate(n.value) };
        }
        if (n.operator === 'CHANGED') {
          return {
            type: 'History',
            field,
            operator: 'CHANGED',
            ...(n.fromValue ? { fromValue: this.evaluate(n.fromValue) } : {}),
            ...(n.toValue ? { toValue: this.evaluate(n.toValue) } : {}),
          };
        }
        return this.fail(`Invalid history operator '${String(n.operator)}'`, n.span);
      }
      default:
        return this.fail(`Unknown AST node type '${String((n as { type?: unknown }).type)}'`);
    }
  }

  private checkOperator(field: ResolvedField, op: ComparisonOperator, span?: Span): void {
    if (TEXT_OPS.has(op) && field.type !== 'STRING') {
      this.fail(`Operator '${op}' is only supported for STRING fields; '${field.name}' is ${field.type}`, span);
    }
    if (ORDERING_OPS.has(op) && field.type !== 'NUMBER' && field.type !== 'DATE') {
      this.fail(`Operator '${op}' is only supported for NUMBER and DATE fields; '${field.name}' is ${field.type}`, span);
    }
  }

  /** Evaluates literals and function calls into a typed value, without field-type coercion. */
  private evaluate(v: LiteralValue | FunctionCallValue): ResolvedValue {
    if (typeof v !== 'object' || v === null) return this.fail('Value must be an object');
    const sp = v.span;
    switch (v.kind) {
      case 'string':
        if (typeof v.value !== 'string') return this.fail('String value must be a string', sp);
        return { kind: 'string', value: v.value };
      case 'number':
        if (typeof v.value !== 'number' || !Number.isFinite(v.value)) {
          return this.fail('Number value must be a finite number', sp);
        }
        return { kind: 'number', value: v.value };
      case 'boolean':
        if (typeof v.value !== 'boolean') return this.fail('Boolean value must be a boolean', sp);
        return { kind: 'boolean', value: v.value };
      case 'duration':
        return this.fail('Duration literals are only allowed as function arguments', v.span);
      case 'function':
        return this.call(v);
      default:
        return this.fail(`Unknown value kind '${String((v as { kind?: unknown }).kind)}'`);
    }
  }

  private call(v: FunctionCallValue): ResolvedValue {
    const fn = Object.hasOwn(this.functions, String(v.name).toLowerCase())
      ? this.functions[String(v.name).toLowerCase()]
      : undefined;
    if (!fn) return this.fail(`Unknown function '${String(v.name)}'`, v.span);
    const args = Array.isArray(v.args) ? v.args : [];
    if (args.length < fn.minArgs || args.length > fn.maxArgs) {
      return this.fail(
        `Function '${v.name}' expects ${fn.minArgs === fn.maxArgs ? fn.minArgs : `${fn.minArgs}-${fn.maxArgs}`} argument(s), got ${args.length}`,
        v.span,
      );
    }
    for (const a of args) {
      if (typeof a !== 'object' || a === null || a.kind === ('function' as string)) {
        return this.fail('Function arguments must be literals', v.span);
      }
    }
    return fn.evaluate(args, { userId: this.userId, now: this.now }, (m) => this.fail(m, v.span));
  }

  private coerce(
    v: LiteralValue | FunctionCallValue,
    field: ResolvedField,
    requireText: boolean,
  ): ResolvedValue {
    const r = this.evaluate(v);
    const span = (v as { span?: Span }).span;
    const mismatch = (): never =>
      this.fail(`Cannot compare ${field.type} field '${field.name}' with a ${r.kind} value`, span);
    switch (field.type) {
      case 'STRING':
        if (r.kind === 'date') return mismatch();
        if (requireText && r.kind !== 'string') return mismatch();
        return r.kind === 'string' ? r : { kind: 'string', value: String(r.value) };
      case 'NUMBER':
        return r.kind === 'number' ? r : mismatch();
      case 'BOOLEAN':
        return r.kind === 'boolean' ? r : mismatch();
      case 'DATE': {
        if (r.kind === 'date') return r;
        if (r.kind === 'string') {
          const d = parseDate(r.value);
          if (d) return { kind: 'date', value: d };
          return this.fail(`'${r.value}' is not a valid date for field '${field.name}'`, span);
        }
        return mismatch();
      }
    }
  }
}

export { OpenIQLError };
