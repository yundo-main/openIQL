import type { ASTNode, FunctionCallValue, LiteralValue, QueryAST } from './ast.js';

function quote(s: string): string {
  return `"${s.replace(/[\\"]/g, '\\$&')}"`;
}

function value(v: LiteralValue | FunctionCallValue): string {
  switch (v.kind) {
    case 'string':
      return quote(v.value);
    case 'number':
    case 'duration':
      return String(v.value);
    case 'boolean':
      return v.value ? 'true' : 'false';
    case 'function':
      return `${v.name}(${v.args.map(value).join(', ')})`;
  }
}

const PREC = { OR: 1, AND: 2 } as const;

function node(n: ASTNode): string {
  switch (n.type) {
    case 'Logical': {
      const p = PREC[n.operator];
      const l = n.left.type === 'Logical' && PREC[n.left.operator] < p ? `(${node(n.left)})` : node(n.left);
      // Right children are always grouped when logical so re-parsing keeps the tree shape.
      const r =
        n.right.type === 'Logical' && PREC[n.right.operator] <= p ? `(${node(n.right)})` : node(n.right);
      return `${l} ${n.operator} ${r}`;
    }
    case 'Not':
      return n.operand.type === 'Logical' ? `NOT (${node(n.operand)})` : `NOT ${node(n.operand)}`;
    case 'Comparison':
      return `${n.field} ${n.operator} ${value(n.value)}`;
    case 'List':
      return `${n.field} ${n.operator} (${n.values.map(value).join(', ')})`;
    case 'NullCheck':
      return `${n.field} ${n.operator}`;
    case 'History':
      if (n.operator === 'WAS') return `${n.field} WAS ${n.value ? value(n.value) : ''}`.trimEnd();
      return [
        `${n.field} CHANGED`,
        n.fromValue ? `FROM ${value(n.fromValue)}` : '',
        n.toValue ? `TO ${value(n.toValue)}` : '',
      ]
        .filter(Boolean)
        .join(' ');
  }
}

/** Serialises an AST back to OpenIQL text (UI filter object -> search bar). */
export function print(ast: QueryAST): string {
  const parts: string[] = [];
  if (ast.where) parts.push(node(ast.where));
  if (ast.orderBy.length > 0) {
    parts.push(`ORDER BY ${ast.orderBy.map((o) => `${o.field} ${o.direction}`).join(', ')}`);
  }
  return parts.join(' ');
}
