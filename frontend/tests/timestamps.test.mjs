import assert from 'node:assert/strict';
import { test } from 'node:test';

const { splitTimestamps } = await import('../src/lib/timestamps.ts');

const stamps = (text) => splitTimestamps(text).filter((p) => typeof p !== 'string');

test('finds m:ss and h:mm:ss', () => {
  assert.deepEqual(stamps('look at 1:23 and 12:34'), [
    { label: '1:23', seconds: 83 },
    { label: '12:34', seconds: 754 },
  ]);
  assert.deepEqual(stamps('from 1:02:03 on'), [{ label: '1:02:03', seconds: 3723 }]);
});

test('keeps the surrounding text, in order', () => {
  assert.deepEqual(splitTimestamps('at 0:05!'), ['at ', { label: '0:05', seconds: 5 }, '!']);
  assert.deepEqual(splitTimestamps('4:20'), [{ label: '4:20', seconds: 260 }]);
  assert.deepEqual(splitTimestamps('no times here'), ['no times here']);
});

test('ignores out-of-range fields and glued text', () => {
  assert.deepEqual(stamps('1:75'), []);
  assert.deepEqual(stamps('1:60:00'), []);
  assert.deepEqual(stamps('meet at 3:00pm'), []);
  assert.deepEqual(stamps('ratio 10:30:45:99'), []);
  assert.deepEqual(stamps('v1:23'), []);
  assert.deepEqual(stamps('123:45'), []);
});
