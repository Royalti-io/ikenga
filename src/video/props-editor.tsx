import { useMemo } from "react";
import { z } from "zod";

interface PropsEditorProps {
  /** Zod schema attached to the composition via defineComposition({schema}). */
  schema: unknown;
  /** Live values driving the preview. */
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}

interface FieldSpec {
  key: string;
  kind: "string" | "enum" | "number" | "boolean" | "unknown";
  enumValues?: string[];
  description?: string;
}

/**
 * Walk a Zod object schema and produce one FieldSpec per top-level key.
 *
 * Only handles shapes the registered compositions actually use:
 *   - z.string().default(...)
 *   - z.enum([...]).default(...)
 *
 * Anything else falls through to "unknown" and renders as a JSON textarea.
 */
function describeShape(schema: unknown): FieldSpec[] {
  if (!schema || typeof schema !== "object") return [];
  // Zod schemas expose `_def` at runtime; we narrow defensively.
  const objSchema = schema as z.ZodObject<z.ZodRawShape>;
  if (!("shape" in objSchema)) return [];

  const fields: FieldSpec[] = [];
  for (const [key, raw] of Object.entries(objSchema.shape)) {
    fields.push(describeField(key, raw as z.ZodTypeAny));
  }
  return fields;
}

function describeField(key: string, schema: z.ZodTypeAny): FieldSpec {
  // Unwrap ZodDefault / ZodOptional to find the inner type.
  let inner: z.ZodTypeAny = schema;
  // Loop because optional<default<...>> is possible.
  for (let i = 0; i < 5; i++) {
    const def = (inner as { _def?: { typeName?: string; innerType?: z.ZodTypeAny } })._def;
    if (!def) break;
    if (def.typeName === "ZodDefault" || def.typeName === "ZodOptional") {
      if (def.innerType) {
        inner = def.innerType;
        continue;
      }
    }
    break;
  }

  const def = (inner as { _def?: { typeName?: string; values?: string[] } })._def;
  const typeName = def?.typeName;

  if (typeName === "ZodEnum") {
    return { key, kind: "enum", enumValues: def?.values ?? [] };
  }
  if (typeName === "ZodString") return { key, kind: "string" };
  if (typeName === "ZodNumber") return { key, kind: "number" };
  if (typeName === "ZodBoolean") return { key, kind: "boolean" };
  return { key, kind: "unknown" };
}

export function PropsEditor({ schema, value, onChange }: PropsEditorProps) {
  const fields = useMemo(() => describeShape(schema), [schema]);

  if (fields.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border px-4 py-3 text-xs text-muted-foreground">
        No editable props.
      </div>
    );
  }

  function set(key: string, v: unknown) {
    onChange({ ...value, [key]: v });
  }

  return (
    <div className="flex flex-col gap-3">
      {fields.map((f) => (
        <FieldRow key={f.key} field={f} value={value[f.key]} onChange={(v) => set(f.key, v)} />
      ))}
    </div>
  );
}

function FieldRow({
  field,
  value,
  onChange,
}: {
  field: FieldSpec;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const inputClass =
    "w-full rounded-md border border-input bg-background px-2 py-1 text-sm";

  return (
    <label className="flex flex-col gap-1">
      <span className="font-mono text-xs font-medium text-foreground">{field.key}</span>
      {field.kind === "string" && (
        <input
          type="text"
          className={inputClass}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {field.kind === "number" && (
        <input
          type="number"
          className={inputClass}
          value={typeof value === "number" ? value : ""}
          onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
        />
      )}
      {field.kind === "boolean" && (
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
        />
      )}
      {field.kind === "enum" && field.enumValues && (
        <div className="flex flex-wrap gap-1">
          {field.enumValues.map((opt) => (
            <button
              key={opt}
              type="button"
              onClick={() => onChange(opt)}
              className={`rounded-md border px-2 py-1 text-xs ${
                value === opt
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-input bg-background hover:bg-accent"
              }`}
            >
              {opt}
            </button>
          ))}
        </div>
      )}
      {field.kind === "unknown" && (
        <textarea
          className={`${inputClass} font-mono text-xs`}
          rows={3}
          value={value === undefined ? "" : JSON.stringify(value, null, 2)}
          onChange={(e) => {
            try {
              onChange(JSON.parse(e.target.value));
            } catch {
              // ignore parse errors mid-edit
            }
          }}
        />
      )}
    </label>
  );
}
