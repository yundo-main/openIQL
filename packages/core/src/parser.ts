import type {
  ASTNode,
  ComparisonOperator,
  FunctionCallValue,
  HistoryNode,
  LiteralValue,
  OrderItem,
  QueryAST,
  Span,
} from './ast.js';
import { IQLSyntaxError, LimitExceededError, locate } from './errors.js';
import { tokenize, type Token } from './lexer.js';

export interface Limits {
  /** Maximum query length in UTF-8 bytes. */
  maxQueryBytes: number;
  /** Maximum parenthesis nesting depth. */
  maxDepth: number;
  /** Maximum number of elements in an IN list. */
  maxInListSize: number;
}

export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({
  maxQueryBytes: 2048,
  maxDepth: 10,
  maxInListSize: 100,
});

const COMPARISON_OPS = ['=', '!=', '>', '>=', '<', '<=', '~', '!~'];
const CONDITION_EXPECTED = [...COMPARISON_OPS, 'IN', 'NOT IN', 'IS EMPTY', 'IS NOT EMPTY', 'WAS', 'CHANGED'];
const EXPRESSION_START = ['(', 'NOT', '<field>'];

type Value = LiteralValue | FunctionCallValue;

export function parse(source: string, options: Partial<Limits> = {}): QueryAST {
  const limits: Limits = { ...DEFAULT_LIMITS, ...options };
  const bytes = new TextEncoder().encode(source).length;
  if (bytes > limits.maxQueryBytes) {
    throw new LimitExceededError(
      'maxQueryBytes',
      limits.maxQueryBytes,
      `Query is ${bytes} bytes; the maximum is ${limits.maxQueryBytes}`,
    );
  }
  return new Parser(source, tokenize(source), limits).parseQuery();
}

class Parser {
  private pos = 0;
  private depth = 0;

