import { describe, expect, it } from 'vitest';
import { analyze, resolve, UnknownFieldError, ValidationError, type QueryAST } from '@openiql/core';
import { ctx, schema } from './helpers.js';

const r = (q: string) => analyze(q, schema, { context: ctx }).resolved;

describe('functions', () => {
  it('binds currentUser()', () => {
    expect(r('assignee = currentUser()').where).toMatchObject({ value: { kind: 'string', value: 'usr_9921' } });
  });
  it('requires a user for currentUser()', () => {
    expect(() => analyze('assignee = currentUser()', schema)).toThrow(ValidationError);
  });
  it('computes time functions in UTC (Wednesday 2026-11-25)', () => {
    const v = (q: string) => (r(q).where as { value: { value: string } }).value.value;
    expect(v('created >= startOfDay()')).toBe('2026-11-25T00:00:00.000Z');
    expect(v('created >= startOfDay(-7d)')).toBe('2026-11-18T00:00:00.000Z');
    expect(v('created >= startOfWeek()')).toBe('2026-11-23T00:00:00.000Z');
    expect(v('created >= startOfWeek(+1w)')).toBe('2026-11-30T00:00:00.000Z');
  });
  it('rejects unknown functions and bad arity', () => {
    expect(() => r('assignee = nope()')).toThrow(/Unknown function/);
    expect(() => r('created > startOfDay(1d, 2d)')).toThrow(/argument/);
  });
});

describe('typing', () => {
  it('maps fields and custom fields', () => {
    expect(r('project = P AND cf.story_points > 3').where).toMatchObject({
      left: { field: { column: 'project_key', storage: 'column' } },
      right: { field: { name: 'cf.story_points', storage: 'custom', column: 'story_points', type: 'NUMBER' } },
    });
  });
  it('coerces date strings', () => {
    expect(r('created > "2026-01-02"').where).toMatchObject({ value: { kind: 'date', value: '2026-01-02T00:00:00.000Z' } });
  });
  it('rejects type and operator mismatches', () => {
    expect(() => r('points = "x"')).toThrow(ValidationError);
    expect(() => r('created > "yesterday"')).toThrow(/valid date/);
    expect(() => r('status > 1')).toThrow(/NUMBER and DATE/);
    expect(() => r('points ~ 1')).toThrow(/STRING/);
    expect(() => r('resolved = 1')).toThrow(ValidationError);
  });
  it('error messages carry line/column when source is known', () => {
    expect(() => r('status = a AND points = "x"')).toThrow(/column 25/);
  });
});

describe('untrusted JSON AST', () => {
  const bad = (ast: unknown) => () => resolve(ast as QueryAST, schema, { context: ctx });
  it('rejects unknown node types, operators and kinds', () => {
    expect(bad({ where: { type: 'Raw', sql: '1=1' }, orderBy: [] })).toThrow(ValidationError);
    expect(bad({ where: { type: 'Comparison', field: 'status', operator: '; DROP', value: { kind: 'string', value: 'x' } }, orderBy: [] })).toThrow(/Invalid operator/);
    expect(bad({ where: { type: 'Comparison', field: 'status', operator: '=', value: { kind: 'raw', value: 'x' } }, orderBy: [] })).toThrow(ValidationError);
    expect(bad({ where: null, orderBy: [{ field: 'status', direction: 'ASC; DROP' }] })).toThrow(/direction/);
  });
  it('rejects inherited/prototype field names', () => {
    for (const f of ['constructor', '__proto__', 'toString']) {
      expect(bad({ where: { type: 'NullCheck', field: f, operator: 'IS EMPTY' }, orderBy: [] })).toThrow(UnknownFieldError);
    }
  });
});
