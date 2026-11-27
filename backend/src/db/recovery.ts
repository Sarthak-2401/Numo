import pool from '../config/database';

// Existing Docker volumes and fresh installations both pass through this migration.
let ready: Promise<void> | undefined;

async function migrate() {
  const client = await pool.connect();
  try {
    const applied = await client.query("SELECT to_regclass('numo_recovery_contacts') AS relation");
    if (applied.rows[0].relation) return;
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(572034021)');
    await client.query(`
      CREATE TABLE IF NOT EXISTS numo_recovery_contacts (
        user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        email text NOT NULL,
        link_hash text UNIQUE,
        link_expires_at timestamptz
      );
      CREATE OR REPLACE FUNCTION numo_keep_recovery_contact() RETURNS trigger AS $$
      BEGIN
        IF NEW.email IS DISTINCT FROM OLD.email OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
          RAISE EXCEPTION 'A verified recovery address is permanent';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE OR REPLACE TRIGGER numo_keep_recovery_contact
        BEFORE UPDATE OF email, user_id ON numo_recovery_contacts
        FOR EACH ROW EXECUTE FUNCTION numo_keep_recovery_contact();
      CREATE TABLE IF NOT EXISTS numo_enrollments (
        phone text PRIMARY KEY, proof_hash text UNIQUE NOT NULL, expires_at timestamptz NOT NULL,
        existing_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
        method text NOT NULL, password_hash text,
        email text, code_hash text, code_expires_at timestamptz, attempts integer NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS numo_auth_limits (
        key text PRIMARY KEY, count integer NOT NULL, expires_at timestamptz NOT NULL
      );
      CREATE TABLE IF NOT EXISTS numo_revoked_sessions (
        hash text PRIMARY KEY, expires_at timestamptz NOT NULL
      );
      CREATE INDEX IF NOT EXISTS numo_limits_expiry ON numo_auth_limits(expires_at);
      CREATE INDEX IF NOT EXISTS numo_enrollments_expiry ON numo_enrollments(expires_at);
      CREATE INDEX IF NOT EXISTS numo_revoked_expiry ON numo_revoked_sessions(expires_at);
    `);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export function ensureRecoverySchema() {
  return ready ??= migrate().catch(err => { ready = undefined; throw err; });
}
