// Database access. Everything else talks to a tiny interface:
//   db.q(text, params) → rows       db.tx(async (t) => …) → runs in one transaction
// In production it wraps the `postgres` driver against Supabase (through Hyperdrive when
// it's bound). The local dev server passes its own implementation as env.__db.
import postgres from 'postgres';

// One query at a time per connection. Supabase's transaction pooler drops the connection
// when several queries are pipelined onto it, so callers may still use Promise.all but the
// queries go out one after another.
const serial = (run) => {
  let last = Promise.resolve();
  return (text, params = []) => {
    const p = last.then(() => run(text, params));
    last = p.catch(() => {});
    return p;
  };
};
const wrap = (sql) => ({
  q: serial((text, params) => sql.unsafe(text, params)),
  tx: (fn) => sql.begin((t) => fn({ q: serial((text, params) => t.unsafe(text, params)) })),
  end: () => sql.end({ timeout: 5 }),
});

// Workers can't share a socket between requests, so each request opens its own
// connection (cheap through Hyperdrive) and closes it once the response is sent.
export function openDb(env, ctx) {
  if (env.__db) return env.__db;
  const url = env.HYPERDRIVE ? env.HYPERDRIVE.connectionString : env.DATABASE_URL;
  if (!url) throw Object.assign(new Error('The database isn’t configured. Set DATABASE_URL or bind HYPERDRIVE.'), { status: 500, expose: true });
  // prepare:false is required for Supabase's transaction pooler and Hyperdrive.
  const sql = postgres(url, { prepare: false, max: 1, fetch_types: false, idle_timeout: 5, connect_timeout: 10 });
  const db = wrap(sql);
  if (ctx && ctx.waitUntil) db.close = () => ctx.waitUntil(db.end());
  return db;
}
