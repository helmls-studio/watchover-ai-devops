// A deliberately small JSON Schema (2020-12) validator.
// Only the keywords in SUPPORTED_KEYWORDS are understood. Anything else — an unknown
// keyword, a non-local $ref, a format other than date-time, or a malformed keyword
// value — makes the schema fail to load (fail closed) instead of being ignored.

const DIALECT = 'https://json-schema.org/draft/2020-12/schema';

export const SUPPORTED_KEYWORDS = Object.freeze([
  // annotations
  '$schema', '$id', '$comment', 'title', 'description',
  // structure
  '$defs', '$ref',
  // any instance
  'type', 'enum', 'const',
  // objects
  'properties', 'required', 'additionalProperties',
  // arrays
  'items', 'minItems', 'maxItems',
  // strings
  'minLength', 'maxLength', 'pattern', 'format',
  // numbers
  'minimum', 'maximum',
]);

const SUPPORTED = new Set(SUPPORTED_KEYWORDS);
const TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);
const LOCAL_REF = /^#\/\$defs\/([A-Za-z0-9_.-]+)$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/;

export class SchemaError extends Error {
  constructor(keyword, pointer, detail) {
    super(`schema keyword "${keyword}" at ${pointer || '(root)'}: ${detail}`);
    this.name = 'SchemaError';
    this.keyword = keyword;
    this.pointer = pointer;
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPrimitive = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v);
const escape = (segment) => String(segment).replace(/~/g, '~0').replace(/\//g, '~1');

export function isDateTime(value) {
  const m = DATE_TIME.exec(value);
  if (!m) return false;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > daysInMonth) return false;
  if (m[9] !== undefined && (Number(m[9]) > 23 || Number(m[10]) > 59)) return false;
  return true;
}

export function checkSchema(schema) {
  if (!isObject(schema)) throw new SchemaError('schema', '', 'a schema must be a JSON object');
  if (schema.$schema !== DIALECT) throw new SchemaError('$schema', '', `the root must declare ${DIALECT}`);
  checkNode(schema, '', schema.$defs, true);
}

function checkSubschema(value, pointer, keyword, defs) {
  if (!isObject(value)) throw new SchemaError(keyword, pointer, 'must be a schema object');
  checkNode(value, pointer, defs, false);
}

function checkNode(node, pointer, defs, isRoot) {
  const fail = (keyword, detail) => { throw new SchemaError(keyword, pointer, detail); };
  for (const [keyword, value] of Object.entries(node)) {
    if (!SUPPORTED.has(keyword)) fail(keyword, 'is not in the supported keyword set');
    switch (keyword) {
      case '$schema':
        if (!isRoot) fail(keyword, 'is only allowed at the root');
        break;
      case '$id': case '$comment': case 'title': case 'description':
        if (typeof value !== 'string') fail(keyword, 'must be a string');
        break;
      case '$defs':
        if (!isRoot) fail(keyword, 'is only allowed at the root');
        if (!isObject(value)) fail(keyword, 'must be an object of schemas');
        for (const [name, sub] of Object.entries(value)) checkSubschema(sub, `${pointer}/$defs/${escape(name)}`, keyword, defs);
        break;
      case '$ref': {
        const m = typeof value === 'string' ? LOCAL_REF.exec(value) : null;
        if (!m) fail(keyword, 'only local "#/$defs/<name>" references are supported');
        if (!isObject(defs) || !Object.hasOwn(defs, m[1])) fail(keyword, `"${value}" does not resolve`);
        break;
      }
      case 'type': {
        const types = Array.isArray(value) ? value : [value];
        if (types.length === 0 || !types.every((t) => TYPES.has(t))) fail(keyword, 'must name JSON types');
        break;
      }
      case 'enum':
        if (!Array.isArray(value) || value.length === 0 || !value.every(isPrimitive)) fail(keyword, 'must be a non-empty array of JSON primitives');
        break;
      case 'const':
        if (!isPrimitive(value)) fail(keyword, 'must be a JSON primitive');
        break;
      case 'properties':
        if (!isObject(value)) fail(keyword, 'must be an object of schemas');
        for (const [name, sub] of Object.entries(value)) checkSubschema(sub, `${pointer}/properties/${escape(name)}`, keyword, defs);
        break;
      case 'required':
        if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) fail(keyword, 'must be an array of property names');
        break;
      case 'additionalProperties':
        if (typeof value !== 'boolean') fail(keyword, 'must be true or false');
        break;
      case 'items':
        checkSubschema(value, `${pointer}/items`, keyword, defs);
        break;
      case 'minItems': case 'maxItems': case 'minLength': case 'maxLength':
        if (!Number.isInteger(value) || value < 0) fail(keyword, 'must be a non-negative integer');
        break;
      case 'minimum': case 'maximum':
        if (typeof value !== 'number' || !Number.isFinite(value)) fail(keyword, 'must be a number');
        break;
      case 'pattern':
        try {
          if (typeof value !== 'string') throw new Error();
          new RegExp(value, 'u');
        } catch {
          fail(keyword, 'must be a valid regular expression');
        }
        break;
      case 'format':
        if (value !== 'date-time') fail(keyword, 'only "date-time" is supported');
        break;
    }
  }
}

