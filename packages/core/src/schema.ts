import { UnknownFieldError, ValidationError } from './errors.js';

export type FieldType = 'STRING' | 'NUMBER' | 'BOOLEAN' | 'DATE';

export interface FieldDefinition {
  type: FieldType;
  /** Backing column name (or index field path); defaults to the field name. */
  column?: string;
}

export interface SchemaConfig {
  /** Fixed core fields, keyed by the name users type (e.g. `status`). */
  fields: Record<string, FieldDefinition>;
  /** Custom fields stored in a JSONB document, addressed as `<prefix>.<key>`. */
  customFields?: Record<string, { type: FieldType }>;
  /** Namespace used for custom fields. Default: `cf`. */
  customFieldPrefix?: string;
}

export interface ResolvedField {
  /** Canonical user-facing name, e.g. `status` or `cf.story_points`. */
  name: string;
  type: FieldType;
  storage: 'column' | 'custom';
  /** Column for `column` storage; JSONB key for `custom` storage. Always matches /^[A-Za-z_]\w*$/. */
  column: string;
}

const SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FIELD_TYPES: readonly FieldType[] = ['STRING', 'NUMBER', 'BOOLEAN', 'DATE'];

function assertSafe(kind: string, value: string): void {
  if (!SAFE_NAME.test(value)) {
    throw new ValidationError(`Invalid ${kind} '${value}' in schema: must match ${SAFE_NAME}`);
  }
}

/** Whitelist of fields a query may reference. Anything else raises UnknownFieldError. */
export class Schema {
  private readonly core = new Map<string, ResolvedField>();
  private readonly custom = new Map<string, ResolvedField>();
  readonly customFieldPrefix: string;

  constructor(config: SchemaConfig) {
    this.customFieldPrefix = config.customFieldPrefix ?? 'cf';
    assertSafe('custom field prefix', this.customFieldPrefix);
    for (const [name, def] of Object.entries(config.fields)) {
      assertSafe('field name', name);
      const column = def.column ?? name;
      assertSafe('column name', column);
      this.assertType(name, def.type);
      this.core.set(name, { name, type: def.type, storage: 'column', column });
    }
    for (const [key, def] of Object.entries(config.customFields ?? {})) {
      assertSafe('custom field key', key);
      this.assertType(key, def.type);
      const name = `${this.customFieldPrefix}.${key}`;
      this.custom.set(name, { name, type: def.type, storage: 'custom', column: key });
    }
  }

  private assertType(name: string, type: FieldType): void {
    if (!FIELD_TYPES.includes(type)) {
      throw new ValidationError(`Invalid type '${String(type)}' for field '${name}' in schema`);
    }
  }

  /** Returns undefined for unregistered fields (own-property lookups only). */
  lookup(name: string): ResolvedField | undefined {
    return this.core.get(name) ?? this.custom.get(name);
  }

  resolveField(name: unknown): ResolvedField {
    if (typeof name !== 'string') throw new ValidationError('Field name must be a string');
    const f = this.lookup(name);
    if (!f) throw new UnknownFieldError(name);
    return f;
  }
}

export function createSchema(config: SchemaConfig): Schema {
  return new Schema(config);
}
