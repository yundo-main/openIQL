import { IQLSyntaxError, locate } from './errors.js';

export type TokenType =
  | 'IDENT'
  | 'STRING'
  | 'NUMBER'
  | 'DURATION'
  | 'BOOLEAN'
  | 'KEYWORD'
  | 'OP'
  | 'LPAREN'
  | 'RPAREN'
  | 'COMMA'
  | 'DOT'
  | 'EOF';

export interface Token {
  type: TokenType;
  /** Processed value: unescaped string, number, boolean, uppercased keyword, or operator text. */
  value: string | number | boolean;
  /** Raw source text. */
  text: string;
  start: number;
  end: number;
}

export const KEYWORDS: ReadonlySet<string> = new Set([
  'AND', 'OR', 'NOT', 'IN', 'IS', 'EMPTY', 'WAS', 'CHANGED',
  'FROM', 'TO', 'ORDER', 'BY', 'ASC', 'DESC',
]);

const DURATION_UNITS = 'smhdw';

const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';
const isIdentStart = (c: string | undefined): boolean =>
  c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_');
const isIdentChar = (c: string | undefined): boolean => isIdentStart(c) || isDigit(c);
const isSpace = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r';

export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  const n = src.length;
  let i = 0;

  const lexError = (offset: number, message: string): never => {
    throw new IQLSyntaxError(
      `${message} at line ${locate(src, offset).line}, column ${locate(src, offset).column}`,
      locate(src, offset),
      [],
      { start: offset, end: offset + 1 },
    );
  };
  const push = (type: TokenType, value: Token['value'], start: number, end: number) =>
    tokens.push({ type, value, text: src.slice(start, end), start, end });

  while (i < n) {
    const c = src[i] as string;
    if (isSpace(c)) {
      i++;
      continue;
    }
    const start = i;

    if (c === '(') { push('LPAREN', '(', i, i + 1); i++; continue; }
    if (c === ')') { push('RPAREN', ')', i, i + 1); i++; continue; }
    if (c === ',') { push('COMMA', ',', i, i + 1); i++; continue; }
    if (c === '.') { push('DOT', '.', i, i + 1); i++; continue; }

    if (c === '"' || c === "'") {
      let j = i + 1;
      let out = '';
      let closed = false;
      while (j < n) {
        const d = src[j] as string;
        if (d === '\\') {
          const e = src[j + 1];
          if (e === '\\' || e === '"' || e === "'") {
            out += e;
            j += 2;
            continue;
          }
          lexError(j, 'Invalid escape sequence');
        }
        if (d === c) {
          closed = true;
          j++;
          break;
        }
        out += d;
        j++;
      }
      if (!closed) lexError(start, 'Unterminated string literal');
      push('STRING', out, start, j);
      i = j;
      continue;
    }

    if (c === '=') { push('OP', '=', i, i + 1); i++; continue; }
    if (c === '~') { push('OP', '~', i, i + 1); i++; continue; }
    if (c === '!') {
      const d = src[i + 1];
      if (d === '=' || d === '~') {
        push('OP', `!${d}`, i, i + 2);
        i += 2;
        continue;
      }
      lexError(i, "Unexpected character '!'");
    }
    if (c === '>' || c === '<') {
      if (src[i + 1] === '=') {
        push('OP', `${c}=`, i, i + 2);
        i += 2;
      } else {
        push('OP', c, i, i + 1);
        i++;
      }
      continue;
    }

    const signed = (c === '-' || c === '+') && isDigit(src[i + 1]);
    if (isDigit(c) || signed) {
      let j = i + (signed ? 1 : 0);
      while (isDigit(src[j])) j++;
      let isInt = true;
      if (src[j] === '.' && isDigit(src[j + 1])) {
        isInt = false;
        j++;
        while (isDigit(src[j])) j++;
      }
      const unit = src[j];
      if (isInt && unit !== undefined && DURATION_UNITS.includes(unit) && !isIdentChar(src[j + 1])) {
        push('DURATION', src.slice(start, j + 1), start, j + 1);
        i = j + 1;
        continue;
      }
      if (c === '+') lexError(i, "Unexpected character '+'");
      if (isIdentChar(src[j])) lexError(j, `Unexpected character '${src[j]}' in number`);
      push('NUMBER', Number(src.slice(start, j)), start, j);
      i = j;
      continue;
    }

    if (isIdentStart(c)) {
      let j = i + 1;
      while (isIdentChar(src[j])) j++;
      const text = src.slice(i, j);
      const upper = text.toUpperCase();
      if (KEYWORDS.has(upper)) push('KEYWORD', upper, i, j);
      else if (upper === 'TRUE' || upper === 'FALSE') push('BOOLEAN', upper === 'TRUE', i, j);
      else push('IDENT', text, i, j);
      i = j;
      continue;
    }

    lexError(i, `Unexpected character '${c}'`);
  }

  tokens.push({ type: 'EOF', value: '', text: '', start: n, end: n });
  return tokens;
}
