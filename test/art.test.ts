import assert from 'node:assert/strict';
import { test } from 'node:test';
import { artProgress, slotKey } from '../src/art.ts';

test('slotKey joins words with a dash and lowercases', () => {
  assert.equal(slotKey('Main hand'), 'main-hand');
  assert.equal(slotKey('Head'), 'head');
});

test('counts live items per group against the targets, and lists the missing ones', () => {
  const targets = {
    'behemoth-f': {
      own: [{ name: 'Valtor', slot: 'Head' }, { name: 'Bulwark Armor', slot: 'Body' }],
      universal: [{ name: 'Iron Skullcap', slot: 'Head' }],
      held: [{ name: 'Bucket', slot: 'Off hand' }],
    },
  };
  const live = { 'behemoth-f': ['head:Valtor', 'off-hand:Bucket', 'main-hand:Something Else'] };
  const [p] = artProgress(targets, live, ['behemoth-f']);
  assert.deepEqual(p.groups.map(g => [g.group, g.live, g.total]), [['own', 1, 2], ['universal', 0, 1], ['held', 1, 1]]);
  assert.deepEqual(p.groups[0].missing.map(m => m.name), ['Bulwark Armor']);
  assert.equal(p.live, 2);
  assert.equal(p.total, 4);
  assert.equal(p.liveKnown, true);
});

test('curly apostrophes and case do not hide a live item', () => {
  const [p] = artProgress({ b: { own: [{ name: "Villein's Hat", slot: 'Head' }] } }, { b: ['head:Villein’s Hat'] }, ['b']);
  assert.equal(p.groups[0].live, 1);
});

test('a duplicated target counts once', () => {
  const [p] = artProgress({ b: { own: [{ name: 'A', slot: 'Head' }, { name: 'A', slot: 'Head' }] } }, { b: [] }, ['b']);
  assert.equal(p.groups[0].total, 1);
});

test('an item listed as universal and held counts once, as held', () => {
  const [p] = artProgress({ b: { universal: [{ name: 'Charm', slot: 'Neck' }], held: [{ name: 'Charm', slot: 'Neck' }] } }, { b: ['neck:Charm'] }, ['b']);
  assert.deepEqual(p.groups.map(g => [g.group, g.live, g.total]), [['own', 0, 0], ['universal', 0, 0], ['held', 1, 1]]);
  assert.equal(p.total, 1);
});

test('an unreadable live index is flagged, not counted as zero silently', () => {
  const [p] = artProgress({ b: { own: [{ name: 'A', slot: 'Head' }] } }, {}, ['b']);
  assert.equal(p.liveKnown, false);
  assert.equal(p.live, 0);
});

test('warborn items are listed apart and never count toward the total', () => {
  const [p] = artProgress({ b: { own: [{ name: 'A', slot: 'Head' }], warborn: [{ name: 'W', slot: 'Feet' }, { name: 'X', slot: 'Head' }] } }, { b: ['head:A', 'feet:W'] }, ['b']);
  assert.equal(p.total, 1);
  assert.equal(p.live, 1);
  assert.deepEqual([p.warborn.live, p.warborn.total], [1, 2]);
  assert.equal(p.groups.length, 3);
});
