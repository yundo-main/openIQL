import { describe, expect, it } from 'vitest';
import {
  analyzeRequest, print, UnknownFieldError, LimitExceededError, ValidationError,
} from '@openiql/core';
import { toPostgres } from '@openiql/adapter-postgres';
import { schema, ctx, strip } from './helpers.js';

const opts = { context: ctx };

describe('?q= text query', () => {
  it('parses and resolves like analyze()', () => {
    const r = analyzeRequest({ q: 'status = Open AND points > 1' }, schema, opts);
    expect(r.source).toBe('q');
    expect(strip(r.ast.where)).toEqual({
      type: 'Logical',
      operator: 'AND',
      left: { type: 'Comparison', field: 'status', operator: '=', value: { kind: 'string', value: 'Open' } },
      right: { type: 'Comparison', field: 'points', operator: '>', value: { kind: 'number', value: 1 } },
    });
    expect(toPostgres(r.resolved).params).toEqual(['Open', 1]);
  });
  it('rejects non-string q', () => {
    expect(() => analyzeRequest({ q: 42 }, schema, opts)).toThrow(ValidationError);
  });
  it('q errors carry source locations', () => {
    try {
      analyzeRequest({ q: 'status = a AND bogus = 1' }, schema, opts);
    } catch (e) {
      expect((e as UnknownFieldError).location).toMatchObject({ line: 1, column: 16 });
      return;
    }
    throw new Error('expected failure');
  });
});

describe('?filter= JSON AST', () => {
  const filter = {
    where: {
      type: 'Logical', operator: 'AND',
      left: { type: 'Comparison', field: 'status', operator: '=', value: { kind: 'string', value: 'Open' } },
      right: { type: 'Comparison', field: 'assignee', operator: '=', value: { kind: 'function', name: 'currentUser', args: [] } },
    },
    orderBy: [{ field: 'created', direction: 'DESC' }],
  };

  it('accepts an already-parsed object', () => {
    const r = analyzeRequest({ filter }, schema, opts);
    expect(r.source).toBe('filter');
    expect(toPostgres(r.resolved).sql).toContain('ORDER BY issues.created_at DESC');
    expect(toPostgres(r.resolved).params).toEqual(['Open', 'usr_9921']);
  });
  it('accepts a JSON string and produces the same result', () => {
    const a = analyzeRequest({ filter }, schema, opts).resolved;
    const b = analyzeRequest({ filter: JSON.stringify(filter) }, schema, opts).resolved;
    expect(b).toEqual(a);
  });
  it('rejects invalid JSON', () => {
    expect(() => analyzeRequest({ filter: '{bad' }, schema, opts)).toThrow(/not valid JSON/);
    expect(() => analyzeRequest({ filter: 123 }, schema, opts)).toThrow(ValidationError);
  });
  it('validates untrusted ASTs against the schema', () => {
    const evil = { where: { type: 'Comparison', field: 'password', operator: '=', value: { kind: 'string', value: 'x' } }, orderBy: [] };
    expect(() => analyzeRequest({ filter: evil }, schema, opts)).toThrow(UnknownFieldError);
    const deep = { where: { type: 'Not', operand: { type: 'Wat' } }, orderBy: [] };
    expect(() => analyzeRequest({ filter: deep }, schema, opts)).toThrow(ValidationError);
  });
  it('enforces AST depth limits on untrusted JSON', () => {
    let node: Record<string, unknown> = { type: 'Comparison', field: 'status', operator: '=', value: { kind: 'string', value: 'x' } };
    for (let i = 0; i < 1001; i++) node = { type: 'Not', operand: node };
    expect(() => analyzeRequest({ filter: { where: node, orderBy: [] } }, schema, opts)).toThrow(
      LimitExceededError,
    );
  });
  it('a filter round-trips through print', () => {
    const r = analyzeRequest({ filter }, schema, opts);
    const r2 = analyzeRequest({ q: print(r.ast) }, schema, opts);
    expect(strip(r2.ast)).toEqual(strip(r.ast));
  });
});

describe('parameter rules', () => {
  it('rejects q+filter together', () => {
    expect(() => analyzeRequest({ q: 'a = 1', filter: {} }, schema, opts)).toThrow(/not both/);
  });
  it('no params -> unconditional match-all query', () => {
    const r = analyzeRequest({}, schema, opts);
    expect(r.source).toBeNull();
    expect(r.resolved.where).toBeNull();
    expect(toPostgres(r.resolved).sql).toBe('SELECT issues.* FROM issues');
  });
});
