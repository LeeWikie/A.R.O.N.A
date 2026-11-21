export type FormSchema = {
  type?: string | string[]; title?: string; description?: string; default?: unknown; const?: unknown; enum?: unknown[];
  properties?: Record<string, FormSchema>; required?: string[]; items?: FormSchema;
  minItems?: number; maxItems?: number; minLength?: number; maxLength?: number; minimum?: number; maximum?: number;
};
export const formCancelled = Symbol('formCancelled');
type Host = {
  prompt(title: string, initial?: string): Promise<string | undefined>;
  choose(title: string, items: Array<{ value: string; label: string }>): Promise<string | undefined>;
  note(text: string): void;
};

/** Collect only fields declared by the server. Validation errors leave the form open. */
export async function collectForm(host: Host, schema: FormSchema, title: string, initial?: unknown, depth = 0): Promise<unknown | typeof formCancelled> {
  if (depth > 16) throw new Error('form_schema_too_deep');
  const current = initial ?? schema.default;
  if (Object.hasOwn(schema, 'const')) return schema.const;
  if (schema.enum?.length) {
    if (schema.enum.length === 1) return schema.enum[0];
    const selected = await host.choose(title, schema.enum.map((value, i) => ({ value: String(i), label: String(value) })));
    return selected === undefined ? formCancelled : schema.enum[Number(selected)];
  }
  const type = Array.isArray(schema.type) ? schema.type.find(value => value !== 'null') : schema.type;
  if (type === 'object' || schema.properties) {
    const result: Record<string, unknown> = {};
    const values = current && typeof current === 'object' ? current as Record<string, unknown> : {};
    for (const [key, field] of Object.entries(schema.properties ?? {})) {
      const required = schema.required?.includes(key);
      if (!required && values[key] === undefined && field.default === undefined) {
        const include = await host.choose(`${field.title ?? key}（可选）`, [{ value: 'skip', label: '略过' }, { value: 'set', label: '填写' }]);
        if (include === undefined) return formCancelled;
        if (include !== 'set') continue;
      }
      const value = await collectForm(host, field, field.title ?? key, values[key], depth + 1);
      if (value === formCancelled) return formCancelled;
      Object.defineProperty(result, key, { value, enumerable: true, writable: true, configurable: true });
    }
    return result;
  }
  if (type === 'array') {
    const values = Array.isArray(current) ? [...current] : [];
    for (;;) {
      if (values.length < (schema.minItems ?? 0)) {
        const value = await collectForm(host, schema.items ?? {}, `${title} · ${values.length + 1}`, undefined, depth + 1);
        if (value === formCancelled) return formCancelled;
        values.push(value); continue;
      }
      const action = await host.choose(title, [
        ...(values.length >= (schema.minItems ?? 0) ? [{ value: 'done', label: '完成' }] : []),
        ...(values.length < (schema.maxItems ?? Infinity) ? [{ value: 'add', label: '添加' }] : []),
        ...values.map((value, i) => ({ value: `item:${i}`, label: `${i + 1}. ${typeof value === 'string' ? value : JSON.stringify(value)}` })),
      ]);
      if (action === undefined) return formCancelled;
      if (action === 'done' && values.length >= (schema.minItems ?? 0)) return values;
      if (action === 'add') {
        const value = await collectForm(host, schema.items ?? {}, `${title} · ${values.length + 1}`, undefined, depth + 1);
        if (value !== formCancelled) values.push(value);
      } else if (action.startsWith('item:')) {
        const index = Number(action.slice(5));
        if (!Number.isInteger(index) || index < 0 || index >= values.length) continue;
        const operation = await host.choose(title, [{ value: 'edit', label: '修改' }, { value: 'remove', label: '移除' }]);
        if (operation === 'remove') values.splice(index, 1);
        else if (operation === 'edit') {
          const value = await collectForm(host, schema.items ?? {}, title, values[index], depth + 1);
          if (value !== formCancelled) values[index] = value;
        }
      }
    }
  }
  if (type === 'boolean') {
    const value = await host.choose(title, [{ value: 'true', label: '是' }, { value: 'false', label: '否' }]);
    return value === undefined ? formCancelled : value === 'true';
  }
  let draft = current === undefined ? '' : typeof current === 'string' ? current : JSON.stringify(current);
  for (;;) {
    const text = await host.prompt(`${title}${schema.description ? `\n${schema.description}` : ''}`, draft);
    if (text === undefined) return formCancelled;
    draft = text;
    if (type === 'number' || type === 'integer') {
      const number = text.trim() ? Number(text) : NaN;
      if (Number.isFinite(number) && (type !== 'integer' || Number.isSafeInteger(number)) && number >= (schema.minimum ?? -Infinity) && number <= (schema.maximum ?? Infinity)) return number;
      host.note('请输入有效范围内的数字。');
    } else if (type === 'string') {
      if (text.length >= (schema.minLength ?? 0) && text.length <= (schema.maxLength ?? Infinity)) return text;
      host.note('文本长度不符合要求。');
    } else {
      try { return JSON.parse(text); } catch { host.note('请输入有效的 JSON 值。'); }
    }
  }
}
