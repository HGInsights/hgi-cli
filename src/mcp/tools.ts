export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  title?: string;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: ToolAnnotations;
}

export type Verb = 'call' | 'run';

export function verbFor(tool: McpTool): Verb {
  return tool.annotations?.readOnlyHint === true ? 'call' : 'run';
}

export interface ToolParameter {
  name: string;
  type: string;
  required: boolean;
  description?: string;
}

export interface ToolSummary {
  name: string;
  verb: Verb;
  read_only: boolean | null;
  description: string;
  required: string[];
  parameters: ToolParameter[];
  input_schema: Record<string, unknown>;
}

function typeOf(schema: unknown): string {
  if (typeof schema !== 'object' || schema === null) return 'any';
  const s = schema as Record<string, unknown>;
  if (typeof s.type === 'string') return s.type;
  if (Array.isArray(s.type)) return s.type.join('|');
  for (const key of ['anyOf', 'oneOf']) {
    const alts = s[key];
    if (Array.isArray(alts)) return alts.map(typeOf).join('|');
  }
  if (s.enum) return 'enum';
  return 'any';
}

export function summarize(tool: McpTool): ToolSummary {
  const props = (tool.inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = Array.isArray(tool.inputSchema.required) ? (tool.inputSchema.required as string[]) : [];
  return {
    name: tool.name,
    verb: verbFor(tool),
    read_only: typeof tool.annotations?.readOnlyHint === 'boolean' ? tool.annotations.readOnlyHint : null,
    description: tool.description ?? '',
    required,
    parameters: Object.entries(props).map(([name, schema]) => ({
      name,
      type: typeOf(schema),
      required: required.includes(name),
      ...(typeof schema?.description === 'string' ? { description: schema.description } : {}),
    })),
    input_schema: tool.inputSchema,
  };
}
