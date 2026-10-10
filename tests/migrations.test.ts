import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../src/server/migrations';

function version(db: DatabaseSync) { return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version; }
test('fresh and legacy databases migrate in order without losing data; version 2 is unchanged', () => {
  for (const legacyVersion of [0, 1]) {
    const db = new DatabaseSync(':memory:');
    try {
      migrate(db);
      assert.equal(version(db), 2);
      db.prepare('INSERT INTO settings VALUES (?,?)').run('password', 'preserved');
      db.prepare(`INSERT INTO tracks(id,hash,title,artist,album,duration,original,bytes,created_at,lyrics) VALUES (?,?,?,?,?,?,?,?,?,?)`).run('song', 'hash', 'Title', 'Artist', '', 1, 'original.mp3', 1, 'now', '{"kind":"plain","plain":"Chosen","lines":[]}');
      db.exec(`DROP TABLE alignment_jobs; ALTER TABLE tracks DROP COLUMN model; ALTER TABLE tracks DROP COLUMN generation; PRAGMA user_version=${legacyVersion};`);
      migrate(db);
      assert.equal(version(db), 2);
      assert.equal((db.prepare('SELECT value FROM settings').get() as { value: string }).value, 'preserved');
      const song = db.prepare('SELECT lyrics,model,generation FROM tracks').get() as { lyrics: string; model: null; generation: null };
      assert.equal(JSON.parse(song.lyrics).plain, 'Chosen'); assert.equal(song.model, null); assert.equal(song.generation, null);
      const schema = db.prepare('SELECT * FROM sqlite_master ORDER BY name').all();
      migrate(db);
      assert.deepEqual(db.prepare('SELECT * FROM sqlite_master ORDER BY name').all(), schema);
      assert.deepEqual(db.prepare('SELECT lyrics,model,generation FROM tracks').get(), song);
    } finally { db.close(); }
  }
});
test('migration failure rolls back schema and user_version; newer schemas are rejected', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE tracks (id TEXT);');
    assert.throws(() => migrate(db));
    assert.equal(version(db), 0);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='settings'").get(), undefined);
    db.exec('PRAGMA user_version=3;');
    assert.throws(() => migrate(db), /newer/);
    assert.equal(version(db), 3);
  } finally { db.close(); }
});
