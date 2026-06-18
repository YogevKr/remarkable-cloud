-- reMarkable cloud Worker — initial schema
-- Users: one per account. uid is the bare id (no "auth0|" prefix).
CREATE TABLE IF NOT EXISTS users (
  uid        TEXT PRIMARY KEY,
  email      TEXT UNIQUE NOT NULL,
  pass_hash  TEXT NOT NULL,           -- PBKDF2 "iterations:saltB64:hashB64"
  sync15     INTEGER NOT NULL DEFAULT 1,
  created    INTEGER NOT NULL
);

-- The single mutable sync root per user (content-addressed pointer + generation).
-- generation starts at 0 meaning "no root yet"; first successful write -> 1.
CREATE TABLE IF NOT EXISTS roots (
  uid        TEXT PRIMARY KEY,
  hash       TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  updated    INTEGER NOT NULL,
  FOREIGN KEY (uid) REFERENCES users(uid)
);

-- One-time device pairing codes (8 lowercase letters), short TTL.
CREATE TABLE IF NOT EXISTS pairing_codes (
  code     TEXT PRIMARY KEY,
  uid      TEXT NOT NULL,
  expires  INTEGER NOT NULL,
  FOREIGN KEY (uid) REFERENCES users(uid)
);
