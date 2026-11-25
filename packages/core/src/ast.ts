/** Half-open character range [start, end) into the source string (UTF-16 code units). */
export interface Span {
  start: number;
  end: number;
}

export interface OrderItem {
  field: string;
  direction: 'ASC' | 'DESC';
  span?: Span;
}

export interface QueryAST {
  where: ASTNode | null;
  orderBy: OrderItem[];
}

export type ASTNode =
  | LogicalNode
  | NotNode
  | ComparisonNode
  | ListNode
  | NullCheckNode
  | HistoryNode;

export type ComparisonOperator = '=' | '!=' | '>' | '>=' | '<' | '<=' | '~' | '!~';

export interface LogicalNode {
  type: 'Logical';
  operator: 'AND' | 'OR';
  left: ASTNode;
  right: ASTNode;
  span?: Span;
}

export interface NotNode {
  type: 'Not';
  operand: ASTNode;
  span?: Span;
}

export interface ComparisonNode {
  type: 'Comparison';
  field: string;
  operator: ComparisonOperator;
  value: LiteralValue | FunctionCallValue;
  span?: Span;
}

export interface ListNode {
  type: 'List';
  field: string;
  operator: 'IN' | 'NOT IN';
  values: Array<LiteralValue | FunctionCallValue>;
  span?: Span;
}

export interface NullCheckNode {
  type: 'NullCheck';
  field: string;
  operator: 'IS EMPTY' | 'IS NOT EMPTY';
  span?: Span;
}

/** `WAS v` uses `value`; `CHANGED [FROM a] [TO b]` uses `fromValue` / `toValue`. */
export interface HistoryNode {
  type: 'History';
  field: string;
  operator: 'WAS' | 'CHANGED';
  value?: LiteralValue | FunctionCallValue;
  fromValue?: LiteralValue | FunctionCallValue;
  toValue?: LiteralValue | FunctionCallValue;
  span?: Span;
}

export type LiteralValue =
  | { kind: 'string'; value: string; span?: Span }
  | { kind: 'number'; value: number; span?: Span }
  | { kind: 'boolean'; value: boolean; span?: Span }
  /** e.g. "-7d", "+1w"; only meaningful as a function argument. */
  | { kind: 'duration'; value: string; span?: Span };

export interface FunctionCallValue {
  kind: 'function';
  name: string;
  args: LiteralValue[];
  span?: Span;
}
