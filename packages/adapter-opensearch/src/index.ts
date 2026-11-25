import type {
  Adapter,
  ResolvedField,
  ResolvedNode,
  ResolvedQuery,
  ResolvedValue,
} from '@openiql/core';

export interface ChangelogOptions {
  /** Path of the `nested` field holding change entries. Default `changelogs`. */
  path: string;
  /** Sub-field holding the changed field's name. Default `field`. */
  fieldField: string;
  /** Sub-field holding the value before the change. Default `from_value`. */
  fromField: string;
  /** Sub-field holding the value after the change. Default `to_value`. */
  toField: string;
}

export interface OpenSearchOptions {
  /** Object field that holds custom fields. Default `custom_fields`. */
  customFieldsPath?: string;
  /**
   * Sub-field suffix used for exact string matching and sorting.
   * Default `.keyword`; pass `''` when the index maps strings as keyword-only.
   */
  keywordSuffix?: string;
  /** `track_total_hits` copied into the request body. */
  trackTotalHits?: boolean | number;
  /** Field appended to `sort` for deterministic pagination, e.g. `id`. */
  tieBreaker?: string;
  changelog?: Partial<ChangelogOptions>;
}

type Clause = Record<string, unknown>;

export interface OpenSearchQuery {
  /** Request body for `POST /<index>/_search`: `{ query, sort?, track_total_hits? }`. */
  body: Record<string, unknown>;
  /** The `query` clause inside `body` (`{ match_all: {} }` when the query has no conditions). */
  query: Clause;
  /** The `sort` array inside `body`, or null. */
  sort: Array<Record<string, Clause>> | null;
}

const SEGMENTS = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KEYWORD_SUFFIX = /^\.[A-Za-z_][A-Za-z0-9_]*$/;

function ident(kind: string, v: string, re: RegExp): string {
  if (!re.test(v)) throw new Error(`Invalid ${kind} '${v}'`);
  return v;
}

const term = (path: string, value: unknown): Clause => ({ term: { [path]: value } });
const terms = (path: string, values: unknown[]): Clause => ({ terms: { [path]: values } });
const exists = (path: string): Clause => ({ exists: { field: path } });
const mustNot = (...clauses: Clause[]): Clause => ({ bool: { must_not: clauses } });
const must = (...clauses: Clause[]): Clause => ({ bool: { must: clauses } });
const should = (...clauses: Clause[]): Clause => ({
  bool: { should: clauses, minimum_should_match: 1 },
});

/** Escapes wildcard metacharacters so `~` is a literal substring search. */
const escapeWildcard = (s: string): string => s.replace(/[\\*?]/g, '\\$&');

class Builder {
  private readonly customPath: string;
  private readonly suffix: string;
  private readonly cl: ChangelogOptions;

  constructor(private readonly opts: OpenSearchOptions) {
    this.customPath = ident('custom fields path', opts.customFieldsPath ?? 'custom_fields', SEGMENTS);
    const kw = opts.keywordSuffix ?? '.keyword';
    this.suffix = kw === '' ? '' : ident('keyword suffix', kw, KEYWORD_SUFFIX);
    const c = opts.changelog ?? {};
    this.cl = {
      path: ident('changelog path', c.path ?? 'changelogs', SEGMENTS),
      fieldField: ident('changelog field field', c.fieldField ?? 'field', SEGMENT),
      fromField: ident('changelog from field', c.fromField ?? 'from_value', SEGMENT),
      toField: ident('changelog to field', c.toField ?? 'to_value', SEGMENT),
    };
  }

  /** Index field path for a resolved field. */
  private path(f: ResolvedField): string {
    return f.storage === 'custom' ? `${this.customPath}.${f.column}` : f.column;
  }

  /** Path for exact string matching (term/terms/wildcard) and sorting. */
  private exact(f: ResolvedField): string {
    return f.type === 'STRING' ? `${this.path(f)}${this.suffix}` : this.path(f);
  }

  private scalar(v: ResolvedValue): unknown {
    return v.value;
  }

