import type { LiteralValue } from './ast.js';
import type { ResolvedValue } from './resolved.js';

export interface FunctionContext {
  userId?: string;
  now: Date;
}

export interface IQLFunction {
  minArgs: number;
  maxArgs: number;
  evaluate(
    args: readonly LiteralValue[],
    ctx: FunctionContext,
    fail: (message: string) => never,
  ): ResolvedValue;
}

const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

function applyOffset(
  base: Date,
  args: readonly LiteralValue[],
  fail: (message: string) => never,
): Date {
  const arg = args[0];
  if (!arg) return base;
  if (arg.kind !== 'duration') return fail('Expected a duration argument such as -7d or +1w');
  const m = /^([+-]?)(\d+)([smhdw])$/.exec(arg.value);
  if (!m) return fail(`Invalid duration '${arg.value}'`);
  const sign = m[1] === '-' ? -1 : 1;
  const ms = sign * Number(m[2]) * (UNIT_MS[m[3] as string] as number);
  return new Date(base.getTime() + ms);
}

const iso = (d: Date): ResolvedValue => ({ kind: 'date', value: d.toISOString() });

/** Built-in functions. Date math is performed in UTC. */
export const BUILTIN_FUNCTIONS: Readonly<Record<string, IQLFunction>> = {
  currentuser: {
    minArgs: 0,
    maxArgs: 0,
    evaluate(_args, ctx, fail) {
      if (!ctx.userId) return fail('currentUser() requires an authenticated user in the context');
      return { kind: 'string', value: ctx.userId };
    },
  },
  startofday: {
    minArgs: 0,
    maxArgs: 1,
    evaluate(args, ctx, fail) {
      const n = ctx.now;
      const start = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
      return iso(applyOffset(start, args, fail));
    },
  },
  startofweek: {
    minArgs: 0,
    maxArgs: 1,
    evaluate(args, ctx, fail) {
      const n = ctx.now;
      const dayStart = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
      const sinceMonday = (n.getUTCDay() + 6) % 7; // ISO week: Monday = 0
      const start = new Date(dayStart - sinceMonday * UNIT_MS.d!);
      return iso(applyOffset(start, args, fail));
    },
  },
};
