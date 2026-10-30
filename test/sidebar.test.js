import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isItalicRank } from '../src/sidebar.js';

test('names are italic from genus down, by convention', () => {
  for (const rank of ['genus', 'subgenus', 'species', 'subspecies', 'varietas', 'forma', 'species group']) {
    assert.equal(isItalicRank(rank, 'Whatever'), true, rank);
  }
});

test('names above genus are not italic', () => {
  for (const rank of ['family', 'order', 'class', 'phylum', 'kingdom', 'domain', 'superorder', 'tribe', 'suborder']) {
    assert.equal(isItalicRank(rank, 'Hominidae'), false, rank);
  }
});

test('an unranked name is italic only if it is a Latin binomial or trinomial', () => {
  assert.equal(isItalicRank('no rank', 'Arctia caja caja'), true);
  assert.equal(isItalicRank('no rank', 'Escherichia coli'), true);
  assert.equal(isItalicRank('no rank', 'Opisthokonta'), false);
  assert.equal(isItalicRank('no rank', 'Clade (Homo sapiens + Homo)'), false);
  assert.equal(isItalicRank('no rank', 'cellular organisms'), false);
  assert.equal(isItalicRank('no rank'), false);
});
