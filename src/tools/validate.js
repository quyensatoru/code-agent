// Lightweight JSON-schema validation + coercion for tool arguments.
//
// Models — especially weaker ones — routinely send numbers as strings or
// booleans as "true". Instead of failing deep inside a tool, we validate the
// arguments against the tool's declared schema up front, coerce obvious
// near-misses, and return actionable error messages the model can repair from.
//
// Supports the subset of JSON Schema our tool definitions use: type
// (object/string/integer/number/boolean/array), required, properties, enum,
// minimum/maximum, items.

export function validateInput(schema = {}, input = {}) {
    const errors = [];
    const value = coerceObject(schema, input ?? {}, '', errors);
    return { value, errors };
}

function coerceObject(schema, input, path, errors) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        errors.push(`${path || 'input'} must be an object`);
        return {};
    }
    const out = { ...input };
    for (const key of schema.required || []) {
        if (out[key] === undefined || out[key] === null || out[key] === '') {
            errors.push(`missing required parameter "${joinPath(path, key)}"`);
        }
    }
    for (const [key, propSchema] of Object.entries(schema.properties || {})) {
        if (out[key] === undefined || out[key] === null) continue;
        out[key] = coerceValue(propSchema, out[key], joinPath(path, key), errors);
    }
    return out;
}

function coerceValue(schema, value, path, errors) {
    const type = schema.type;

    if (type === 'integer' || type === 'number') {
        const num = typeof value === 'number' ? value : Number(value);
        if (typeof value === 'boolean' || !Number.isFinite(num)) {
            errors.push(`"${path}" must be a ${type}`);
            return value;
        }
        const final = type === 'integer' ? Math.trunc(num) : num;
        if (schema.minimum !== undefined && final < schema.minimum) {
            errors.push(`"${path}" must be >= ${schema.minimum}`);
        }
        if (schema.maximum !== undefined && final > schema.maximum) {
            errors.push(`"${path}" must be <= ${schema.maximum}`);
        }
        return final;
    }

    if (type === 'boolean') {
        if (typeof value === 'boolean') return value;
        const text = String(value).toLowerCase();
        if (['true', '1', 'yes', 'on'].includes(text)) return true;
        if (['false', '0', 'no', 'off'].includes(text)) return false;
        errors.push(`"${path}" must be a boolean`);
        return value;
    }

    if (type === 'string') {
        let text = value;
        if (typeof text !== 'string') {
            text = typeof text === 'object' ? JSON.stringify(text) : String(text);
        }
        if (schema.enum && !schema.enum.includes(text)) {
            errors.push(`"${path}" must be one of: ${schema.enum.join(', ')}`);
        }
        return text;
    }

    if (type === 'array') {
        if (!Array.isArray(value)) {
            errors.push(`"${path}" must be an array`);
            return value;
        }
        if (!schema.items) return value;
        return value.map((item, index) =>
            schema.items.type === 'object'
                ? coerceObject(schema.items, item, `${path}[${index}]`, errors)
                : coerceValue(schema.items, item, `${path}[${index}]`, errors)
        );
    }

    if (type === 'object') return coerceObject(schema, value, path, errors);
    return value;
}

function joinPath(path, key) {
    return path ? `${path}.${key}` : key;
}
