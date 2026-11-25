import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { parse, print, IQLSyntaxError, type ASTNode, type QueryAST } from '@openiql/core';
import { strip } from './helpers.js';

const where = (q: string) => strip(parse(q).where) as ASTNode;

describe('precedence', () => {
  it('AND binds tighter than OR', () => {
    expect(where('a = 1 OR b = 2 AND c = 3')).toMatchObject({
      type: 'Logical',
      operator: 'OR',
      left: { type: 'Comparison', field: 'a' },
      right: { type: 'Logical', operator: 'AND' },
    });
  });
  it('NOT binds tighter than AND', () => {
    expect(where('NOT a = 1 AND b = 2')).toMatchObject({
      operator: 'AND',
      left: { type: 'Not', operand: { type: 'Comparison', field: 'a' } },
    });
  });
  it('parentheses override', () => {
    expect(where('(a = 1 OR b = 2) AND c = 3')).toMatchObject({
      operator: 'AND',
      left: { operator: 'OR' },
    });
  });
  it('chains are left associative', () => {
    expect(where('a=1 AND b=2 AND c=3')).toMatchObject({
      operator: 'AND',
      left: { operator: 'AND' },
      right: { field: 'c' },
    });
  });
  it('keywords are case-insensitive', () => {
    expect(parse('a = 1 and b in (1,2) order by a desc')).toBeTruthy();
  });
});

describe('conditions', () => {
  it('parses all condition forms', () => {
    expect(where('status NOT IN ("a", b, 3)')).toMatchObject({ type: 'List', operator: 'NOT IN' });
    expect(where('assignee IS NOT EMPTY')).toMatchObject({ type: 'NullCheck', operator: 'IS NOT EMPTY' });
    expect(where('status WAS "Open"')).toMatchObject({ type: 'History', operator: 'WAS', value: { value: 'Open' } });
    expect(where('status CHANGED FROM a TO b')).toMatchObject({
      operator: 'CHANGED',
      fromValue: { value: 'a' },
      toValue: { value: 'b' },
    });
    expect(where('status CHANGED TO b')).toMatchObject({ toValue: { value: 'b' } });
    expect(where('status CHANGED')).toMatchObject({ operator: 'CHANGED' });
  });
  it('parses dotted fields, functions, durations, booleans, numbers', () => {
    expect(where('cf.story_points >= -1.5')).toMatchObject({ field: 'cf.story_points', value: { kind: 'number', value: -1.5 } });
    expect(where('created > startOfWeek(-7d)')).toMatchObject({
      value: { kind: 'function', name: 'startOfWeek', args: [{ kind: 'duration', value: '-7d' }] },
    });
    expect(where('resolved = true')).toMatchObject({ value: { kind: 'boolean', value: true } });
    expect(where("summary ~ 'it\\'s'")).toMatchObject({ value: { value: "it's" } });
  });
  it('parses ORDER BY, including without WHERE', () => {
    expect(strip(parse('ORDER BY created DESC, key'))).toEqual({
      where: null,
      orderBy: [
        { field: 'created', direction: 'DESC' },
        { field: 'key', direction: 'ASC' },
      ],
    });
    expect(parse('')).toEqual({ where: null, orderBy: [] });
  });
});

describe('errors', () => {
  const err = (q: string) => {
    try {
      parse(q);
    } catch (e) {
      return e as IQLSyntaxError;
    }
    throw new Error('expected failure');
  };

  it('reports location and expected tokens (spec section 6-3)', () => {
    const e = err('project = PROJ AND AND x = 1');
    expect(e).toBeInstanceOf(IQLSyntaxError);
    expect(e.toJSON()).toMatchObject({
      error: 'SyntaxError',
      message: "Unexpected token 'AND' at line 1, column 20",
      location: { offset: 19, line: 1, column: 20 },
      expected: ['(', 'NOT', '<field>'],
    });
  });
  it('lists operators after a field', () => {
    const e = err('status AND');
    expect(e.expected).toContain('IS EMPTY');
    expect(e.expected).toContain('=');
    expect(e.location).toMatchObject({ column: 8 });
  });
  it('tracks lines', () => {
    expect(err('a = 1\nAND )').location).toMatchObject({ line: 2, column: 5 });
  });
  it('rejects unterminated strings, bad chars, trailing garbage', () => {
    expect(err('a = "x').message).toMatch(/Unterminated/);
    expect(err('a = 1 ; b').message).toMatch(/Unexpected character ';'/);
    expect(err('a = 1 )').expected).toEqual(['AND', 'OR', 'ORDER BY']);
    expect(err('a = ').message).toMatch(/end of input/);
    expect(err('(a = 1').expected).toContain(')');
  });
  it('rejects nested functions and top-level durations', () => {
    expect(err('a = f(g())').message).toMatch(/Nested function/);
    expect(err('a = -7d').message).toMatch(/Duration/);
  });
  it('treats reserved words as non-identifiers', () => {
    expect(err('and = 1')).toBeInstanceOf(IQLSyntaxError);
  });
});

describe('print round-trip', () => {
  it.each([
    'a = 1 AND (b = 2 OR c = 3)',
    'NOT (a = 1 OR b = 2) ORDER BY a DESC',
    'a = 1 AND (b = 2 AND c = 3)',
    'a = 1 OR (b = 2 OR c = 3)',
    'status NOT IN ("x y", z) AND cf.n IS EMPTY',
    'created > startOfDay(-7d) AND assignee = currentUser()',
    'status CHANGED FROM "a\\"b" TO c',
  ])('%s', (q) => {
    const ast = parse(q);
    expect(strip(parse(print(ast)))).toEqual(strip(ast));
  });

  const field = fc.constantFrom('a', 'b', 'status', 'cf.x');
  const lit = fc.oneof(
    fc.string({ maxLength: 8 }).map((value) => ({ kind: 'string' as const, value })),
    fc.integer({ min: -1000, max: 1000 }).map((value) => ({ kind: 'number' as const, value })),
    fc.boolean().map((value) => ({ kind: 'boolean' as const, value })),
  );
  const leaf: fc.Arbitrary<ASTNode> = fc.oneof(
    fc.record({ type: fc.constant('Comparison' as const), field, operator: fc.constantFrom('=', '!=', '<', '~' as const), value: lit }),
    fc.record({ type: fc.constant('List' as const), field, operator: fc.constantFrom('IN', 'NOT IN' as const), values: fc.array(lit, { minLength: 1, maxLength: 3 }) }),
    fc.record({ type: fc.constant('NullCheck' as const), field, operator: fc.constantFrom('IS EMPTY', 'IS NOT EMPTY' as const) }),
  ) as fc.Arbitrary<ASTNode>;
  const node = fc.letrec<{ n: ASTNode }>((tie) => ({
    n: fc.oneof(
      { depthSize: 'small', maxDepth: 4 },
      leaf,
      fc.record({ type: fc.constant('Not' as const), operand: tie('n') }),
      fc.record({ type: fc.constant('Logical' as const), operator: fc.constantFrom('AND', 'OR' as const), left: tie('n'), right: tie('n') }),
    ) as fc.Arbitrary<ASTNode>,
  })).n;

  it('parse(print(ast)) == ast for generated ASTs', () => {
    fc.assert(
      fc.property(node, (where) => {
        const ast: QueryAST = { where, orderBy: [] };
        // Parenthesis depth is limited to 10; generated depth is <= 4 levels.
        expect(strip(parse(print(ast)))).toEqual(strip(ast));
      }),
      { numRuns: 300 },
    );
  });
});
