/** Small JSON Schema shape tests shared by the batch planner and the paging rule. */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when the schema's `type` is `type` or a list that includes it. */
export function hasType(schema: Record<string, unknown>, type: string): boolean {
  return schema.type === type || (Array.isArray(schema.type) && schema.type.includes(type));
}

/** An array property whose items are objects (typed `object`, or carrying `properties`). */
export function isArrayOfObjects(schema: unknown): boolean {
  if (!isRecord(schema) || !hasType(schema, 'array')) return false;
  const items = schema.items;
  return isRecord(items) && (hasType(items, 'object') || isRecord(items.properties));
}

/** The `properties` of an object schema, or `{}`. */
export function propertiesOf(schema: unknown): Record<string, unknown> {
  return isRecord(schema) && isRecord(schema.properties) ? schema.properties : {};
}