  node(n: ResolvedNode): Clause {
    switch (n.type) {
      case 'Logical':
        return n.operator === 'AND'
          ? must(this.node(n.left), this.node(n.right))
          : should(this.node(n.left), this.node(n.right));
      case 'Not':
        // Missing-field documents match, mirroring `NOT COALESCE(...)`.
        return mustNot(this.node(n.operand));
      case 'Comparison': {
        switch (n.operator) {
          case '=':
            return term(this.exact(n.field), this.scalar(n.value));
          case '!=':
            return mustNot(term(this.exact(n.field), this.scalar(n.value)));
          case '~':
            return this.like(n);
          case '!~':
            return mustNot(this.like(n));
          default:
            return { range: { [this.path(n.field)]: { [RANGE[n.operator]]: this.scalar(n.value) } } };
        }
      }
      case 'List': {
        const t = terms(this.exact(n.field), n.values.map((v) => this.scalar(v)));
        return n.operator === 'IN' ? t : mustNot(t);
      }
      case 'NullCheck': {
        if (n.operator === 'IS EMPTY') return this.emptyExpr(n.field);
        if (n.field.type !== 'STRING') return exists(this.path(n.field));
        return must(exists(this.path(n.field)), mustNot(term(this.exact(n.field), '')));
      }
      case 'History':
        return this.history(n);
    }
  }

  private like(n: Extract<ResolvedNode, { type: 'Comparison' }>): Clause {
    return {
      wildcard: {
        [this.exact(n.field)]: {
          value: `*${escapeWildcard(String(n.value.value))}*`,
          case_insensitive: true,
        },
      },
    };
  }

  private emptyExpr(f: ResolvedField): Clause {
    if (f.type !== 'STRING') return mustNot(exists(this.path(f)));
    return should(mustNot(exists(this.path(f))), term(this.exact(f), ''));
  }

  private history(n: Extract<ResolvedNode, { type: 'History' }>): Clause {
    const c = this.cl;
    const sub = (name: string) => `${c.path}.${name}${this.suffix}`;
    const text = (v: ResolvedValue) => String(v.value);
    const conds: Clause[] = [term(sub(c.fieldField), n.field.name)];
    if (n.operator === 'WAS' && n.value) {
      conds.push(should(term(sub(c.fromField), text(n.value)), term(sub(c.toField), text(n.value))));
    } else {
      if (n.fromValue) conds.push(term(sub(c.fromField), text(n.fromValue)));
      if (n.toValue) conds.push(term(sub(c.toField), text(n.toValue)));
    }
    return { nested: { path: c.path, query: { bool: { must: conds } } } };
  }

  sort(q: ResolvedQuery): Array<Record<string, Clause>> | null {
    const items: Array<Record<string, Clause>> = q.orderBy.map((o) => ({
      [this.exact(o.field)]: { order: o.direction.toLowerCase() },
    }));
    if (this.opts.tieBreaker) {
      items.push({ [ident('tie breaker', this.opts.tieBreaker, SEGMENTS)]: { order: 'asc' } });
    }
    return items.length > 0 ? items : null;
  }
}

const RANGE: Record<'>' | '>=' | '<' | '<=', string> = {
  '>': 'gt',
  '>=': 'gte',
  '<': 'lt',
  '<=': 'lte',
};

/**
 * Transpiles a resolved query into an OpenSearch `_search` request body.
 *
 * Field paths come only from the trusted schema/options (validated against a
 * strict path pattern); user-supplied values are always query parameters.
 *
 * Semantics: STRING equality uses the `.keyword` sub-field; `!=`/`!~`/`NOT IN`/`NOT`
 * match documents where the field is missing (mirroring the Postgres adapter's
 * NULL-inclusive semantics); history operators require a `nested` changelog field.
 */
export function toOpenSearch(query: ResolvedQuery, options: OpenSearchOptions = {}): OpenSearchQuery {
  const b = new Builder(options);
  const queryClause = query.where ? b.node(query.where) : { match_all: {} };
  const sort = b.sort(query);
  const body: Record<string, unknown> = { query: queryClause };
  if (sort) body.sort = sort;
  if (options.trackTotalHits !== undefined) body.track_total_hits = options.trackTotalHits;
  return { body, query: queryClause, sort };
}

export const openSearchAdapter: Adapter<OpenSearchQuery, OpenSearchOptions> = {
  transpile: toOpenSearch,
};
