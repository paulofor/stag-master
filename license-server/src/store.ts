import pg, { type PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { sha256 } from "./security.js";

export class Store {
  pool: pg.Pool;
  constructor(config: pg.PoolConfig) {
    this.pool = new pg.Pool(config);
    this.pool.on("error", () => {});
  }
  async transaction<T>(run: (db: PoolClient) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      const result = await run(db);
      await db.query("COMMIT");
      return result;
    } catch (error) {
      await db.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      db.release();
    }
  }
  async migrate(username: string, passwordHash: string): Promise<void> {
    await this.transaction(async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(78926401)");
      await db.query(`
        CREATE TABLE IF NOT EXISTS schema_version (version integer PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS admins (id uuid PRIMARY KEY, username text UNIQUE NOT NULL, password_hash text NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions (token_hash text PRIMARY KEY, admin_id uuid NOT NULL REFERENCES admins(id), csrf text NOT NULL, expires_at timestamptz NOT NULL);
        CREATE TABLE IF NOT EXISTS licenses (id uuid PRIMARY KEY, label text NOT NULL, key_hash text UNIQUE NOT NULL, key_hint text NOT NULL,
          expires_at timestamptz NOT NULL, max_devices integer NOT NULL CHECK(max_devices BETWEEN 1 AND 100), revoked boolean NOT NULL DEFAULT false,
          created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
        CREATE TABLE IF NOT EXISTS activations (id uuid PRIMARY KEY, license_id uuid NOT NULL REFERENCES licenses(id), device_hash text NOT NULL,
          device_name text NOT NULL, token_hash text UNIQUE NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(),
          disabled boolean NOT NULL DEFAULT false, UNIQUE(license_id,device_hash));
        CREATE TABLE IF NOT EXISTS nonces (nonce_hash text PRIMARY KEY, expires_at timestamptz NOT NULL);
        CREATE TABLE IF NOT EXISTS audit (id bigserial PRIMARY KEY, action text NOT NULL, license_id uuid, activation_id uuid, created_at timestamptz NOT NULL DEFAULT now());
        CREATE INDEX IF NOT EXISTS activations_license ON activations(license_id);
        CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
        CREATE INDEX IF NOT EXISTS nonces_expiry ON nonces(expires_at);
        INSERT INTO schema_version(version) VALUES(1) ON CONFLICT DO NOTHING;
      `);
      const version = await db.query("SELECT max(version) AS version FROM schema_version");
      if (version.rows[0].version !== 1) throw new Error("Versão de banco não suportada.");
      await db.query(
        "INSERT INTO admins(id,username,password_hash) VALUES($1,$2,$3) ON CONFLICT(username) DO NOTHING",
        [randomUUID(), username, passwordHash],
      );
    });
  }
  async cleanup(): Promise<void> {
    await this.pool.query("DELETE FROM sessions WHERE expires_at < now()");
    await this.pool.query("DELETE FROM nonces WHERE expires_at < now()");
    await this.pool.query("DELETE FROM audit WHERE created_at < now() - interval '90 days'");
  }
}
export async function audit(
  db: PoolClient,
  action: string,
  licenseId: string | null = null,
  activationId: string | null = null,
): Promise<void> {
  await db.query("INSERT INTO audit(action,license_id,activation_id) VALUES($1,$2,$3)", [
    action,
    licenseId,
    activationId,
  ]);
}
export async function consumeNonce(
  db: PoolClient,
  nonce: string,
  deviceHash: string,
): Promise<boolean> {
  const r = await db.query(
    "INSERT INTO nonces(nonce_hash,expires_at) VALUES($1,now()+interval '10 minutes') ON CONFLICT DO NOTHING RETURNING nonce_hash",
    [sha256(`${deviceHash}:${nonce}`)],
  );
  return r.rowCount === 1;
}
