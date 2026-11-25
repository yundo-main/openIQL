import type { ComparisonOperator } from './ast.js';
import type { ResolvedField } from './schema.js';

/** Fully evaluated value: no functions, no durations. Dates are ISO-8601 UTC strings. */
export type ResolvedValue =
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'date'; value: string };

export type ResolvedNode =
  | { type: 'Logical'; operator: 'AND' | 'OR'; left: ResolvedNode; right: ResolvedNode }
  | { type: 'Not'; operand: ResolvedNode }
  | { type: 'Comparison'; field: ResolvedField; operator: ComparisonOperator; value: ResolvedValue }
  | { type: 'List'; field: ResolvedField; operator: 'IN' | 'NOT IN'; values: ResolvedValue[] }
  | { type: 'NullCheck'; field: ResolvedField; operator: 'IS EMPTY' | 'IS NOT EMPTY' }
  | {
      type: 'History';
      field: ResolvedField;
      operator: 'WAS' | 'CHANGED';
      value?: ResolvedValue;
      fromValue?: ResolvedValue;
      toValue?: ResolvedValue;
    };

export interface ResolvedOrderItem {
  field: ResolvedField;
  direction: 'ASC' | 'DESC';
}

export interface ResolvedQuery {
  where: ResolvedNode | null;
  orderBy: ResolvedOrderItem[];
}
