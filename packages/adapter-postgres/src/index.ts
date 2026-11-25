import type {
  Adapter,
  FieldType,
  ResolvedField,
  ResolvedNode,
  ResolvedQuery,
  ResolvedValue,
} from '@openiql/core';

export interface ChangelogOptions {
  table: string;
  issueIdColumn: string;
  fieldColumn: string;
  fromColumn: string;
  toColumn: string;
}

export interface PostgresOptions {
  /** Table (optionally schema-qualified) that holds issues. Default `issues`. */
  table?: string;
  /** Primary key column of the issues table, used to join the changelog. Default `id`. */
  idColumn?: string;
  /** JSONB column holding custom fields. Default `custom_fields`. */
  customFieldsColumn?: string;
  /** Trusted SELECT list. Default `<table>.*`. Never pass user input here. */
  select?: string;
  /** Number of `$n` placeholders already used by the caller's query. Default 0. */
  paramOffset?: number;
  /** Column appended to ORDER BY for deterministic pagination, e.g. `id`. */
  tieBreaker?: string;
  changelog?: Partial<ChangelogOptions>;
}

export interface PostgresQuery {
  /** Complete `SELECT ... FROM ... [WHERE ...] [ORDER BY ...]`. */
  sql: string;
  /** Predicate without the `WHERE` keyword, or null when the query has no conditions. */
  where: string | null;
  /** Expression list without the `ORDER BY` keywords, or null. */
  orderBy: string | null;
  /** Bind parameters, in `$n` order (first element is `$paramOffset + 1`). */
  params: unknown[];
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const QUALIFIED = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

function ident(kind: string, v: string, re: RegExp = IDENT): string {
  if (!re.test(v)) throw new Error(`Invalid ${kind} '${v}'`);
  return v;
}

const PG_TYPE: Record<FieldType, string> = {
  STRING: 'text',
  NUMBER: 'numeric',
  BOOLEAN: 'boolean',
  DATE: 'timestamptz',
};

const escapeLike = (s: string): string => s.replace(/[\\%_]/g, '\\$&');

class Builder {
  readonly params: unknown[] = [];
  private readonly table: string;
  private readonly idColumn: string;
  private readonly customCol: string;
  private readonly cl: ChangelogOptions;

  constructor(private readonly opts: PostgresOptions) {
    this.table = ident('table', opts.table ?? 'issues', QUALIFIED);
    this.idColumn = ident('id column', opts.idColumn ?? 'id');
    this.customCol = ident('custom fields column', opts.customFieldsColumn ?? 'custom_fields');
    const c = opts.changelog ?? {};
    this.cl = {
      table: ident('changelog table', c.table ?? 'issue_changelogs', QUALIFIED),
      issueIdColumn: ident('changelog issue id column', c.issueIdColumn ?? 'issue_id'),
      fieldColumn: ident('changelog field column', c.fieldColumn ?? 'field'),
      fromColumn: ident('changelog from column', c.fromColumn ?? 'from_value'),
      toColumn: ident('changelog to column', c.toColumn ?? 'to_value'),
    };
  }

  get tableName(): string {
    return this.table;
  }

  private bind(v: unknown, cast?: string): string {
    this.params.push(v);
    const n = (this.opts.paramOffset ?? 0) + this.params.length;
    return cast ? `$${n}::${cast}` : `$${n}`;
  }

  private scalar(v: ResolvedValue): string {
    return this.bind(v.value, v.kind === 'date' ? 'timestamptz' : undefined);
  }

  /** `raw` is text for custom fields; `typed` applies the schema type cast. */
  private expr(f: ResolvedField): { raw: string; typed: string } {
    if (f.storage === 'column') {
      const e = `${this.table}.${f.column}`;
      return { raw: e, typed: e };
    }
    const raw = `(${this.table}.${this.customCol} ->> ${this.bind(f.column, 'text')})`;
    return { raw, typed: f.type === 'STRING' ? raw : `${raw}::${PG_TYPE[f.type]}` };
  }

  private emptyExpr(f: ResolvedField): string {
    const { raw, typed } = this.expr(f);
    if (f.storage === 'custom' || f.type === 'STRING') return `(${raw} IS NULL OR ${raw} = '')`;
    return `${typed} IS NULL`;
  }

