-- Every committed root pointer, so an earlier tree can be restored.
-- Blobs are content-addressed and never deleted, so a recorded hash stays valid.
-- Restore: UPDATE roots SET hash = '<old hash>', generation = generation + 1 WHERE uid = '<uid>';
CREATE TABLE IF NOT EXISTS root_history (
  uid        TEXT NOT NULL,
  generation INTEGER NOT NULL,
  hash       TEXT NOT NULL,
  source     TEXT NOT NULL,          -- "device:<id>" or "drive:<identity>"
  created    INTEGER NOT NULL,
  PRIMARY KEY (uid, generation)
);

-- Seed with the current roots so the first change can be undone.
INSERT OR IGNORE INTO root_history (uid, generation, hash, source, created)
  SELECT uid, generation, hash, 'migration', updated FROM roots;
