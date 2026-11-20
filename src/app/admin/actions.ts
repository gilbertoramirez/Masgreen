"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  checkPassword,
  endSession,
  passwordConfigured,
  hashPin,
  requireAdmin,
  requireStaff,
  staffLogin,
  startSession,
  validPin,
} from "@/lib/auth";
import { get, run, transaction } from "@/lib/db";
import { addDays, addMonths, localDate, toCents } from "@/lib/format";
import {
  createOrder,
  deleteCancelledOrder,
  markOrderPaid,
  OrderError,
  setOrderStatus,
} from "@/lib/orders";
import { getSettings, setSetting } from "@/lib/settings";
import { sendNtfy } from "@/lib/notify";
import { addMovement, CashError, closeSession, openSession } from "@/lib/cash";
import { setCategoryPhoto, setProductPhoto } from "@/lib/images";
import { assignBarcode, findByBarcode, normalizeBarcode, type BarcodeMatch } from "@/lib/barcode";
import { normalizePhone, type LoyaltyStatus } from "@/lib/loyaltyRules";
import { loyaltyStatus } from "@/lib/loyalty";
import { ticketsByIds } from "@/lib/tickets-server";
import type { TicketData } from "@/lib/ticket";
import type { Expense, OrderStatus, PaymentMethod } from "@/lib/types";
import {
  EXPENSE_CATEGORIES,
  ORDER_STATUS_LABEL,
  productLabel,
} from "@/lib/types";

function done() {
  revalidatePath("/", "layout");
}

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const int = (f: FormData, k: string) => {
  const n = Math.round(Number(f.get(k) ?? 0));
  return Number.isFinite(n) ? n : 0;
};
const num = (f: FormData, k: string) => {
  const n = Number(f.get(k) ?? 0);
  return Number.isFinite(n) ? n : 0;
};

// ---------- Sesión ----------

export async function login(
  _prev: string | null,
  formData: FormData,
): Promise<string | null> {
  const staffId = int(formData, "staff_id");
  if (staffId) {
    const u = await staffLogin(staffId, str(formData, "pin"));
    if (typeof u === "string") return u;
    await startSession(u.id, u.session_version);
    redirect(u.role === "admin" ? "/admin" : "/admin/pos");
  }
  if (!passwordConfigured()) {
    return "Falta configurar ADMIN_PASSWORD en las variables de entorno de este despliegue (y volver a desplegar).";
  }
  if (!checkPassword(str(formData, "password"))) return "Contraseña incorrecta";
  await startSession();
  redirect("/admin");
}

export async function logout() {
  await endSession();
  redirect("/admin/login");
}

// ---------- Punto de venta ----------

export async function posSale(input: {
  items: { productId: number; qty: number }[];
  paymentMethod: PaymentMethod;
  cashGiven: number | null; // centavos
  customerName: string;
  /** teléfono del cliente para el programa de lealtad (opcional) */
  phone?: string;
  /** canjear la bebida gratis del teléfono (en caja la verifica quien atiende) */
  useReward?: boolean;
}): Promise<
  | {
      ok: true;
      orderId: number;
      total: number;
      change: number;
      ticket: TicketData | null;
    }
  | { ok: false; error: string }
> {
  const session = await requireStaff();
  const pm: PaymentMethod = ["efectivo", "tarjeta", "transferencia"].includes(
    input.paymentMethod,
  )
    ? input.paymentMethod
    : "efectivo";
  try {
    const order = await createOrder({
      channel: "mostrador",
      items: input.items,
      customerName: input.customerName,
      phone: normalizePhone(input.phone ?? ""),
      redeemRewardFor: input.useReward ? input.phone : undefined,
      deliveryType: "mostrador",
      paymentMethod: pm,
      paid: true,
      status: "entregado",
      cashGiven: pm === "efectivo" ? input.cashGiven : null,
      cashMustCover: true,
    });
    // Quién hizo la venta (para el corte y los pedidos)
    await run("UPDATE orders SET seller = ? WHERE id = ?", [session.name, order.id]);
    done();
    // El ticket va en la respuesta para imprimir y abrir el cajón de inmediato (sin otra consulta)
    const [ticket] = await ticketsByIds([order.id]);
    return {
      ok: true,
      orderId: order.id,
      total: order.total,
      change:
        pm === "efectivo" && input.cashGiven
          ? input.cashGiven - order.total
          : 0,
      ticket: ticket ?? null,
    };
  } catch (e) {
    if (e instanceof OrderError) return { ok: false, error: e.message };
    throw e;
  }
}

