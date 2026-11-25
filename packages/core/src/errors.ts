import type { Span } from './ast.js';

export interface SourceLocation {
  offset: number;
  /** 1-based */
  line: number;
  /** 1-based */
  column: number;
}

export function locate(source: string, offset: number): SourceLocation {
  let line = 1;
  let lineStart = 0;
  const end = Math.min(offset, source.length);
  for (let i = 0; i < end; i++) {
    if (source.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { offset, line, column: offset - lineStart + 1 };
}

export type ErrorCode =
  | 'SyntaxError'
  | 'UnknownFieldError'
  | 'LimitExceededError'
  | 'ValidationError';

export class OpenIQLError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly location?: SourceLocation,
    readonly span?: Span,
  ) {
    super(message);
    this.name = new.target.name;
  }

  toJSON(): Record<string, unknown> {
    return {
      error: this.code,
      message: this.message,
      ...(this.location ? { location: this.location } : {}),
    };
  }
}

export class IQLSyntaxError extends OpenIQLError {
  constructor(
    message: string,
    location: SourceLocation,
    readonly expected: string[],
    span?: Span,
  ) {
    super('SyntaxError', message, location, span);
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), expected: this.expected };
  }
}

export class UnknownFieldError extends OpenIQLError {
  constructor(
    readonly field: string,
    location?: SourceLocation,
    span?: Span,
  ) {
    super('UnknownFieldError', `Unknown field '${field}'`, location, span);
  }
}

export type LimitName = 'maxQueryBytes' | 'maxDepth' | 'maxInListSize' | 'maxAstDepth' | 'maxOrderByItems';

export class LimitExceededError extends OpenIQLError {
  constructor(
    readonly limit: LimitName,
    readonly max: number,
    message: string,
    location?: SourceLocation,
    span?: Span,
  ) {
    super('LimitExceededError', message, location, span);
  }
}

export class ValidationError extends OpenIQLError {
  constructor(message: string, location?: SourceLocation, span?: Span) {
    super('ValidationError', message, location, span);
  }
}
