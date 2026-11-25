import { describe, expect, it } from 'vitest';
import {
  analyze, parse, createSchema, UnknownFieldError, LimitExceededError, OpenIQLError,
} from '@openiql/core';
import { toPostgres } from '@openiql/adapter-postgres';
import { pg, schema, ctx } from './helpers.js';

const PAYLOADS = [
  "' OR 1=1 --",
  "'; DROP TABLE issues; --",
  '" OR ""="',
  "x'); DELETE FROM issues; --",
  '\\',
  '%',
  'Robert\'); DROP TABLE students;--',
  '\u0000',
  '＇ OR 1=1',
];
const lit = (s: string) => `"${s.replace(/[\\"]/g, '\\$&')}"`;

describe('SQL injection', () => {
  it.each(PAYLOADS)('payload %j is only ever a bind parameter', (p) => {
    for (const q of [`status = ${lit(p)}`, `status IN (${lit(p)}, "b")`, `summary ~ ${lit(p)}`, `cf.team = ${lit(p)}`, `status CHANGED FROM ${lit(p)}`]) {
      const out = pg(q);
      expect(out.sql).not.toContain(p.trim() === '' ? '\u0001' : p);
      expect(out.sql).not.toMatch(/DROP|DELETE|--/);
      expect(JSON.stringify(out.params)).toContain(JSON.stringify(p).slice(1, -1));
    }
  });

  it('LIKE wildcards in user input are escaped', () => {
    const out = pg('summary ~ "100%_done\\\\"');
    expect(out.params).toEqual(['%100\\%\\_done\\\\%']);
  });

  it('generates the expected shape for the spec example', () => {
    const out = pg('project = PROJ AND (priority = High OR assignee = currentUser()) ORDER BY created DESC');
    expect(out.sql).toBe(
      'SELECT issues.* FROM issues WHERE (issues.project_key = $1 AND (issues.priority = $2 OR issues.assignee_id = $3)) ORDER BY issues.created_at DESC',
    );
    expect(out.params).toEqual(['PROJ', 'High', 'usr_9921']);
  });

  it('custom-field keys are bound, not interpolated', () => {
    const out = pg('cf.story_points > 3');
    expect(out.where).toBe('(issues.custom_fields ->> $1::text)::numeric > $2');
    expect(out.params).toEqual(['story_points', 3]);
  });

  it('rejects unsafe identifiers in adapter options and schema config', () => {
    const { resolved } = analyze('status = a', schema, { context: ctx });
    expect(() => toPostgres(resolved, { table: 'issues; DROP TABLE x' })).toThrow(/Invalid table/);
    expect(() => toPostgres(resolved, { tieBreaker: 'id desc, (select 1)' })).toThrow();
    expect(() => createSchema({ fields: { status: { type: 'STRING', column: 'a; b' } } })).toThrow();
    expect(() => createSchema({ fields: {}, customFields: { "x'y": { type: 'STRING' } } })).toThrow();
  });
});

describe('field whitelist', () => {
  it.each(['password', 'issues.status', 'pg_sleep', 'cf.unknown', 'cf', 'status.x'])('%s -> UnknownFieldError', (f) => {
    expect(() => analyze(`${f} = 1`, schema, { context: ctx })).toThrow(UnknownFieldError);
    expect(() => analyze(`${f} IS EMPTY`, schema, { context: ctx })).toThrow(UnknownFieldError);
    expect(() => analyze(`ORDER BY ${f}`, schema, { context: ctx })).toThrow(UnknownFieldError);
  });
  it('reports the location of the unknown field', () => {
    try {
      analyze('status = a AND secret = 1', schema, { context: ctx });
    } catch (e) {
      expect((e as OpenIQLError).toJSON()).toMatchObject({ error: 'UnknownFieldError', location: { column: 16 } });
      return;
    }
    throw new Error('expected failure');
  });
});

describe('DoS limits', () => {
  it('query length is measured in UTF-8 bytes', () => {
    const ok = `summary ~ "${'a'.repeat(2048 - 12)}"`;
    expect(Buffer.byteLength(ok)).toBe(2048);
    expect(() => parse(ok)).not.toThrow();
    expect(() => parse(ok + ' ')).toThrow(LimitExceededError);
    // 700 Hangul chars = 2100 bytes but only 700 characters.
    expect(() => parse(`summary ~ "${'한'.repeat(700)}"`)).toThrow(LimitExceededError);
  });
  it('paren depth: 10 ok, 11 rejected', () => {
    const nest = (n: number) => `${'('.repeat(n)}a = 1${')'.repeat(n)}`;
    expect(() => parse(nest(10))).not.toThrow();
    expect(() => parse(nest(11))).toThrow(LimitExceededError);
  });
  it('IN list: 100 ok, 101 rejected', () => {
    const list = (n: number) => `status IN (${Array.from({ length: n }, (_, i) => i).join(',')})`;
    expect(() => parse(list(100))).not.toThrow();
    expect(() => parse(list(101))).toThrow(LimitExceededError);
  });
  it('pathological inputs finish quickly', () => {
    const t = Date.now();
    for (const q of ['NOT '.repeat(500) + 'a = 1', 'a = 1 OR '.repeat(200) + 'a = 1', '('.repeat(2000), '"' + '\\'.repeat(2000)]) {
      try { parse(q); } catch { /* expected */ }
    }
    expect(Date.now() - t).toBeLessThan(500);
  });
});
