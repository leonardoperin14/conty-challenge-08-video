import { DatabaseSync } from "node:sqlite";

const schema = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS campaign_required_pieces (
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  piece_type TEXT NOT NULL CHECK (piece_type IN ('SCRIPT', 'VIDEO', 'COVER', 'CAPTION')),
  PRIMARY KEY (campaign_id, piece_type)
) STRICT;

CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  creator_id TEXT NOT NULL CHECK (length(trim(creator_id)) > 0),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS deliveries_campaign_idx ON deliveries(campaign_id);

CREATE TABLE IF NOT EXISTS piece_versions (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL REFERENCES deliveries(id),
  piece_type TEXT NOT NULL CHECK (piece_type IN ('SCRIPT', 'VIDEO', 'COVER', 'CAPTION')),
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('URL', 'FAKE_FILE')),
  content_ref TEXT NOT NULL CHECK (length(trim(content_ref)) > 0),
  created_at TEXT NOT NULL,
  approved_at TEXT,
  UNIQUE (delivery_id, piece_type, version_number),
  UNIQUE (delivery_id, piece_type, id)
) STRICT;

CREATE INDEX IF NOT EXISTS piece_versions_current_idx
  ON piece_versions(delivery_id, piece_type, version_number DESC);

CREATE TRIGGER IF NOT EXISTS piece_version_content_immutable
BEFORE UPDATE OF delivery_id, piece_type, version_number, source_kind, content_ref, created_at
ON piece_versions
BEGIN
  SELECT RAISE(ABORT, 'piece_version_content_immutable');
END;

CREATE TRIGGER IF NOT EXISTS piece_version_history_immutable
BEFORE DELETE ON piece_versions
BEGIN
  SELECT RAISE(ABORT, 'piece_version_history_immutable');
END;

CREATE TABLE IF NOT EXISTS video_comments (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES piece_versions(id),
  second REAL NOT NULL CHECK (second >= 0),
  text TEXT NOT NULL CHECK (length(trim(text)) > 0),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS video_comments_version_idx
  ON video_comments(version_id, second, created_at, id);

CREATE TABLE IF NOT EXISTS delivery_approvals (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL REFERENCES deliveries(id),
  created_at TEXT NOT NULL,
  invalidated_at TEXT
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS one_active_delivery_approval
  ON delivery_approvals(delivery_id) WHERE invalidated_at IS NULL;

CREATE TABLE IF NOT EXISTS delivery_approval_versions (
  approval_id TEXT NOT NULL REFERENCES delivery_approvals(id),
  delivery_id TEXT NOT NULL,
  piece_type TEXT NOT NULL CHECK (piece_type IN ('SCRIPT', 'VIDEO', 'COVER', 'CAPTION')),
  version_id TEXT NOT NULL,
  PRIMARY KEY (approval_id, piece_type),
  FOREIGN KEY (delivery_id, piece_type, version_id)
    REFERENCES piece_versions(delivery_id, piece_type, id)
) STRICT;
`;

export function initializeDatabase(path = ":memory:"): DatabaseSync {
  const db = new DatabaseSync(path, { timeout: 5_000 });
  db.exec(schema);
  return db;
}

export function inTransaction<T>(
  db: DatabaseSync,
  action: () => T,
  mode: "IMMEDIATE" | "DEFERRED" = "IMMEDIATE",
): T {
  db.exec(`BEGIN ${mode}`);
  try {
    const result = action();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}
