import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyText, hashFor, parseHash, shareLink, shareUrl } from '../src/share-link.js';

test('hashFor uses the taxon id when there is one, so an unnamed node that stands for a taxon keeps its name', () => {
  assert.equal(hashFor({ id: 'ott770315', ottId: 770315 }), '#ott770315');
  assert.equal(hashFor({ id: 'mrcaott616ott617', ottId: 474506 }), '#ott474506');
  assert.equal(hashFor({ id: 'mrcaott50ott3311', ottId: null }), '#mrcaott50ott3311');
});

test('parseHash accepts the forms we write and a few friendly variants', () => {
  for (const [hash, id] of [
    ['#ott770315', 'ott770315'],
    ['ott770315', 'ott770315'],
    ['#770315', 'ott770315'],
    ['#/ott770315', 'ott770315'],
    ['#node=ott770315', 'ott770315'],
    ['#ott770315&utm=x', 'ott770315'],
    ['#mrcaott616ott617', 'mrcaott616ott617'],
    ['#ott%37%37%30%33%31%35', 'ott770315'],
  ]) assert.equal(parseHash(hash), id, hash);
});

test('parseHash rejects anything that is not a node reference', () => {
  for (const bad of ['', '#', undefined, null, '#about', '#ott', '#ott12x', '#<script>', '#ott1;2', '#%E0%A4%A', '#-5']) {
    assert.equal(parseHash(bad), null, String(bad));
  }
});

test('shareUrl keeps the page address and swaps the hash', () => {
  const loc = { origin: 'https://example.org', pathname: '/tree/', search: '?lang=en', hash: '#old' };
  assert.equal(shareUrl(loc, { id: 'ott1', ottId: 1 }), 'https://example.org/tree/?lang=en#ott1');
});

test('copyText uses the async clipboard when it can', async () => {
  let written;
  assert.equal(await copyText('hi', { nav: { clipboard: { writeText: async (t) => { written = t; } } } }), 'copied');
  assert.equal(written, 'hi');
});

function fakeDoc({ execOk = true } = {}) {
  const made = [];
  return {
    made,
    createElement: () => { const el = { style: {}, setAttribute() {}, select() {}, remove() { el.removed = true; } }; made.push(el); return el; },
    body: { append() {} },
    execCommand: (cmd) => cmd === 'copy' && execOk,
  };
}

test('copyText falls back to execCommand, and reports "manual" when nothing works', async () => {
  const denied = { clipboard: { writeText: async () => { throw new DOMException('denied', 'NotAllowedError'); } } };
  const doc = fakeDoc();
  assert.equal(await copyText('hi', { nav: denied, doc }), 'copied');
  assert.ok(doc.made[0].removed, 'the temporary textarea is cleaned up');
  assert.equal(await copyText('hi', { nav: {}, doc: fakeDoc({ execOk: false }) }), 'manual');
  assert.equal(await copyText('hi', { nav: {}, doc: {} }), 'manual');
});

test('shareLink uses the share sheet on touch devices, copying elsewhere or if the sheet fails', async () => {
  const calls = [];
  const sheet = { share: async (d) => { calls.push(d); }, clipboard: { writeText: async () => { calls.push('copy'); } } };
  assert.equal(await shareLink({ url: 'u', title: 't' }, { nav: sheet, preferSheet: true }), 'shared');
  assert.deepEqual(calls, [{ url: 'u', title: 't' }]);

  calls.length = 0;
  assert.equal(await shareLink({ url: 'u', title: 't' }, { nav: sheet, preferSheet: false }), 'copied', 'desktop copies even if share exists');
  assert.deepEqual(calls, ['copy']);

  const cancelled = { ...sheet, share: async () => { throw new DOMException('x', 'AbortError'); } };
  assert.equal(await shareLink({ url: 'u' }, { nav: cancelled, preferSheet: true }), 'cancelled');

  const broken = { ...sheet, share: async () => { throw new TypeError('nope'); } };
  assert.equal(await shareLink({ url: 'u' }, { nav: broken, preferSheet: true }), 'copied');
});