export function compileSchema(schema) {
  checkSchema(schema);
  const defs = schema.$defs ?? {};
  const patterns = new Map();
  const regex = (p) => patterns.get(p) ?? patterns.set(p, new RegExp(p, 'u')).get(p);

  function validate(s, value, pointer, errors) {
    const add = (keyword, message, at = pointer) => errors.push({ keyword, pointer: at, message });
    if (s.$ref) validate(defs[LOCAL_REF.exec(s.$ref)[1]], value, pointer, errors);

    if ('type' in s) {
      const types = Array.isArray(s.type) ? s.type : [s.type];
      if (!types.some((t) => matchesType(t, value))) {
        add('type', `expected ${types.join(' or ')}, got ${typeName(value)}`);
        return;
      }
    }
    if ('enum' in s && !s.enum.includes(value)) add('enum', `must be one of ${s.enum.map((e) => JSON.stringify(e)).join(', ')}`);
    if ('const' in s && s.const !== value) add('const', `must be ${JSON.stringify(s.const)}`);

    if (typeof value === 'string') {
      const length = [...value].length;
      if ('minLength' in s && length < s.minLength) add('minLength', `must be at least ${s.minLength} characters (got ${length})`);
      if ('maxLength' in s && length > s.maxLength) add('maxLength', `must be at most ${s.maxLength} characters (got ${length})`);
      if ('pattern' in s && !regex(s.pattern).test(value)) add('pattern', `must match ${s.pattern}`);
      if (s.format === 'date-time' && !isDateTime(value)) add('format', 'must be an RFC 3339 date-time with a time zone');
    }
    if (typeof value === 'number') {
      if ('minimum' in s && value < s.minimum) add('minimum', `must be at least ${s.minimum}`);
      if ('maximum' in s && value > s.maximum) add('maximum', `must be at most ${s.maximum}`);
    }
    if (Array.isArray(value)) {
      if ('minItems' in s && value.length < s.minItems) add('minItems', `must have at least ${s.minItems} items`);
      if ('maxItems' in s && value.length > s.maxItems) add('maxItems', `must have at most ${s.maxItems} items`);
      if (s.items) value.forEach((item, i) => validate(s.items, item, `${pointer}/${i}`, errors));
    }
    if (isObject(value)) {
      for (const name of s.required ?? []) {
        if (!Object.hasOwn(value, name)) add('required', `missing required property "${name}"`);
      }
      const props = s.properties ?? {};
      for (const [name, item] of Object.entries(value)) {
        const at = `${pointer}/${escape(name)}`;
        if (Object.hasOwn(props, name)) validate(props[name], item, at, errors);
        else if (s.additionalProperties === false) add('additionalProperties', `property "${name}" is not allowed`, at);
      }
    }
  }

  return (instance) => {
    const errors = [];
    validate(schema, instance, '', errors);
    return errors;
  };
}

function matchesType(type, value) {
  switch (type) {
    case 'null': return value === null;
    case 'array': return Array.isArray(value);
    case 'object': return isObject(value);
    case 'integer': return Number.isInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    default: return typeof value === type;
  }
}

function typeName(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
