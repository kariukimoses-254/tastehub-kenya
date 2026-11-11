const test = require('node:test');
const assert = require('node:assert/strict');

const v = require('../server/lib/validation');

test('Kenyan mobile numbers are normalised and validated', () => {
  assert.equal(v.normalisePhone('0712 345 678'), '0712345678');
  assert.equal(v.normalisePhone('+254 712-345-678'), '+254712345678');
  assert.equal(v.normalisePhone('254712345678'), '254712345678');
  assert.equal(v.normalisePhone('0112345678'), '0112345678');
  assert.throws(() => v.normalisePhone('12345'), /valid Kenyan mobile/i);
  assert.throws(() => v.normalisePhone(''), /required/i);
});

test('emails are trimmed and lower-cased', () => {
  assert.equal(v.normaliseEmail('  Manager@TasteHub.co.ke '), 'manager@tastehub.co.ke');
  assert.equal(v.normaliseEmail(''), null);
  assert.throws(() => v.normaliseEmail('not-an-email'), /invalid/i);
});

test('positiveInt rejects fractions and out-of-range values', () => {
  assert.equal(v.positiveInt('3'), 3);
  assert.equal(v.positiveInt(0, { min: 0 }), 0);
  assert.throws(() => v.positiveInt('1.5'), /whole number/i);
  assert.throws(() => v.positiveInt(-1), /whole number/i);
  assert.throws(() => v.positiveInt(101, { max: 100 }), /between 1 and 100/i);
});

test('string helpers enforce required and maximum lengths', () => {
  assert.equal(v.requiredString('  hello  ', { max: 10 }), 'hello');
  assert.throws(() => v.requiredString('   ', { field: 'Name' }), /Name is required/i);
  assert.throws(() => v.requiredString('abcdef', { max: 3, field: 'Code' }), /3 characters or fewer/i);
  assert.equal(v.optionalString('', { max: 10 }), null);
});

test('oneOf applies fallbacks and rejects unknown values', () => {
  assert.equal(v.oneOf(undefined, ['a', 'b'], { fallback: 'a' }), 'a');
  assert.equal(v.oneOf('b', ['a', 'b']), 'b');
  assert.throws(() => v.oneOf('c', ['a', 'b']), /must be one of/i);
});

test('booleanFlag accepts common boolean encodings', () => {
  assert.equal(v.booleanFlag(true), true);
  assert.equal(v.booleanFlag('false'), false);
  assert.equal(v.booleanFlag(0), false);
  assert.equal(v.booleanFlag(undefined, true), true);
  assert.throws(() => v.booleanFlag('maybe'), /true\/false/i);
});
