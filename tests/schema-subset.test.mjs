import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SUPPORTED_KEYWORDS, SchemaError, checkSchema, compileSchema } from '../tools/lib/schema-subset.mjs';

const DRAFT = 'https://json-schema.org/draft/2020-12/schema';
const root = (body) => ({ $schema: DRAFT, ...body });

function assertSchemaError(schema, keyword, pointer) {
  assert.throws(
    () => checkSchema(schema),
    (err) => {
      assert.ok(err instanceof SchemaError, `expected SchemaError, got ${err}`);
      assert.equal(err.keyword, keyword);
      assert.equal(err.pointer, pointer);
      assert.ok(err.message.includes(keyword) && err.message.includes(pointer || '(root)'));
      return true;
    },
  );
}

test('the supported keyword set is exactly the enumerated contract', () => {
  assert.deepEqual([...SUPPORTED_KEYWORDS].sort(), [
    '$comment', '$defs', '$id', '$ref', '$schema', 'additionalProperties', 'const',
    'description', 'enum', 'format', 'items', 'maxItems', 'maxLength', 'maximum',
    'minItems', 'minLength', 'minimum', 'pattern', 'properties', 'required', 'title', 'type',
  ]);
});

test('a schema using every supported keyword is accepted', () => {
  const schema = root({
    $id: 'urn:example:all', $comment: 'c', title: 't', description: 'd',
    type: 'object', required: ['a'], additionalProperties: false,
    properties: {
      a: { type: 'string', minLength: 1, maxLength: 9, pattern: '^x', format: 'date-time' },
      b: { type: 'array', items: { $ref: '#/$defs/n' }, minItems: 0, maxItems: 3 },
      c: { enum: ['x', 'y'] },
      d: { const: 1 },
    },
    $defs: { n: { type: 'integer', minimum: 0, maximum: 5 } },
  });
  assert.doesNotThrow(() => checkSchema(schema));
});

test('an unsupported keyword fails closed with keyword and pointer', () => {
  assertSchemaError(root({ type: 'object', properties: { a: { type: 'object', patternProperties: {} } } }), 'patternProperties', '/properties/a');
});

test('unsupported keywords are found inside $defs and items', () => {
  assertSchemaError(root({ $defs: { x: { oneOf: [] } } }), 'oneOf', '/$defs/x');
  assertSchemaError(root({ type: 'array', items: { if: {} } }), 'if', '/items');
});

test('a remote or non-local $ref fails closed', () => {
  assertSchemaError(root({ properties: { a: { $ref: 'https://example.com/other.json' } } }), '$ref', '/properties/a');
  assertSchemaError(root({ properties: { a: { $ref: 'other.json#/$defs/x' } } }), '$ref', '/properties/a');
});

test('a local $ref that does not resolve fails closed', () => {
  assertSchemaError(root({ properties: { a: { $ref: '#/$defs/missing' } } }), '$ref', '/properties/a');
});

test('a format other than date-time fails closed', () => {
  assertSchemaError(root({ properties: { a: { type: 'string', format: 'email' } } }), 'format', '/properties/a');
});

test('the root must declare the 2020-12 dialect', () => {
  assertSchemaError({ type: 'object' }, '$schema', '');
  assertSchemaError({ $schema: 'http://json-schema.org/draft-07/schema#' }, '$schema', '');
});

test('malformed keyword values fail closed', () => {
  assertSchemaError(root({ properties: { a: 'string' } }), 'properties', '/properties/a');
  assertSchemaError(root({ additionalProperties: {} }), 'additionalProperties', '');
  assertSchemaError(root({ type: 'strin' }), 'type', '');
  assertSchemaError(root({ pattern: '(' }), 'pattern', '');
  assertSchemaError(root({ required: 'a' }), 'required', '');
  assertSchemaError(root({ enum: [] }), 'enum', '');
  assertSchemaError(root({ minLength: -1 }), 'minLength', '');
  assertSchemaError('not a schema', 'schema', '');
});

test('JSON pointer segments are escaped', () => {
  assertSchemaError(root({ properties: { 'a/b~c': { then: {} } } }), 'then', '/properties/a~1b~0c');
});

test('compileSchema refuses an unsupported schema before validating anything', () => {
  assert.throws(() => compileSchema(root({ unevaluatedProperties: false })), SchemaError);
});

const errorsFor = (schema, instance) => compileSchema(root(schema))(instance);
const only = (errors) => errors.map((e) => `${e.keyword} ${e.pointer}`);

test('type mismatches are reported with the instance pointer', () => {
  assert.deepEqual(only(errorsFor({ properties: { a: { type: 'string' } } }, { a: 1 })), ['type /a']);
  assert.deepEqual(only(errorsFor({ type: 'integer' }, 1.5)), ['type ']);
  assert.deepEqual(errorsFor({ type: ['string', 'null'] }, null), []);
  assert.deepEqual(only(errorsFor({ type: 'object' }, [])), ['type ']);
});

test('required and additionalProperties are enforced', () => {
  const schema = { type: 'object', required: ['a'], additionalProperties: false, properties: { a: {} } };
  assert.deepEqual(only(errorsFor(schema, {})), ['required ']);
  assert.deepEqual(only(errorsFor(schema, { a: 1, value: 'x' })), ['additionalProperties /value']);
});

test('enum and const compare by value', () => {
  assert.deepEqual(only(errorsFor({ enum: ['A', 'B'] }, 'C')), ['enum ']);
  assert.deepEqual(errorsFor({ enum: ['A', null] }, null), []);
  assert.deepEqual(only(errorsFor({ const: '0.1' }, '0.2')), ['const ']);
});

test('array keywords validate items and bounds', () => {
  const schema = { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 2 };
  assert.deepEqual(only(errorsFor(schema, [])), ['minItems ']);
  assert.deepEqual(only(errorsFor(schema, ['a', 'b', 'c'])), ['maxItems ']);
  assert.deepEqual(only(errorsFor(schema, ['a', 2])), ['type /1']);
});

test('string keywords validate length, pattern and date-time', () => {
  assert.deepEqual(only(errorsFor({ minLength: 2 }, 'a')), ['minLength ']);
  assert.deepEqual(only(errorsFor({ maxLength: 1 }, 'ab')), ['maxLength ']);
  assert.deepEqual(only(errorsFor({ pattern: '^evt-' }, 'x')), ['pattern ']);
  const dt = { type: 'string', format: 'date-time' };
  assert.deepEqual(errorsFor(dt, '2026-09-01T09:00:00Z'), []);
  assert.deepEqual(errorsFor(dt, '2026-09-01T09:00:00.250+10:00'), []);
  for (const bad of ['2026-09-01', '2026-09-01T09:00:00', '2026-02-30T09:00:00Z', '2026-09-01T24:00:00Z']) {
    assert.deepEqual(only(errorsFor(dt, bad)), ['format '], bad);
  }
});

test('numeric bounds are enforced', () => {
  assert.deepEqual(only(errorsFor({ minimum: 1 }, 0)), ['minimum ']);
  assert.deepEqual(only(errorsFor({ maximum: 1 }, 2)), ['maximum ']);
});

test('local $ref is resolved during validation', () => {
  const schema = { properties: { a: { $ref: '#/$defs/s' } }, $defs: { s: { enum: ['ok'] } } };
  assert.deepEqual(only(errorsFor(schema, { a: 'no' })), ['enum /a']);
});
