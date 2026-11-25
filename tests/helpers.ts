import { createSchema, analyze, type ResolveOptions } from '@openiql/core';
import { toPostgres, type PostgresOptions } from '@openiql/adapter-postgres';
import { toOpenSearch, type OpenSearchOptions } from '@openiql/adapter-opensearch';

export const schema = createSchema({
  fields: {
    project: { type: 'STRING', column: 'project_key' },
    status: { type: 'STRING' },
    priority: { type: 'STRING' },
    assignee: { type: 'STRING', column: 'assignee_id' },
    summary: { type: 'STRING' },
    created: { type: 'DATE', column: 'created_at' },
    points: { type: 'NUMBER' },
    resolved: { type: 'BOOLEAN' },
  },
  customFields: { story_points: { type: 'NUMBER' }, team: { type: 'STRING' } },
});

export const ctx = { userId: 'usr_9921', now: new Date('2026-11-25T10:30:00Z') };

export function pg(q: string, opts: PostgresOptions = {}, ro: ResolveOptions = {}) {
  const { resolved } = analyze(q, schema, { context: ctx, ...ro });
  return toPostgres(resolved, opts);
}

export function os(q: string, opts: OpenSearchOptions = {}, ro: ResolveOptions = {}) {
  const { resolved } = analyze(q, schema, { context: ctx, ...ro });
  return toOpenSearch(resolved, opts);
}

/** Strips span info so ASTs can be compared structurally. */
export function strip<T>(v: T): T {
  return JSON.parse(JSON.stringify(v, (k, x) => (k === 'span' ? undefined : x)));
}