  constructor(
    private readonly source: string,
    private readonly tokens: Token[],
    private readonly limits: Limits,
  ) {}

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)] as Token;
  }

  private next(): Token {
    const t = this.peek();
    if (t.type !== 'EOF') this.pos++;
    return t;
  }

  private prevEnd(): number {
    return (this.tokens[this.pos - 1] as Token).end;
  }

  private isKw(kw: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t.type === 'KEYWORD' && t.value === kw;
  }

  private fail(tok: Token, expected: string[], message?: string): never {
    const loc = locate(this.source, tok.start);
    const what = tok.type === 'EOF' ? 'end of input' : `token '${tok.text}'`;
    throw new IQLSyntaxError(
      `${message ?? `Unexpected ${what}`} at line ${loc.line}, column ${loc.column}`,
      loc,
      expected,
      { start: tok.start, end: tok.end },
    );
  }

  private expectKw(kw: string, expectedLabels: string[] = [kw]): Token {
    if (!this.isKw(kw)) this.fail(this.peek(), expectedLabels);
    return this.next();
  }

  private spanFrom(start: number): Span {
    return { start, end: this.prevEnd() };
  }

  // ---- Query -------------------------------------------------------------

  parseQuery(): QueryAST {
    let where: ASTNode | null = null;
    if (this.peek().type !== 'EOF' && !this.isKw('ORDER')) {
      where = this.parseOr();
    }
    const orderBy: OrderItem[] = this.isKw('ORDER') ? this.parseOrderBy() : [];
    if (this.peek().type !== 'EOF') {
      const expected = orderBy.length > 0 ? [','] : where ? ['AND', 'OR', 'ORDER BY'] : ['ORDER BY'];
      this.fail(this.peek(), expected);
    }
    return { where, orderBy };
  }

  private parseOrderBy(): OrderItem[] {
    this.next(); // ORDER
    this.expectKw('BY');
    const items: OrderItem[] = [];
    for (;;) {
      const start = this.peek().start;
      const field = this.parseField();
      let direction: 'ASC' | 'DESC' = 'ASC';
      if (this.isKw('ASC') || this.isKw('DESC')) {
        direction = this.next().value as 'ASC' | 'DESC';
      }
      items.push({ field, direction, span: this.spanFrom(start) });
      if (this.peek().type === 'COMMA') {
        this.next();
        continue;
      }
      return items;
    }
  }

  // ---- Expressions -------------------------------------------------------

  private span(n: ASTNode): Span {
    return n.span as Span;
  }

  private parseOr(): ASTNode {
    let left = this.parseAnd();
    while (this.isKw('OR')) {
      this.next();
      const right = this.parseAnd();
      left = {
        type: 'Logical',
        operator: 'OR',
        left,
        right,
        span: { start: this.span(left).start, end: this.span(right).end },
      };
    }
    return left;
  }

  private parseAnd(): ASTNode {
    let left = this.parseNot();
    while (this.isKw('AND')) {
      this.next();
      const right = this.parseNot();
      left = {
        type: 'Logical',
        operator: 'AND',
        left,
        right,
        span: { start: this.span(left).start, end: this.span(right).end },
      };
    }
    return left;
  }

  private parseNot(): ASTNode {
    if (this.isKw('NOT')) {
      const start = this.next().start;
      const operand = this.parseNot();
      return { type: 'Not', operand, span: this.spanFrom(start) };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): ASTNode {
    const tok = this.peek();
    if (tok.type === 'LPAREN') {
      this.next();
      if (++this.depth > this.limits.maxDepth) {
        const loc = locate(this.source, tok.start);
        throw new LimitExceededError(
          'maxDepth',
          this.limits.maxDepth,
          `Parenthesis nesting exceeds the maximum depth of ${this.limits.maxDepth} at line ${loc.line}, column ${loc.column}`,
          loc,
          { start: tok.start, end: tok.end },
        );
      }
      const inner = this.parseOr();
      if (this.peek().type !== 'RPAREN') this.fail(this.peek(), [')', 'AND', 'OR']);
      this.next();
      this.depth--;
      // Keep the inner node but widen its span to include the parentheses.
      return { ...inner, span: this.spanFrom(tok.start) };
    }
    if (tok.type === 'IDENT') return this.parseCondition();
    return this.fail(tok, EXPRESSION_START);
  }

  private parseField(): string {
    const first = this.peek();
    if (first.type !== 'IDENT') this.fail(first, ['<field>']);
    this.next();
    let name = first.text;
    if (this.peek().type === 'DOT') {
      this.next();
      const second = this.peek();
      if (second.type !== 'IDENT') this.fail(second, ['<identifier>']);
      this.next();
      name += `.${second.text}`;
    }
    return name;
  }

  private parseCondition(): ASTNode {
    const start = this.peek().start;
    const field = this.parseField();
    const tok = this.peek();

    if (tok.type === 'OP') {
      this.next();
      const value = this.parseValue(true);
      return {
        type: 'Comparison',
        field,
        operator: tok.value as ComparisonOperator,
        value,
        span: this.spanFrom(start),
      };
    }

    if (this.isKw('IN') || (this.isKw('NOT') && this.isKw('IN', 1))) {
      const negated = this.isKw('NOT');
      if (negated) this.next();
      this.next(); // IN
      const values = this.parseValueList();
      return {
        type: 'List',
        field,
        operator: negated ? 'NOT IN' : 'IN',
        values,
        span: this.spanFrom(start),
      };
    }

    if (this.isKw('IS')) {
      this.next();
      let negated = false;
      if (this.isKw('NOT')) {
        this.next();
        negated = true;
      }
      this.expectKw('EMPTY');
      return {
        type: 'NullCheck',
        field,
        operator: negated ? 'IS NOT EMPTY' : 'IS EMPTY',
        span: this.spanFrom(start),
      };
    }

    if (this.isKw('WAS')) {
      this.next();
      const value = this.parseValue(true);
      return { type: 'History', field, operator: 'WAS', value, span: this.spanFrom(start) };
    }

    if (this.isKw('CHANGED')) {
      this.next();
      const node: HistoryNode = { type: 'History', field, operator: 'CHANGED' };
      if (this.isKw('FROM')) {
        this.next();
        node.fromValue = this.parseValue(true);
      }
      if (this.isKw('TO')) {
        this.next();
        node.toValue = this.parseValue(true);
      }
      node.span = this.spanFrom(start);
      return node;
    }

    return this.fail(tok, CONDITION_EXPECTED);
  }

  // ---- Values ------------------------------------------------------------

  private parseValueList(): Value[] {
    if (this.peek().type !== 'LPAREN') this.fail(this.peek(), ['(']);
    this.next();
    const values: Value[] = [];
    for (;;) {
      values.push(this.parseValue(true));
      if (values.length > this.limits.maxInListSize) {
        const loc = locate(this.source, this.peek().start);
        throw new LimitExceededError(
          'maxInListSize',
          this.limits.maxInListSize,
          `IN list exceeds the maximum of ${this.limits.maxInListSize} elements at line ${loc.line}, column ${loc.column}`,
          loc,
        );
      }
      const t = this.peek();
      if (t.type === 'COMMA') {
        this.next();
        continue;
      }
      if (t.type === 'RPAREN') {
        this.next();
        return values;
      }
      this.fail(t, [',', ')']);
    }
  }

  /** `allowFunction` is false for function arguments (no nested calls; durations allowed). */
  private parseValue(allowFunction: boolean): Value {
    const tok = this.peek();
    const span: Span = { start: tok.start, end: tok.end };
    switch (tok.type) {
      case 'STRING':
        this.next();
        return { kind: 'string', value: tok.value as string, span };
      case 'NUMBER':
        this.next();
        return { kind: 'number', value: tok.value as number, span };
      case 'BOOLEAN':
        this.next();
        return { kind: 'boolean', value: tok.value as boolean, span };
      case 'DURATION':
        if (allowFunction) {
          this.fail(tok, ['<value>'], 'Duration literals are only allowed as function arguments');
        }
        this.next();
        return { kind: 'duration', value: tok.text, span };
      case 'IDENT':
        if (this.peek(1).type === 'LPAREN') {
          if (!allowFunction) this.fail(tok, ['<value>'], 'Nested function calls are not supported');
          return this.parseFunctionCall();
        }
        this.next();
        return { kind: 'string', value: tok.text, span };
      default:
        return this.fail(tok, ['<value>']);
    }
  }

  private parseFunctionCall(): FunctionCallValue {
    const nameTok = this.next();
    this.next(); // (
    const args: LiteralValue[] = [];
    if (this.peek().type !== 'RPAREN') {
      for (;;) {
        args.push(this.parseValue(false) as LiteralValue);
        if (this.peek().type === 'COMMA') {
          this.next();
          continue;
        }
        break;
      }
    }
    if (this.peek().type !== 'RPAREN') this.fail(this.peek(), [',', ')']);
    this.next();
    return { kind: 'function', name: nameTok.text, args, span: this.spanFrom(nameTok.start) };
  }
}