  node(n: ResolvedNode): string {
    switch (n.type) {
      case 'Logical':
        return `(${this.node(n.left)} ${n.operator} ${this.node(n.right)})`;
      case 'Not':
        // NULL-safe: a row whose predicate is unknown is treated as "not matching",
        // so NOT(...) matches it -- consistent with `!=` below.
        return `NOT COALESCE(${this.node(n.operand)}, FALSE)`;
      case 'Comparison': {
        const { typed } = this.expr(n.field);
        switch (n.operator) {
          case '=':
            return `${typed} = ${this.scalar(n.value)}`;
          case '!=':
            return `${typed} IS DISTINCT FROM ${this.scalar(n.value)}`;
          case '~':
            return `${typed} ILIKE ${this.bind(`%${escapeLike(String(n.value.value))}%`)}`;
          case '!~':
            return `NOT COALESCE(${typed} ILIKE ${this.bind(`%${escapeLike(String(n.value.value))}%`)}, FALSE)`;
          default:
            return `${typed} ${n.operator} ${this.scalar(n.value)}`;
        }
      }
      case 'List': {
        const { typed } = this.expr(n.field);
        const arr = this.bind(
          n.values.map((v) => v.value),
          `${PG_TYPE[n.field.type]}[]`,
        );
        return n.operator === 'IN'
          ? `${typed} = ANY(${arr})`
          : `NOT COALESCE(${typed} = ANY(${arr}), FALSE)`;
      }
      case 'NullCheck': {
        const e = this.emptyExpr(n.field);
        return n.operator === 'IS EMPTY' ? e : `NOT (${e})`;
      }
      case 'History':
        return this.history(n);
    }
  }

  private history(n: Extract<ResolvedNode, { type: 'History' }>): string {
    const c = this.cl;
    const conds: string[] = [
      `cl.${c.issueIdColumn} = ${this.table}.${this.idColumn}`,
      `cl.${c.fieldColumn} = ${this.bind(n.field.name)}`,
    ];
    const text = (v: ResolvedValue) => this.bind(String(v.value));
    if (n.operator === 'WAS' && n.value) {
      const a = text(n.value);
      conds.push(`(cl.${c.fromColumn} = ${a} OR cl.${c.toColumn} = ${a})`);
    } else {
      if (n.fromValue) conds.push(`cl.${c.fromColumn} = ${text(n.fromValue)}`);
      if (n.toValue) conds.push(`cl.${c.toColumn} = ${text(n.toValue)}`);
    }
    return `EXISTS (SELECT 1 FROM ${c.table} cl WHERE ${conds.join(' AND ')})`;
  }

  orderBy(q: ResolvedQuery): string | null {
    const items = q.orderBy.map((o) => `${this.expr(o.field).typed} ${o.direction}`);
    if (this.opts.tieBreaker) {
      items.push(`${this.table}.${ident('tie breaker', this.opts.tieBreaker)} ASC`);
    }
    return items.length > 0 ? items.join(', ') : null;
  }
}

/**
 * Transpiles a resolved query into parameterised PostgreSQL.
 *
 * Every user-supplied value (and custom-field key) is a bind parameter. The only text
 * interpolated into SQL is identifiers from the trusted schema/options, which are
 * validated against a strict identifier pattern.
 *
 * Semantics: `=` and `<`/`>` never match NULL; `!=` matches NULL (IS DISTINCT FROM);
 * `WAS v` matches issues that ever transitioned from or to `v` (assumes creation is
 * recorded as a changelog row from NULL).
 */
export function toPostgres(query: ResolvedQuery, options: PostgresOptions = {}): PostgresQuery {
  const b = new Builder(options);
  const where = query.where ? b.node(query.where) : null;
  const orderBy = b.orderBy(query);
  const select = options.select ?? `${b.tableName}.*`;
  const sql =
    `SELECT ${select} FROM ${b.tableName}` +
    (where ? ` WHERE ${where}` : '') +
    (orderBy ? ` ORDER BY ${orderBy}` : '');
  return { sql, where, orderBy, params: b.params };
}

export const postgresAdapter: Adapter<PostgresQuery, PostgresOptions> = {
  transpile: toPostgres,
};
