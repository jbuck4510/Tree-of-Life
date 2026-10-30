import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitMatch } from '../src/search-box.js';

test('splitMatch bolds the first case-insensitive occurrence of the query', () => {
  assert.deepEqual(splitMatch('Homo sapiens', 'homo sap'), ['', 'Homo sap', 'iens']);
  assert.deepEqual(splitMatch('Homo sapiens', ' SAPIENS '), ['Homo ', 'sapiens', '']);
  assert.deepEqual(splitMatch('Pan (genus in Holozoa)', 'pan'), ['', 'Pan', ' (genus in Holozoa)']);
});

test('splitMatch leaves the name whole when there is nothing to highlight', () => {
  assert.deepEqual(splitMatch('Tigerekella', 'tiger cat'), ['Tigerekella', '', '']);
  assert.deepEqual(splitMatch('Homo sapiens', ''), ['Homo sapiens', '', '']);
  assert.deepEqual(splitMatch('Homo sapiens', '   '), ['Homo sapiens', '', '']);
});

test('splitMatch preserves the original casing and treats the query literally', () => {
  assert.deepEqual(splitMatch('Homo sapiens', 'HOMO'), ['', 'Homo', ' sapiens']);
  assert.deepEqual(splitMatch('Foo (bar) baz', '(bar)'), ['Foo ', '(bar)', ' baz']);
  assert.deepEqual(splitMatch('a.c', '.'), ['a', '.', 'c']);
});