// ---------- Pedidos ----------

export async function updateOrderStatus(orderId: number, status: OrderStatus) {
  await requireStaff();
  if (!(status in ORDER_STATUS_LABEL)) return;
  await setOrderStatus(orderId, status);
  done();
}

/** Cancelar una venta o pedido (también los ya entregados, p. ej. ventas de caja). */
export async function cancelOrder(
  orderId: number,
  reason: string,
): Promise<{ ok: boolean; error?: string }> {
  await requireAdmin();
  if (!reason.trim())
    return { ok: false, error: "Escribe el motivo de la cancelación." };
  try {
    await setOrderStatus(orderId, "cancelado", reason);
    done();
    return { ok: true };
  } catch (e) {
    if (e instanceof OrderError) return { ok: false, error: e.message };
    throw e;
  }
}

/** Eliminar definitivamente (solo ventas ya canceladas). */
export async function deleteOrder(
  orderId: number,
): Promise<{ ok: boolean; error?: string }> {
  await requireAdmin();
  try {
    await deleteCancelledOrder(orderId);
    done();
    return { ok: true };
  } catch (e) {
    if (e instanceof OrderError) return { ok: false, error: e.message };
    throw e;
  }
}

export async function markPaid(orderId: number) {
  await requireStaff();
  await markOrderPaid(orderId);
  done();
}

// ---------- Productos (menú) ----------

