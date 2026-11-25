import type {
  Adapter,
  FieldType,
  ResolvedField,
  ResolvedNode,
  ResolvedQuery,
  ResolvedValue,
} from '@openiql/core';

export type SqlDialect = 'sqlite' | 'mysql' | 'ansi';

export interface ChangelogOptions {
  table: string;
  issueIdColumn: string;
  fieldColumn: string;
  fromColumn: string;
  toColumn: string;
}

export interface SqlOptions {
  /** SQL dialect; controls custom-field (JSON) extraction. Default `sqlite`. */
  dialect?: SqlDialect;
  /** Table (optionally schema-qualified) that holds issues. Default `issues`. */
  table?: string;
  /** Primary key column of the issues table, used to join the changelog. Default `id`. */
  idColumn?: string;
  /** JSON column holding custom fields. Default `custom_fields`. */
  customFieldsColumn?: string;
  /** Trusted SELECT list. Default `<table>.*`. Never pass user input here. */
  select?: string;
  /** Column appended to ORDER BY for deterministic pagination, e.g. `id`. */
  tieBreaker?: string;
  changelog?: Partial<ChangelogOptions>;
}

export interface SqlQuery {
  /** Complete `SELECT ... FROM ... [WHERE ...] [ORDER BY ...]` with `?` placeholders. */
  sql: string;
  /** Predicate without the `WHERE` keyword, or null when the query has no conditions. */
  where: string | null;
  /** Expression list without the `ORDER BY` keywords, or null. */
  orderBy: string | null;
  /** Bind parameters, in `?` order. */
  params: unknown[];
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const QUALIFIED = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

function ident(kind: string, v: string, re: RegExp = IDENT): string {
  if (!re.test(v)) throw new Error(`Invalid ${kind} '${v}'`);
  return v;
}

/** MySQL CAST targets for typed custom-field comparisons. */
const MYSQL_CAST: Partial<Record<FieldType, string>> = {
  NUMBER: 'DECIMAL(65,30)',
  DATE: 'DATETIME',
};

const escapeLike = (s: string): string => s.replace(/[\\%_]/g, '\\$&');

class Builder {
  readonly params: unknown[] = [];
  private readonly dialect: SqlDialect;
  private readonly table: string;
  private readonly idColumn: string;
  private readonly customCol: string;
  private readonly cl: ChangelogOptions;

  constructor(private readonly opts: SqlOptions) {
    this.dialect = opts.dialect ?? 'sqlite';
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

  private bind(v: unknown): string {
    this.params.push(v);
    return '?';
  }

  /** `raw` is the uncast expression; `typed` applies the schema type cast. */
  private expr(f: ResolvedField): { raw: string; typed: string } {
    if (f.storage === 'column') {
      const e = `${this.table}.${f.column}`;
      return { raw: e, typed: e };
    }
    switch (this.dialect) {
      case 'sqlite': {
        // json_extract preserves native types, so no cast is needed.
        const e = `json_extract(${this.table}.${this.customCol}, ${this.bind(`$.${f.column}`)})`;
        return { raw: e, typed: e };
      }
      case 'mysql': {
        const raw = `JSON_UNQUOTE(JSON_EXTRACT(${this.table}.${this.customCol}, ${this.bind(`$.${f.column}`)}))`;
        const cast = MYSQL_CAST[f.type];
        return { raw, typed: cast ? `CAST(${raw} AS ${cast})` : raw };
      }
      case 'ansi':
        throw new Error(
          `Custom field '${f.name}' requires JSON functions; the 'ansi' dialect does not support custom fields`,
        );
    }
  }

  private scalar(v: ResolvedValue): string {
    return this.bind(v.value);
  }

  private emptyExpr(f: ResolvedField): string {
    const { raw, typed } = this.expr(f);
    if (f.storage === 'custom' || f.type === 'STRING') return `(${raw} IS NULL OR ${raw} = '')`;
    return `${typed} IS NULL`;
  }

  private like(typed: string, v: ResolvedValue): string {
    return `LOWER(${typed}) LIKE LOWER(${this.bind(`%${escapeLike(String(v.value))}%`)}) ESCAPE '\\'`;
  }

  node(n: ResolvedNode): string {
    switch (n.type) {
      case 'Logical':
        return `(${this.node(n.left)} ${n.operator} ${this.node(n.right)})`;
      case 'Not':
        // NULL-safe: rows whose predicate is unknown match NOT(...).
        return `NOT COALESCE(${this.node(n.operand)}, FALSE)`;
      case 'Comparison': {
        const { typed } = this.expr(n.field);
        switch (n.operator) {
          case '=':
            return `${typed} = ${this.scalar(n.value)}`;
          case '!=':
            // Portable IS DISTINCT FROM (SQLite<3.39, MySQL lack the operator).
            return `(${typed} <> ${this.scalar(n.value)} OR ${typed} IS NULL)`;
          case '~':
            return this.like(typed, n.value);
          case '!~':
            return `NOT COALESCE(${this.like(typed, n.value)}, FALSE)`;
          default:
            return `${typed} ${n.operator} ${this.scalar(n.value)}`;
        }
      }
      case 'List': {
        const { typed } = this.expr(n.field);
        const ph = n.values.map((v) => this.scalar(v)).join(', ');
        return n.operator === 'IN'
          ? `${typed} IN (${ph})`
          : `NOT COALESCE(${typed} IN (${ph}), FALSE)`;
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
      // `?` is positional: each occurrence needs its own bound parameter.
      conds.push(`(cl.${c.fromColumn} = ${text(n.value)} OR cl.${c.toColumn} = ${text(n.value)})`);
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
 * Transpiles a resolved query into parameterised SQL with `?` placeholders,
 * portable across SQLite, MySQL and ANSI-ish engines.
 *
 * Every user-supplied value (and custom-field JSON path) is a bind parameter.
 * The only interpolated text is identifiers from the trusted schema/options,
 * validated against a strict identifier pattern.
 *
 * Semantics: `!=`/`NOT IN`/`NOT`/`!~` match NULL rows (portable `IS DISTINCT
 * FROM` emulation); `~` is `LOWER() LIKE` so it is case-insensitive regardless
 * of collation; the `ansi` dialect rejects custom (JSON) fields.
 */
export function toSql(query: ResolvedQuery, options: SqlOptions = {}): SqlQuery {
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

export const sqlAdapter: Adapter<SqlQuery, SqlOptions> = {
  transpile: toSql,
};
