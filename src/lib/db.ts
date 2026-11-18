import type { PGlite } from "@electric-sql/pglite";
import type { Pool } from "pg";

/*
 * Base de datos Postgres.
 * - Producción (Vercel): Neon u otro Postgres vía DATABASE_URL (o POSTGRES_URL).
 * - Local sin DATABASE_URL: PGlite (Postgres embebido) guardado en data/pglite.
 * - Vercel sin DATABASE_URL: PGlite en /tmp — solo demo, los datos se pierden.
 */
const connectionString = (process.env.DATABASE_URL || process.env.POSTGRES_URL || "").trim();
const usePostgres = /^postgres(ql)?:\/\//.test(connectionString);

/** true cuando los datos no sobreviven a reinicios del servidor (Vercel sin Postgres). */
export const isEphemeralDb = !usePostgres && Boolean(process.env.VERCEL);
export const dbKind = usePostgres ? "postgres" : isEphemeralDb ? "pglite-temporal" : "pglite";

export type Params = unknown[];
export type Query = <T = Record<string, unknown>>(sql: string, params?: Params) => Promise<T[]>;

// COUNT/SUM devuelven bigint/numeric: los convertimos a number (montos en centavos caben de sobra).
const INT8 = 20;
const NUMERIC = 1700;

/** Permite escribir los parámetros como "?" y los convierte a $1, $2… */
function toPg(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

type Backend = {
  query: Query;
  transaction<T>(fn: (q: Query) => Promise<T>): Promise<T>;
};

const g = globalThis as unknown as { __cafeDb?: Promise<Backend> };

async function createPostgres(): Promise<Backend> {
  const pg = await import("pg");
  pg.types.setTypeParser(INT8, (v) => Number(v));
  pg.types.setTypeParser(NUMERIC, (v) => Number(v));
  const pool: Pool = new pg.Pool({
    connectionString,
    max: 5,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    // Neon incluye channel_binding=require en su cadena de conexión
    enableChannelBinding: /channel_binding=require/.test(connectionString),
  });
  // Un error en una conexión inactiva no debe tumbar el servidor
  pool.on("error", (e) => console.error("Postgres pool error", e));
  return {
    query: async (sql, params = []) => (await pool.query(toPg(sql), params)).rows,
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(async (sql, params = []) => (await client.query(toPg(sql), params)).rows);
        await client.query("COMMIT");
        return result;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
  };
}

async function createPglite(): Promise<Backend> {
  const { PGlite } = await import("@electric-sql/pglite");
  const dataDir = process.env.VERCEL ? "/tmp/pglite" : process.env.PGLITE_DIR || "data/pglite";
  const fs = await import("node:fs");
  fs.mkdirSync(dataDir, { recursive: true });
  const parsers = { [INT8]: (v: string) => Number(v), [NUMERIC]: (v: string) => Number(v) };
  const pgl: PGlite = await PGlite.create({ dataDir, parsers });
  return {
    query: async (sql, params = []) => (await pgl.query(toPg(sql), params)).rows as never,
    transaction: (fn) =>
      pgl.transaction((tx) => fn(async (sql, params = []) => (await tx.query(toPg(sql), params)).rows as never)),
  };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'General',
  price INTEGER NOT NULL,
  cost INTEGER NOT NULL DEFAULT 0,
  track_stock INTEGER NOT NULL DEFAULT 0,
  stock INTEGER NOT NULL DEFAULT 0,
  min_stock INTEGER NOT NULL DEFAULT 0,
  image_url TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
ALTER TABLE products ADD COLUMN IF NOT EXISTS size TEXT NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS available_days TEXT NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS icon TEXT NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS pos_only INTEGER NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS barcode TEXT NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS supplies (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'pza',
  qty DOUBLE PRECISION NOT NULL DEFAULT 0,
  min_qty DOUBLE PRECISION NOT NULL DEFAULT 0,
  cost_per_unit INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
ALTER TABLE supplies ADD COLUMN IF NOT EXISTS barcode TEXT NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS inventory_movements (
  id SERIAL PRIMARY KEY,
  item_type TEXT NOT NULL,
  item_id INTEGER NOT NULL,
  change DOUBLE PRECISION NOT NULL,
  reason TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  order_id INTEGER,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  channel TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'nuevo',
  customer_name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  delivery_type TEXT NOT NULL DEFAULT 'mostrador',
  address TEXT NOT NULL DEFAULT '',
  address_ref TEXT NOT NULL DEFAULT '',
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  notes TEXT NOT NULL DEFAULT '',
  payment_method TEXT NOT NULL,
  payment_status TEXT NOT NULL DEFAULT 'pendiente',
  cash_given INTEGER,
  subtotal INTEGER NOT NULL,
  delivery_fee INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL,
  stripe_session_id TEXT,
  created_at TEXT NOT NULL,
  paid_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS postal_code TEXT NOT NULL DEFAULT '';
CREATE SEQUENCE IF NOT EXISTS orders_change_seq;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancel_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS service_fee INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS processing_fee INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS confirmed_seq BIGINT NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancelled_at TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS change_seq BIGINT NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_orders_change ON orders(change_seq);
CREATE TABLE IF NOT EXISTS maps_cache (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL
);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_km DOUBLE PRECISION;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS dest_lat DOUBLE PRECISION;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS dest_lng DOUBLE PRECISION;
CREATE TABLE IF NOT EXISTS delivery_zones (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  postal_codes TEXT NOT NULL DEFAULT '',
  fee INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS order_items (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  product_id INTEGER,
  name TEXT NOT NULL,
  unit_price INTEGER NOT NULL,
  unit_cost INTEGER NOT NULL DEFAULT 0,
  qty INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS expenses (
  id SERIAL PRIMARY KEY,
  date TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pagado',
  recurring TEXT NOT NULL DEFAULT 'none',
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  paid_at TEXT
);
CREATE TABLE IF NOT EXISTS loyalty_stamps (
  id SERIAL PRIMARY KEY,
  phone TEXT NOT NULL,
  order_id INTEGER NOT NULL UNIQUE,
  stamp_date TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  reward_id INTEGER,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  UNIQUE (phone, stamp_date)
);
CREATE INDEX IF NOT EXISTS idx_stamps_phone ON loyalty_stamps(phone);
CREATE TABLE IF NOT EXISTS loyalty_rewards (
  id SERIAL PRIMARY KEY,
  phone TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'disponible',
  earned_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  redeemed_order_id INTEGER,
  redeemed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_rewards_phone ON loyalty_rewards(phone);
CREATE TABLE IF NOT EXISTS loyalty_codes (
  phone TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS drivers (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  pin_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  session_version INTEGER NOT NULL DEFAULT 1,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS driver_id INTEGER;
CREATE TABLE IF NOT EXISTS staff (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'vendedor',
  pin_hash TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  session_version INTEGER NOT NULL DEFAULT 1,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  created_at TEXT NOT NULL DEFAULT ''
);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS seller TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS scheduled_for TEXT;
CREATE TABLE IF NOT EXISTS cash_sessions (
  id SERIAL PRIMARY KEY,
  opened_at TEXT NOT NULL,
  opening_cash INTEGER NOT NULL DEFAULT 0,
  open_note TEXT NOT NULL DEFAULT '',
  closed_at TEXT,
  counted_cash INTEGER,
  expected_cash INTEGER,
  close_note TEXT NOT NULL DEFAULT '',
  summary TEXT
);
CREATE TABLE IF NOT EXISTS cash_movements (
  id SERIAL PRIMARY KEY,
  session_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  amount INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE TABLE IF NOT EXISTS category_images (
  category TEXT PRIMARY KEY,
  image_url TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// Menú inicial (precios en pesos). Se puede editar desde Admin > Menú.
// Cada tamaño es un producto; la tienda los agrupa por nombre.
type SeedItem = {
  name: string;
  category: string;
  icon: string;
  description?: string;
  sizes: [string, number][];
  days?: string;
  inactive?: boolean;
  /** Nombres anteriores, para conservar costos/existencias al renombrar */
  was?: string[];
};
const FLAVOR = "Elige tu sabor favorito.";
const OLD_FLAVOR = "Indica el sabor en las notas del pedido.";
// Masgreen empieza con el menú vacío: los productos se cargan desde Admin > Menú.
const MENU: SeedItem[] = [];
const MENU_VERSION = "masgreen-1";

type Q = Query;

/**
 * Sincroniza el menú sin perder historial: actualiza precio/categoría/ícono de los productos
 * existentes (conserva costo, existencias y foto), agrega los nuevos y oculta los que ya no están.
 */
async function syncMenu(q: Q) {
  const existing = await q<{ id: number; name: string; size: string }>("SELECT id, name, size FROM products");
  const norm = (x: string) => x.trim().toLowerCase();
  const byKey = new Map(existing.map((p) => [`${norm(p.name)}|${norm(p.size)}`, p.id]));
  const keep: number[] = [];
  let sort = 0;
  for (const item of MENU) {
    for (const [size, pesos] of item.sizes) {
      // Si el producto se vendía con otro tamaño (p.ej. Espresso "CH 8oz" → sin tamaño), también lo reconoce
      const candidates = [item.name, ...(item.was ?? [])].flatMap((n) => [
        `${norm(n)}|${norm(size)}`,
        ...(item.sizes.length === 1 ? existing.filter((e) => norm(e.name) === norm(n)).map((e) => `${norm(e.name)}|${norm(e.size)}`) : []),
      ]);
      const id = candidates.map((k) => byKey.get(k)).find((v) => v !== undefined && !keep.includes(v));
      const values = [item.name, size, item.category, item.description ?? "", pesos * 100, item.days ?? "", item.icon, item.inactive ? 0 : 1, sort++];
      if (id !== undefined) {
        await q(
          `UPDATE products SET name=?, size=?, category=?, description=?, price=?, available_days=?, icon=?, active=?, sort=? WHERE id=?`,
          [...values, id],
        );
        keep.push(id);
      } else {
        const [row] = await q<{ id: number }>(
          `INSERT INTO products (name, size, category, description, price, available_days, icon, active, sort, cost)
           VALUES (?,?,?,?,?,?,?,?,?,0) RETURNING id`,
          values,
        );
        keep.push(row.id);
      }
    }
  }
  if (keep.length) {
    await q(`UPDATE products SET active = 0 WHERE id NOT IN (${keep.map(() => "?").join(",")})`, keep);
  }
}

/** Productos del menú de prueba inicial (antes de cargar el menú real). */
const DEMO_PRODUCTS = [
  "Espresso", "Americano", "Capuchino", "Latte", "Mocha", "Frappé de café", "Cold brew", "Chai latte",
  "Chocolate caliente", "Croissant", "Concha", "Galleta de chispas", "Sándwich de pavo", "Chilaquiles",
];

const DEFAULT_SETTINGS: Record<string, string> = {
  business_name: "Masgreen",
  whatsapp_number: "",
  delivery_enabled: "0",
  delivery_fee: "3000",
  min_delivery_order: "10000",
  free_delivery_from: "0",
  online_fee_enabled: "0",
  online_fee_percent: "3.6",
  online_fee_fixed: "300",
  online_fee_iva: "16",
  delivery_base_km: "3",
  delivery_per_km: "500",
  delivery_max_km: "8",
  loyalty_enabled: "1",
  loyalty_stamps_needed: "10",
  loyalty_min_purchase: "5000",
  loyalty_stamp_months: "6",
  loyalty_reward_days: "30",
  store_open: "1",
  address: "",
  hours: "Lun a Sáb 8:00 – 20:00",
};

async function init(b: Backend) {
  await b.transaction(async (q) => {
    // Evita que dos instancias creen las tablas al mismo tiempo
    await q("SELECT pg_advisory_xact_lock(7212026)");
    for (const stmt of SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) await q(stmt);
    // Actualiza el menú cuando cambia su versión (una sola vez)
    const [ver] = await q<{ value: string }>("SELECT value FROM settings WHERE key = 'menu_version'");
    if (ver?.value !== MENU_VERSION) {
      await syncMenu(q);
      await q(
        "INSERT INTO settings (key, value) VALUES ('menu_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        [MENU_VERSION],
      );
    }
    // Una sola vez: usuarios iniciales (sin PIN; el administrador les pone uno en Usuarios)
    const [staffMig] = await q<{ value: string }>("SELECT value FROM settings WHERE key = 'staff_seed_v1'");
    if (!staffMig) {
      for (const [name, role] of [
        ["Maricela Ramírez", "admin"],
        ["Karla", "vendedor"],
        ["Chris", "vendedor"],
        ["Esaú", "vendedor"],
      ])
        await q("INSERT INTO staff (name, role, created_at) VALUES (?, ?, ?)", [name, role, new Date().toISOString()]);
      await q("INSERT INTO settings (key, value) VALUES ('staff_seed_v1', '1') ON CONFLICT (key) DO NOTHING");
    }
    // Una sola vez: productos que quedaron "solo domingo" por un error al editar (el café cierra en domingo)
    const [daysMig] = await q<{ value: string }>("SELECT value FROM settings WHERE key = 'days_fix_v1'");
    if (!daysMig) {
      await q("UPDATE products SET available_days = '' WHERE available_days = '0'");
      await q("INSERT INTO settings (key, value) VALUES ('days_fix_v1', '1') ON CONFLICT (key) DO NOTHING");
    }
    // Una sola vez: los descuentos son solo para la caja (no se ven en la tienda en línea)
    const [posOnlyMig] = await q<{ value: string }>("SELECT value FROM settings WHERE key = 'pos_only_v1'");
    if (!posOnlyMig) {
      await q("UPDATE products SET pos_only = 1 WHERE name ILIKE 'descuento%'");
      await q("INSERT INTO settings (key, value) VALUES ('pos_only_v1', '1') ON CONFLICT (key) DO NOTHING");
    }
    // Una sola vez: quitar los productos de prueba del primer menú que quedaron ocultos.
    // Sin ventas se borran (con sus movimientos); con ventas quedan ocultos y fuera del inventario.
    const [demoMig] = await q<{ value: string }>("SELECT value FROM settings WHERE key = 'demo_cleanup_v1'");
    if (!demoMig) {
      const demo = await q<{ id: number; sold: number }>(
        `SELECT p.id, (SELECT COUNT(*) FROM order_items oi WHERE oi.product_id = p.id) AS sold
         FROM products p WHERE p.active = 0 AND p.name IN (${DEMO_PRODUCTS.map(() => "?").join(",")})`,
        DEMO_PRODUCTS,
      );
      for (const d of demo) {
        if (Number(d.sold) > 0) {
          await q("UPDATE products SET track_stock = 0 WHERE id = ?", [d.id]);
        } else {
          await q("DELETE FROM inventory_movements WHERE item_type = 'product' AND item_id = ?", [d.id]);
          await q("DELETE FROM products WHERE id = ?", [d.id]);
        }
      }
      await q("INSERT INTO settings (key, value) VALUES ('demo_cleanup_v1', '1') ON CONFLICT (key) DO NOTHING");
    }
    await q("UPDATE products SET description = ? WHERE description = ?", [FLAVOR, OLD_FLAVOR]);
    // Pedidos anteriores ya confirmados: marca de "visible en el panel" para comandas automáticas
    await q("UPDATE orders SET confirmed_seq = change_seq WHERE confirmed_seq = 0 AND status <> 'pago_pendiente'");
    // Una sola vez: activar precios en línea con comisión y migrar el dato de finanzas
    const [feeMig] = await q<{ value: string }>("SELECT value FROM settings WHERE key = 'online_fee_v2'");
    if (!feeMig) {
      await q(
        "INSERT INTO settings (key, value) VALUES ('online_fee_enabled', '0') ON CONFLICT (key) DO UPDATE SET value = '0'",
      );
      await q("UPDATE orders SET processing_fee = service_fee WHERE processing_fee = 0 AND service_fee > 0");
      await q("INSERT INTO settings (key, value) VALUES ('online_fee_v2', '1') ON CONFLICT (key) DO NOTHING");
    }
    // Una sola vez: pedidos de pago al recibir que ya se entregaron cuentan como pagados
    const [paidMig] = await q<{ value: string }>("SELECT value FROM settings WHERE key = 'paid_on_delivery_v1'");
    if (!paidMig) {
      await q(
        `UPDATE orders SET payment_status = 'pagado', paid_at = COALESCE(paid_at, created_at)
         WHERE status = 'entregado' AND payment_status <> 'pagado' AND payment_method <> 'stripe'`,
      );
      await q("INSERT INTO settings (key, value) VALUES ('paid_on_delivery_v1', '1') ON CONFLICT (key) DO NOTHING");
    }
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
      await q("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING", [k, v]);
    }
  });
}

async function backend(): Promise<Backend> {
  if (!g.__cafeDb) {
    g.__cafeDb = (async () => {
      const b = usePostgres ? await createPostgres() : await createPglite();
      await init(b);
      return b;
    })().catch((e) => {
      g.__cafeDb = undefined;
      throw e;
    });
  }
  return g.__cafeDb;
}

export async function all<T = Record<string, unknown>>(sql: string, params: Params = []): Promise<T[]> {
  return (await backend()).query<T>(sql, params);
}

export async function get<T = Record<string, unknown>>(sql: string, params: Params = []): Promise<T | undefined> {
  return (await all<T>(sql, params))[0];
}

export async function run(sql: string, params: Params = []): Promise<void> {
  await all(sql, params);
}

/** Ejecuta varias consultas de forma atómica. */
export async function transaction<T>(fn: (q: Query) => Promise<T>): Promise<T> {
  return (await backend()).transaction(fn);
}