export async function saveProduct(formData: FormData) {
  await requireAdmin();
  let id = int(formData, "id");
  const name = str(formData, "name");
  if (!name) return;
  const days = formData
    .getAll("days")
    .map(Number)
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  const values = [
    name,
    str(formData, "icon").slice(0, 8),
    str(formData, "size"),
    days.length === 7 ? "" : days.join(","),
    str(formData, "description"),
    str(formData, "category") || "General",
    toCents(formData.get("price")),
    toCents(formData.get("cost")),
    formData.get("track_stock") ? 1 : 0,
    int(formData, "min_stock"),
    "", // foto: se pone abajo, ya validada
    formData.get("active") ? 1 : 0,
    int(formData, "sort"),
    formData.get("pos_only") ? 1 : 0,
  ];
  // Link de la foto: completo (https://…), de nuestro almacenamiento privado (/api/foto?…) o vacío
  const rawImage = str(formData, "image_url");
  const imageUrl = /^https?:\/\/\S+$/i.test(rawImage) || rawImage.startsWith("/api/foto?u=") ? rawImage : "";
  values[10] = imageUrl;
  if (id) {
    const prev = await get<{ image_url: string }>("SELECT image_url FROM products WHERE id = ?", [id]);
    await run(
      `UPDATE products SET name=?, icon=?, size=?, available_days=?, description=?, category=?, price=?, cost=?, track_stock=?, min_stock=?, image_url=?, active=?, sort=?, pos_only=? WHERE id=?`,
      [...values, id],
    );
    // Foto nueva o quitada: se aplica a todos los tamaños y se borra la anterior si ya nadie la usa
    if (prev && prev.image_url !== imageUrl) await setProductPhoto(id, imageUrl);
  } else {
    // Un tamaño nuevo de un producto que ya tiene foto la hereda
    const sibling = imageUrl
      ? null
      : await get<{ image_url: string }>("SELECT image_url FROM products WHERE name = ? AND image_url <> '' LIMIT 1", [name]);
    if (sibling) values[10] = sibling.image_url;
    const row = await get<{ id: number }>(
      `INSERT INTO products (name, icon, size, available_days, description, category, price, cost, track_stock, min_stock, image_url, active, sort, pos_only, stock)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
      [...values, int(formData, "stock")],
    );
    if (row) id = row.id;
  }
  // El código de barras no obliga a controlar existencias (sirve también para cobrar en caja)
  if (id && formData.has("barcode")) {
    const code = normalizeBarcode(str(formData, "barcode"));
    if (code) {
      await run("UPDATE products SET barcode = '' WHERE barcode = ? AND id <> ?", [code, id]);
      await run("UPDATE supplies SET barcode = '' WHERE barcode = ?", [code]);
    }
    await run("UPDATE products SET barcode = ? WHERE id = ?", [code, id]);
  }
  done();
  redirect("/admin/productos");
}

export async function toggleProduct(id: number) {
  await requireAdmin();
  await run("UPDATE products SET active = 1 - active WHERE id = ?", [id]);
  done();
}

// ---------- Inventario ----------

/** Campo "item" con formato "product:3" o "supply:7". */
function parseItem(formData: FormData): {
  type: "product" | "supply";
  id: number;
} {
  const [t, i] = str(formData, "item").split(":");
  return {
    type: t === "supply" ? "supply" : "product",
    id: Math.round(Number(i)) || 0,
  };
}

async function addExpense(e: {
  date: string;
  category: string;
  description: string;
  amount: number;
  status: string;
}) {
  await run(
    "INSERT INTO expenses (date, category, description, amount, status, paid_at) VALUES (?,?,?,?,?,?)",
    [
      e.date,
      e.category,
      e.description,
      e.amount,
      e.status,
      e.status === "pagado" ? new Date().toISOString() : null,
    ],
  );
}

/** Entrada de mercancía. Opcionalmente registra el gasto y actualiza el costo unitario. */
export async function restock(formData: FormData) {
  const session = await requireAdmin();
  const { type, id } = parseItem(formData);
  const qty = num(formData, "qty");
  const totalCost = toCents(formData.get("total_cost"));
  if (!id || qty <= 0) return;

  const table = type === "product" ? "products" : "supplies";
  const item = await get<{ name: string; size?: string }>(
    `SELECT * FROM ${table} WHERE id = ?`,
    [id],
  );
  if (!item) return;

  await transaction(async (q) => {
    if (type === "product")
      await q("UPDATE products SET stock = stock + ? WHERE id = ?", [
        Math.round(qty),
        id,
      ]);
    else await q("UPDATE supplies SET qty = qty + ? WHERE id = ?", [qty, id]);
    await q(
      "INSERT INTO inventory_movements (item_type, item_id, change, reason, note) VALUES (?,?,?,?,?)",
      [
        type,
        id,
        type === "product" ? Math.round(qty) : qty,
        "resurtido",
        str(formData, "note"),
      ],
    );
    // Solo un administrador cambia el costo por unidad
    if (totalCost > 0 && formData.get("update_cost") && session.role === "admin") {
      const unit = Math.round(totalCost / qty);
      if (type === "product")
        await q("UPDATE products SET cost = ? WHERE id = ?", [unit, id]);
      else
        await q("UPDATE supplies SET cost_per_unit = ? WHERE id = ?", [
          unit,
          id,
        ]);
    }
  });

  if (totalCost > 0 && formData.get("register_expense")) {
    await addExpense({
      date: localDate(),
      category: "resurtido",
      description: `Resurtido: ${qty} × ${productLabel(item)}`,
      amount: totalCost,
      status: formData.get("expense_pending") ? "pendiente" : "pagado",
    });
  }
  done();
}

/** Ajuste manual (merma, conteo físico, consumo de insumos). */
export async function adjustStock(formData: FormData) {
  await requireAdmin();
  const { type, id } = parseItem(formData);
  const newQty = num(formData, "new_qty");
  if (!id || newQty < 0) return;
  const row =
    type === "product"
      ? await get<{ q: number }>(
          "SELECT stock AS q FROM products WHERE id = ?",
          [id],
        )
      : await get<{ q: number }>("SELECT qty AS q FROM supplies WHERE id = ?", [
          id,
        ]);
  if (!row) return;
  const target = type === "product" ? Math.round(newQty) : newQty;
  const change = target - Number(row.q);
  if (change === 0) return;
  await transaction(async (q) => {
    if (type === "product")
      await q("UPDATE products SET stock = ? WHERE id = ?", [target, id]);
    else await q("UPDATE supplies SET qty = ? WHERE id = ?", [target, id]);
    await q(
      "INSERT INTO inventory_movements (item_type, item_id, change, reason, note) VALUES (?,?,?,?,?)",
      [type, id, change, "ajuste", str(formData, "note")],
    );
  });
  done();
}

export async function saveSupply(formData: FormData) {
  await requireAdmin();
  const id = int(formData, "id");
  const name = str(formData, "name");
  if (!name) return;
  const unit = str(formData, "unit") || "pza";
  const minQty = num(formData, "min_qty");
  const cpu = toCents(formData.get("cost_per_unit"));
  if (id) {
    await transaction(async (q) => {
      await q(
        "UPDATE supplies SET name=?, unit=?, min_qty=?, cost_per_unit=? WHERE id=?",
        [name, unit, minQty, cpu, id],
      );
      // Si cambió la existencia, queda registrado como ajuste
      if (formData.has("qty")) await setQtyWithMovement(q, "supply", id, num(formData, "qty"));
    });
    if (formData.has("barcode")) await setBarcodeField("supply", id, str(formData, "barcode"));
  } else {
    await run(
      "INSERT INTO supplies (name, unit, qty, min_qty, cost_per_unit) VALUES (?,?,?,?,?)",
      [name, unit, num(formData, "qty"), minQty, cpu],
    );
  }
  done();
}

type Q = Parameters<Parameters<typeof transaction>[0]>[0];
async function setQtyWithMovement(q: Q, type: "product" | "supply", id: number, value: number) {
  if (!Number.isFinite(value) || value < 0) return;
  const target = type === "product" ? Math.round(value) : value;
  const [row] =
    type === "product"
      ? await q<{ v: number }>("SELECT stock AS v FROM products WHERE id = ? FOR UPDATE", [id])
      : await q<{ v: number }>("SELECT qty AS v FROM supplies WHERE id = ? FOR UPDATE", [id]);
  if (!row) return;
  const change = target - Number(row.v);
  if (Math.abs(change) < 1e-9) return;
  if (type === "product") await q("UPDATE products SET stock = ? WHERE id = ?", [target, id]);
  else await q("UPDATE supplies SET qty = ? WHERE id = ?", [target, id]);
  await q("INSERT INTO inventory_movements (item_type, item_id, change, reason, note) VALUES (?,?,?,?,?)", [
    type,
    id,
    change,
    "ajuste",
    "Editado en la lista de inventario",
  ]);
}

/** Guarda (o borra, si viene vacío) el código de barras de un producto o insumo. */
async function setBarcodeField(type: "product" | "supply", id: number, raw: string) {
  const code = normalizeBarcode(raw);
  if (code) await assignBarcode(`${type}:${id}`, code);
  else await run(`UPDATE ${type === "product" ? "products" : "supplies"} SET barcode = '' WHERE id = ?`, [id]);
}

/** Edición rápida de un producto desde Inventario: precio, costo, existencia y mínimo. */
export async function saveInventoryProduct(formData: FormData) {
  await requireAdmin();
  const id = int(formData, "id");
  if (!id) return;
  const price = toCents(formData.get("price"));
  const cost = toCents(formData.get("cost"));
  const minStock = Math.max(0, Math.round(num(formData, "min_stock")));
  await transaction(async (q) => {
    await q("UPDATE products SET price = ?, cost = ?, min_stock = ? WHERE id = ?", [Math.max(price, 0), Math.max(cost, 0), minStock, id]);
    if (formData.has("track_stock_field")) await q("UPDATE products SET track_stock = ? WHERE id = ?", [formData.get("track_stock") ? 1 : 0, id]);
    if (formData.has("stock")) await setQtyWithMovement(q, "product", id, num(formData, "stock"));
  });
  if (formData.has("barcode")) await setBarcodeField("product", id, str(formData, "barcode"));
  done();
}

export async function deleteSupply(id: number) {
  await requireAdmin();
  await run("DELETE FROM supplies WHERE id = ?", [id]);
  done();
}

// ---------- Gastos ----------

export async function saveExpense(formData: FormData) {
  await requireAdmin();
  const id = int(formData, "id");
  const amount = toCents(formData.get("amount"));
  const category = str(formData, "category");
  if (amount <= 0 || !(category in EXPENSE_CATEGORIES)) return;
  const date = str(formData, "date") || localDate();
  const status =
    str(formData, "status") === "pendiente" ? "pendiente" : "pagado";
  const r = str(formData, "recurring");
  const recurring: Expense["recurring"] =
    r === "monthly" || r === "weekly" ? r : "none";
  const description = str(formData, "description");
  if (id) {
    await run(
      "UPDATE expenses SET date=?, category=?, description=?, amount=?, status=?, recurring=? WHERE id=?",
      [date, category, description, amount, status, recurring, id],
    );
  } else {
    await run(
      "INSERT INTO expenses (date, category, description, amount, status, recurring, paid_at) VALUES (?,?,?,?,?,?,?)",
      [
        date,
        category,
        description,
        amount,
        status,
        recurring,
        status === "pagado" ? new Date().toISOString() : null,
      ],
    );
    if (status === "pagado" && recurring !== "none")
      await scheduleNext({ date, category, description, amount, recurring });
  }
  done();
}

/** Para gastos fijos (renta, luz…): al pagarlos se agenda el siguiente como pendiente. */
async function scheduleNext(
  e: Pick<
    Expense,
    "date" | "category" | "description" | "amount" | "recurring"
  >,
) {
  const next =
    e.recurring === "monthly" ? addMonths(e.date, 1) : addDays(e.date, 7);
  const exists = await get(
    "SELECT id FROM expenses WHERE category = ? AND description = ? AND date = ? AND recurring = ?",
    [e.category, e.description, next, e.recurring],
  );
  if (!exists) {
    await run(
      "INSERT INTO expenses (date, category, description, amount, status, recurring) VALUES (?,?,?,?, 'pendiente', ?)",
      [next, e.category, e.description, e.amount, e.recurring],
    );
  }
}

export async function payExpense(id: number) {
  await requireAdmin();
  const e = await get<Expense>("SELECT * FROM expenses WHERE id = ?", [id]);
  if (!e || e.status === "pagado") return;
  await run("UPDATE expenses SET status = 'pagado', paid_at = ? WHERE id = ?", [
    new Date().toISOString(),
    id,
  ]);
  if (e.recurring !== "none") await scheduleNext(e);
  done();
}

export async function deleteExpense(id: number) {
  await requireAdmin();
  await run("DELETE FROM expenses WHERE id = ?", [id]);
  done();
}

// ---------- Ajustes ----------

export async function saveSettings(formData: FormData) {
  await requireAdmin();
  await setSetting(
    "business_name",
    str(formData, "business_name") || "Masgreen",
  );
  await setSetting(
    "whatsapp_number",
    str(formData, "whatsapp_number").replace(/[^\d+]/g, ""),
  );
  await setSetting("address", str(formData, "address"));
  await setSetting("hours", str(formData, "hours"));
  done();
}

// ---------- Lealtad ----------

/** Sellos de un cliente (para la caja). */
export async function getLoyalty(phone: string): Promise<LoyaltyStatus | null> {
  await requireStaff();
  return loyaltyStatus(phone);
}

export async function saveLoyaltySettings(formData: FormData) {
  await requireAdmin();
  await setSetting("loyalty_enabled", formData.get("enabled") ? "1" : "0");
  await setSetting(
    "loyalty_stamps_needed",
    String(Math.min(Math.max(int(formData, "needed"), 1), 50)),
  );
  await setSetting(
    "loyalty_min_purchase",
    String(toCents(formData.get("min"))),
  );
  await setSetting(
    "loyalty_stamp_months",
    String(Math.min(Math.max(int(formData, "months"), 1), 24)),
  );
  await setSetting(
    "loyalty_reward_days",
    String(Math.min(Math.max(int(formData, "days"), 1), 365)),
  );
  done();
}

export async function saveNtfySettings(formData: FormData) {
  await requireAdmin();
  const topic = String(formData.get("topic") ?? "").trim();
  if (topic && !/^[\w-]{1,64}$/.test(topic))
    throw new Error(
      "El tema solo puede tener letras, números, - y _ (máx. 64).",
    );
  const server = String(formData.get("server") ?? "")
    .trim()
    .replace(/\/$/, "");
  if (server && !/^https?:\/\/[^\s/]+$/.test(server))
    throw new Error("El servidor debe ser una dirección como https://ntfy.sh");
  await setSetting("ntfy_topic", topic);
  await setSetting("ntfy_server", server);
  await setSetting("ntfy_new", formData.get("new") ? "1" : "0");
  await setSetting("ntfy_updates", formData.get("updates") ? "1" : "0");
  await setSetting("ntfy_pos", formData.get("pos") ? "1" : "0");
  done();
}

export async function testNtfy(): Promise<{ ok: boolean; text: string }> {
  await requireAdmin();
  const { ntfy, business_name } = await getSettings();
  if (!ntfy.topic)
    return { ok: false, text: "Primero guarda el nombre del tema." };
  const err = await sendNtfy(ntfy, {
    title: `✅ ${business_name}: avisos activados`,
    message: "Así te llegarán los pedidos nuevos y sus cambios.",
    tags: ["white_check_mark"],
    priority: 4,
  });
  const where = `${ntfy.server.replace(/^https?:\/\//, "")}/${ntfy.topic}`;
  return err
    ? { ok: false, text: `No se pudo enviar a ${where}: ${err}` }
    : {
        ok: true,
        text: `✓ Enviado al tema ${where}. Si no te llegó, revisa que la app ntfy esté suscrita a ese mismo tema.`,
      };
}

// ---------- Corte de caja ----------

function cashBack(params: Record<string, string>): never {
  redirect(`/admin/caja?${new URLSearchParams(params).toString()}`);
}

export async function openCash(formData: FormData) {
  const session = await requireStaff();
  try {
    const note = str(formData, "note");
    await openSession(toCents(formData.get("opening")), `Abrió ${session.name}${note ? `: ${note}` : ""}`);
  } catch (e) {
    if (e instanceof CashError) cashBack({ error: e.message });
    throw e;
  }
  cashBack({ ok: "Caja abierta. ¡Buen turno!" });
}

export async function cashMovement(formData: FormData) {
  await requireAdmin();
  const kind = str(formData, "kind") === "entrada" ? "entrada" : "salida";
  try {
    await addMovement(kind, toCents(formData.get("amount")), str(formData, "reason"));
  } catch (e) {
    if (e instanceof CashError) cashBack({ error: e.message });
    throw e;
  }
  cashBack({ ok: kind === "entrada" ? "Entrada registrada." : "Salida registrada." });
}

export async function closeCash(formData: FormData) {
  const session = await requireStaff();
  if (str(formData, "counted") === "") cashBack({ error: "Escribe cuánto efectivo contaste en el cajón." });
  let id: number;
  try {
    const note = str(formData, "note");
    const breakdown = str(formData, "breakdown").slice(0, 300);
    id = await closeSession(
      toCents(formData.get("counted")),
      `Cerró ${session.name}${note ? `: ${note}` : ""}${breakdown ? ` · Desglose: ${breakdown}` : ""}`,
    );
  } catch (e) {
    if (e instanceof CashError) cashBack({ error: e.message });
    throw e;
  }
  cashBack({ id: String(id), ok: "Caja cerrada." });
}

/** Quita la foto del producto (y de sus tamaños) y la borra del almacenamiento si ya nadie la usa. */
export async function removeProductPhoto(productId: number) {
  await requireAdmin();
  await setProductPhoto(Number(productId), "");
  done();
}

export async function removeCategoryPhoto(category: string) {
  await requireAdmin();
  await setCategoryPhoto(String(category), "");
  done();
}

// ---------- Códigos de barras (inventario) ----------

export async function lookupBarcode(code: string): Promise<BarcodeMatch | null> {
  await requireAdmin();
  return findByBarcode(String(code));
}

export async function linkBarcode(item: string, code: string): Promise<BarcodeMatch | null> {
  await requireAdmin();
  await assignBarcode(String(item), String(code));
  done();
  return findByBarcode(String(code));
}

/** Crea un insumo nuevo con su código y lo que hay ahora. */
export async function createSupplyFromBarcode(input: {
  code: string;
  name: string;
  unit: string;
  qty: number;
  costPerUnit: number;
  minQty: number;
}): Promise<BarcodeMatch | null> {
  await requireAdmin();
  const code = normalizeBarcode(String(input.code));
  const name = String(input.name ?? "").trim().slice(0, 80);
  if (!code || !name) return null;
  await run("UPDATE products SET barcode = '' WHERE barcode = ?", [code]);
  await run("UPDATE supplies SET barcode = '' WHERE barcode = ?", [code]);
  await run("INSERT INTO supplies (name, unit, qty, min_qty, cost_per_unit, barcode) VALUES (?,?,?,?,?,?)", [
    name,
    String(input.unit ?? "").trim().slice(0, 20) || "pza",
    Math.max(0, Number(input.qty) || 0),
    Math.max(0, Number(input.minQty) || 0),
    Math.max(0, Math.round((Number(input.costPerUnit) || 0) * 100)),
    code,
  ]);
  done();
  return findByBarcode(code);
}

/**
 * Pasa un insumo con código de barras a producto de venta (para cobrarlo en caja).
 * El producto conserva el código, las piezas y el costo; el insumo se quita para no contarlo doble.
 */
export async function supplyToProduct(input: { supplyId: number; price: number; category: string }): Promise<{ ok: true; productId: number } | { ok: false; error: string }> {
  await requireAdmin();
  const price = Math.round((Number(input.price) || 0) * 100);
  const category = String(input.category ?? "").trim().slice(0, 40) || "General";
  if (price <= 0) return { ok: false, error: "Pon el precio de venta." };
  const s = await get<{ id: number; name: string; qty: number; min_qty: number; cost_per_unit: number; barcode: string }>(
    "SELECT id, name, qty, min_qty, cost_per_unit, barcode FROM supplies WHERE id = ?",
    [Math.round(Number(input.supplyId)) || 0],
  );
  if (!s) return { ok: false, error: "Ya no existe ese insumo." };
  let productId = 0;
  await transaction(async (q) => {
    if (s.barcode) await q("UPDATE products SET barcode = '' WHERE barcode = ?", [s.barcode]);
    const [row] = await q<{ id: number }>(
      `INSERT INTO products (name, icon, size, available_days, description, category, price, cost, track_stock, min_stock, image_url, active, sort, pos_only, stock, barcode)
       VALUES (?, '', '', '', '', ?, ?, ?, 1, ?, '', 1, 0, 0, ?, ?) RETURNING id`,
      [s.name, category, price, s.cost_per_unit, Math.max(0, Math.round(s.min_qty)), Math.max(0, Math.round(s.qty)), s.barcode],
    );
    productId = row.id;
    await q("DELETE FROM supplies WHERE id = ?", [s.id]);
  });
  done();
  return { ok: true, productId };
}

/** Crea un producto del menú desde Inventario (con existencia y código de barras). */
async function insertQuickProduct(input: {
  name: string;
  category: string;
  price: number; // centavos
  cost: number; // centavos
  track: boolean;
  stock: number;
  minStock: number;
  code: string;
}): Promise<number> {
  const code = normalizeBarcode(input.code);
  let id = 0;
  await transaction(async (q) => {
    if (code) {
      await q("UPDATE products SET barcode = '' WHERE barcode = ?", [code]);
      await q("UPDATE supplies SET barcode = '' WHERE barcode = ?", [code]);
    }
    const [row] = await q<{ id: number }>(
      `INSERT INTO products (name, icon, size, available_days, description, category, price, cost, track_stock, min_stock, image_url, active, sort, pos_only, stock, barcode)
       VALUES (?, '', '', '', '', ?, ?, ?, ?, ?, '', 1, 0, 0, ?, ?) RETURNING id`,
      [
        input.name.slice(0, 80),
        input.category.slice(0, 40) || "General",
        Math.max(0, input.price),
        Math.max(0, input.cost),
        input.track ? 1 : 0,
        Math.max(0, Math.round(input.minStock)),
        Math.max(0, Math.round(input.stock)),
        code,
      ],
    );
    id = row.id;
    if (input.track && input.stock > 0)
      await q("INSERT INTO inventory_movements (item_type, item_id, change, reason, note) VALUES ('product', ?, ?, 'ajuste', 'Alta desde inventario')", [
        id,
        Math.round(input.stock),
      ]);
  });
  return id;
}

export async function createInventoryProduct(formData: FormData) {
  await requireAdmin();
  const name = str(formData, "name");
  const price = toCents(formData.get("price"));
  if (!name || price <= 0) return;
  await insertQuickProduct({
    name,
    category: str(formData, "category"),
    price,
    cost: toCents(formData.get("cost")),
    track: Boolean(formData.get("track_stock")),
    stock: num(formData, "stock"),
    minStock: num(formData, "min_stock"),
    code: str(formData, "barcode"),
  });
  done();
}

/** Desde el escáner de Inventario: código nuevo → producto de venta. */
export async function createProductFromBarcode(input: {
  code: string;
  name: string;
  category: string;
  price: number;
  cost: number;
  stock: number;
}): Promise<BarcodeMatch | null> {
  await requireAdmin();
  const name = String(input.name ?? "").trim();
  const price = Math.round((Number(input.price) || 0) * 100);
  if (!name || price <= 0 || !normalizeBarcode(String(input.code))) return null;
  await insertQuickProduct({
    name,
    category: String(input.category ?? "").trim(),
    price,
    cost: Math.round((Number(input.cost) || 0) * 100),
    track: true,
    stock: Number(input.stock) || 0,
    minStock: 0,
    code: String(input.code),
  });
  done();
  return findByBarcode(String(input.code));
}


// ---------- Usuarios (solo administradores) ----------

export async function saveStaff(formData: FormData) {
  await requireAdmin();
  const id = int(formData, "id");
  const name = str(formData, "name").slice(0, 60);
  const role = str(formData, "role") === "admin" ? "admin" : "vendedor";
  const active = formData.get("active") ? 1 : 0;
  const pin = str(formData, "pin");
  if (!name) redirect("/admin/usuarios?error=nombre");
  if (pin && !validPin(pin)) redirect("/admin/usuarios?error=pin");
  if (id) {
    await run("UPDATE staff SET name = ?, role = ?, active = ?, session_version = session_version + CASE WHEN active <> ? OR role <> ? THEN 1 ELSE 0 END WHERE id = ?", [
      name,
      role,
      active,
      active,
      role,
      id,
    ]);
    // Cambiar el PIN cierra las sesiones abiertas de ese usuario
    if (pin)
      await run("UPDATE staff SET pin_hash = ?, failed_attempts = 0, locked_until = NULL, session_version = session_version + 1 WHERE id = ?", [hashPin(pin), id]);
  } else {
    await run("INSERT INTO staff (name, role, active, pin_hash, created_at) VALUES (?,?,?,?,?)", [
      name,
      role,
      1,
      pin ? hashPin(pin) : "",
      new Date().toISOString(),
    ]);
  }
  redirect(`/admin/usuarios?ok=${Date.now()}`);
}

export async function deleteStaff(id: number) {
  await requireAdmin();
  await run("DELETE FROM staff WHERE id = ?", [id]);
  redirect(`/admin/usuarios?ok=${Date.now()}`);
}
