import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as store from './store';

// created_at has 1ms resolution; a real user can't act twice within a
// millisecond, but a test issuing several addEntry()/touch() calls back to
// back can easily tie, since ties have no defined order in store.ts (and
// don't need one — no real usage can trigger this). Busy-wait for the
// clock to tick over between calls that need distinguishable timestamps,
// rather than an async sleep() whose real-world granularity isn't
// guaranteed to exceed 1ms.
function waitForNextMs(): void {
  const start = Date.now();
  while (Date.now() === start) {
    // spin
  }
}

let tmpDir: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipboardian-test-'));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  store.init(path.join(tmpDir, `${Date.now()}-${Math.random()}.db`));
});

afterEach(() => {
  store.close();
});

test('addEntry inserts new text', () => {
  store.addEntry('hello');
  const results = store.search('');
  assert.equal(results.length, 1);
  assert.equal(results[0].text, 'hello');
});

test('addEntry ignores blank/whitespace-only text', () => {
  store.addEntry('   ');
  assert.equal(store.search('').length, 0);
});

test('addEntry dedups identical text by bumping created_at instead of inserting a duplicate', () => {
  store.addEntry('same text');
  const first = store.search('')[0];
  waitForNextMs();
  store.addEntry('other text');
  waitForNextMs();
  store.addEntry('same text');

  const results = store.search('');
  const matching = results.filter((r) => r.text === 'same text');
  assert.equal(matching.length, 1, 'should not create a duplicate row');
  assert.ok(matching[0].created_at >= first.created_at, 'created_at should be bumped');
  assert.equal(results[0].text, 'same text', 'bumped entry should sort to the top');
});

test('addEntry prunes to the 500 most recent unpinned entries', () => {
  for (let i = 0; i < 505; i++) {
    waitForNextMs();
    store.addEntry(`entry-${i}`);
  }
  const all = store.search('');
  // search() itself caps at the display limit, so check the underlying count via getById
  // across the full known id range instead of relying on search()'s LIMIT.
  let remaining = 0;
  for (let id = 1; id <= 505; id++) {
    if (store.getById(id)) remaining++;
  }
  assert.equal(remaining, 500);
  assert.equal(store.getById(1), undefined, 'oldest entry should have been pruned');
  assert.ok(store.getById(505), 'newest entry should survive');
  assert.equal(all.length, 25, 'search() caps results at the default display limit');
});

test('search with empty query returns entries ordered by created_at desc', () => {
  store.addEntry('first');
  waitForNextMs();
  store.addEntry('second');
  waitForNextMs();
  store.addEntry('third');
  const results = store.search('');
  assert.deepEqual(
    results.map((r) => r.text),
    ['third', 'second', 'first'],
  );
});

test('search with a query filters by substring match', () => {
  store.addEntry('apple pie');
  store.addEntry('banana bread');
  store.addEntry('apple juice');
  const results = store.search('apple');
  assert.deepEqual(
    results.map((r) => r.text).sort(),
    ['apple juice', 'apple pie'],
  );
});

test('touch bumps an entry back to the top', () => {
  store.addEntry('old');
  const oldEntry = store.search('')[0];
  waitForNextMs();
  store.addEntry('new');
  waitForNextMs();
  store.touch(oldEntry.id);
  const results = store.search('');
  assert.equal(results[0].text, 'old');
});

test('getById returns the matching entry or undefined', () => {
  store.addEntry('findme');
  const entry = store.search('')[0];
  assert.deepEqual(store.getById(entry.id), entry);
  assert.equal(store.getById(999999), undefined);
});

test('wipeData removes the db file and its WAL/SHM sidecar files from disk', () => {
  const dbFile = path.join(tmpDir, `wipe-${Date.now()}-${Math.random()}.db`);
  store.init(dbFile);
  store.addEntry('to be wiped');
  assert.ok(fs.existsSync(dbFile));

  store.wipeData();

  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    assert.equal(fs.existsSync(dbFile + suffix), false, `${dbFile}${suffix} should be gone`);
  }
});

test('display limit defaults to 25', () => {
  assert.equal(store.getDisplayLimit(), 25);
});

test('setDisplayLimit caps search results without deleting hidden entries', () => {
  for (let i = 0; i < 20; i++) {
    waitForNextMs();
    store.addEntry(`entry-${i}`);
  }
  store.setDisplayLimit(5);
  assert.equal(store.getDisplayLimit(), 5);

  const shown = store.search('');
  assert.equal(shown.length, 5);
  assert.equal(shown[0].text, 'entry-19', 'newest entries are the ones shown');
  assert.equal(store.search('entry').length, 5, 'limit applies to filtered search too');

  for (let id = 1; id <= 20; id++) {
    assert.ok(store.getById(id), `entry ${id} should still be stored`);
  }

  store.setDisplayLimit(50);
  assert.equal(store.search('').length, 20, 'raising the limit brings hidden entries back');
});

test('setDisplayLimit ignores values outside the allowed options', () => {
  store.setDisplayLimit(10);
  store.setDisplayLimit(7);
  assert.equal(store.getDisplayLimit(), 10);
});

test('display limit persists across reopening the database', () => {
  const file = path.join(tmpDir, `persist-${Date.now()}.db`);
  store.close();
  store.init(file);
  store.setDisplayLimit(50);
  store.close();
  store.init(file);
  assert.equal(store.getDisplayLimit(), 50);
});

test('clearHistory deletes entries but keeps the display limit setting', () => {
  store.addEntry('secret');
  store.setDisplayLimit(100);
  store.clearHistory();
  assert.equal(store.search('').length, 0);
  assert.equal(store.getDisplayLimit(), 100);
});
