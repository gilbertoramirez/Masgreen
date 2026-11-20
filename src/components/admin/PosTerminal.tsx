"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { posSale } from "@/app/admin/actions";
import { money } from "@/lib/format";
import { fuzzyFilter } from "@/lib/fuzzy";
import SaleClosedDialog, { type SaleResult } from "./SaleClosedDialog";
import BarcodeScanner from "./BarcodeScanner";
import LoyaltyCard from "@/components/LoyaltyCard";
import { getLoyalty, lookupBarcode, supplyToProduct } from "@/app/admin/actions";
import { useRouter } from "next/navigation";
import { normalizePhone, pickFreeLine, type LoyaltyStatus } from "@/lib/loyaltyRules";
import { loadPrinter, openDrawer, printTickets, shouldOpenDrawer } from "@/lib/printer";

type P = { id: number; name: string; category: string; size: string; price: number; maxQty: number; icon: string; barcode: string };
type Method = "efectivo" | "tarjeta" | "transferencia";

/** Pedido abierto en una pestaña de la caja (se guarda en este dispositivo). */
type OpenTab = {
  id: string;
  n: number;
  ticket: Record<number, number>;
  method: Method;
  cash: string;
  customer: string;
  phone: string;
  useReward: boolean;
  createdAt: number;
};
const TABS_KEY = "cafe_pos_tabs_v1";
const newTab = (n: number): OpenTab => ({
  id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
  n,
  ticket: {},
  method: "efectivo",
  cash: "",
  customer: "",
  phone: "",
  useReward: false,
  createdAt: Date.now(),
});
const isEmpty = (t: OpenTab) => Object.keys(t.ticket).length === 0 && !t.customer && !t.phone;
const tabLabel = (t: OpenTab) => t.customer.trim() || `Pedido ${t.n}`;

export default function PosTerminal({ products, canManage = true }: { products: P[]; canManage?: boolean }) {
  // Pedidos abiertos en pestañas: cada uno conserva sus productos y datos
  const [tabs, setTabs] = useState<OpenTab[]>(() => [newTab(1)]);
  const [activeId, setActiveId] = useState(tabs[0].id);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(TABS_KEY) || "null") as { tabs: OpenTab[]; active: string } | null;
      if (saved?.tabs?.length) {
        setTabs(saved.tabs); // eslint-disable-line react-hooks/set-state-in-effect
        setActiveId(saved.tabs.some((t) => t.id === saved.active) ? saved.active : saved.tabs[0].id);
      }
    } catch {}
    setHydrated(true);
  }, []);
  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(TABS_KEY, JSON.stringify({ tabs, active: activeId }));
    } catch {}
  }, [tabs, activeId, hydrated]);
  const tabsRef = useRef(tabs); // pestañas al momento de terminar un cobro (que es asíncrono)
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);
  const cur = tabs.find((t) => t.id === activeId) ?? tabs[0];
  const update = (patch: Partial<OpenTab> | ((t: OpenTab) => Partial<OpenTab>)) =>
    setTabs((all) => all.map((t) => (t.id === cur.id ? { ...t, ...(typeof patch === "function" ? patch(t) : patch) } : t)));
  const { ticket, method, cash, customer, phone, useReward } = cur;
  const setTicket = (fn: Record<number, number> | ((t: Record<number, number>) => Record<number, number>)) =>
    update((t) => ({ ticket: typeof fn === "function" ? fn(t.ticket) : fn }));
  const setMethod = (method: Method) => update({ method });
  const setCash = (cash: string) => update({ cash });
  const setCustomer = (customer: string) => update({ customer });
  const setPhone = (phone: string) => update({ phone, useReward: false });
  const setUseReward = (useReward: boolean) => update({ useReward });

  function switchTo(id: string) {
    setActiveId(id);
    setMsg(null);
  }
  function openNew() {
    const empty = tabs.find(isEmpty);
    if (empty) return switchTo(empty.id);
    const t = newTab(Math.max(0, ...tabs.map((x) => x.n)) + 1);
    setTabs((all) => [...all, t]);
    switchTo(t.id);
  }
  function closeTab(id: string) {
    const t = tabs.find((x) => x.id === id);
    if (t && !isEmpty(t) && !confirm(`¿Cerrar "${tabLabel(t)}" sin cobrar? Se pierden sus productos.`)) return;
    const rest = tabs.filter((x) => x.id !== id);
    const next = rest.length ? rest : [newTab(1)];
    setTabs(next);
    if (id === activeId) switchTo(next[next.length - 1].id);
  }
  /** Después de cobrar: quita la pestaña cobrada y deja lista una vacía (las demás siguen abiertas). */
  function finishTab(id: string) {
    const rest = tabsRef.current.filter((x) => x.id !== id);
    const empty = rest.find(isEmpty);
    if (empty) {
      setTabs(rest);
      switchTo(empty.id);
    } else {
      const t = newTab(rest.length ? Math.max(...rest.map((x) => x.n)) + 1 : 1);
      setTabs([...rest, t]);
      switchTo(t.id);
    }
  }

  const [search, setSearch] = useState("");
  const [scanning, setScanning] = useState(false);
  const [scanNote, setScanNote] = useState<{ ok: boolean; text: string } | null>(null);
  // Código que pertenece a un insumo: se ofrece pasarlo a producto de venta
  const [convert, setConvert] = useState<{ id: number; name: string; qty: number; code: string } | null>(null);
  const [convPrice, setConvPrice] = useState("");
  const [convCat, setConvCat] = useState("");
  const [converting, setConverting] = useState(false);
  const router = useRouter();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [closed, setClosed] = useState<SaleResult | null>(null); // venta recién cerrada
  // Lealtad: sellos del teléfono del pedido activo y canje de bebida gratis
  const [loyalty, setLoyalty] = useState<LoyaltyStatus | null>(null);
  const loyaltyPhone = normalizePhone(phone);
  useEffect(() => {
    if (!loyaltyPhone) return setLoyalty(null); // eslint-disable-line react-hooks/set-state-in-effect
    let alive = true;
    getLoyalty(loyaltyPhone)
      .then((st) => alive && setLoyalty(st))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [loyaltyPhone]);
  const [drawerEnabled, setDrawerEnabled] = useState(false);

  // ¿Este dispositivo tiene cajón configurado? (se lee después de hidratar)
  useEffect(() => {
    const s = loadPrinter();
    setDrawerEnabled(s.drawer && s.method !== "browser"); // eslint-disable-line react-hooks/set-state-in-effect
  }, []);

  async function manualDrawer() {
    try {
      await openDrawer();
      setMsg({ ok: true, text: "🗄️ Cajón abierto" });
    } catch (e) {
      setMsg({ ok: false, text: `No se abrió el cajón: ${e instanceof Error ? e.message : e}` });
    }
  }
  const [pending, start] = useTransition();

  const categories = useMemo(() => ["Todo", ...new Set(products.map((p) => p.category))], [products]);
  // Al buscar se busca en todo el menú (tolera acentos y errores de dedo)
  const byCode = search.trim() ? products.filter((p) => p.barcode && p.barcode === search.trim()) : [];
  const shown = byCode.length
    ? byCode
    : search.trim()
    ? fuzzyFilter(products, search, (p) => [
        { text: p.name, weight: 1 },
        { text: p.category, weight: 0.6 },
      ])
    : []; // sin búsqueda no se lista el menú: se agrega escaneando o buscando
  const lines = Object.entries(ticket)
    .map(([id, qty]) => ({ p: products.find((x) => x.id === Number(id))!, qty }))
    .filter((l) => l.p && l.qty > 0);
  // Bebida gratis (lealtad): misma regla que el servidor
  const freeIdx = useReward ? pickFreeLine(lines.map((l) => ({ category: l.p.category, size: l.p.size, price: l.p.price }))) : -1;
  const freeValue = freeIdx >= 0 ? lines[freeIdx].p.price : 0;
  const total = lines.reduce((a, l) => a + l.p.price * l.qty, 0) - freeValue;
  const cashCents = Math.round(Number(cash || 0) * 100);
  const change = method === "efectivo" && cash ? cashCents - total : 0;

  function add(p: P, d: number) {
    setMsg(null);
    setTicket((t) => {
      const q = Math.max(0, Math.min((t[p.id] ?? 0) + d, p.maxQty));
      const n = { ...t };
      if (q) n[p.id] = q;
      else delete n[p.id];
      return n;
    });
  }

  /** Código leído con la cámara o con un lector USB/Bluetooth: agrega el producto al ticket. */
  function addByBarcode(raw: string): boolean {
    const code = raw.replace(/\s+/g, "");
    if (!code) return false;
    const p = products.find((x) => x.barcode && x.barcode === code);
    if (!p && !canManage) {
      setScanNote({ ok: false, text: `El código ${code} no está en el menú. Avísale al administrador.` });
      return false;
    }
    if (!p) {
      setConvert(null);
      setScanNote({ ok: false, text: `Buscando ${code}…` });
      lookupBarcode(code)
        .then((m) => {
          if (m?.type === "supply") {
            setScanNote(null);
            setConvPrice("");
            setConvCat(products[0]?.category ?? "");
            setConvert({ id: m.id, name: m.name, qty: m.qty, code });
          } else if (m?.type === "product") {
            setScanNote({ ok: false, text: `${m.name} está oculto o no se vende en caja. Revísalo en Menú.` });
          } else {
            setScanNote({ ok: false, text: `El código ${code} no está registrado. Asígnalo en Inventario o en Menú.` });
          }
        })
        .catch(() => setScanNote({ ok: false, text: `El código ${code} no está registrado.` }));
      return true;
    }
    if ((ticket[p.id] ?? 0) >= p.maxQty) {
      setScanNote({ ok: false, text: `${p.name}: ya no hay existencias.` });
      return true;
    }
    add(p, 1);
    setScanNote({ ok: true, text: `✓ ${p.name} agregado (${(ticket[p.id] ?? 0) + 1})` });
    return true;
  }

  async function doConvert() {
    if (!convert) return;
    setConverting(true);
    const res = await supplyToProduct({ supplyId: convert.id, price: Number(convPrice), category: convCat });
    setConverting(false);
    if (!res.ok) return setScanNote({ ok: false, text: res.error });
    const name = convert.name;
    setConvert(null);
    if (convert.qty >= 1) setTicket((t) => ({ ...t, [res.productId]: 1 }));
    setScanNote({ ok: true, text: `✓ ${name} ya es producto de venta${convert.qty >= 1 ? " y se agregó al ticket" : ". Pon cuántas piezas hay en Inventario"}.` });
    router.refresh();
  }

  function charge() {
    const chargedId = cur.id;
    start(async () => {
      const res = await posSale({
        items: lines.map((l) => ({ productId: l.p.id, qty: l.qty })),
        paymentMethod: method,
        cashGiven: method === "efectivo" && cash ? cashCents : null,
        customerName: customer,
        phone: loyaltyPhone,
        useReward: useReward && freeIdx >= 0,
      });
      if (res.ok) {
        setMsg(null);
        // Imprimir y/o abrir el cajón de inmediato, todavía dentro del toque en "Cobrar"
        // (Android/RawBT bloquea aperturas que no vienen de un toque reciente)
        const s = loadPrinter();
        const result: SaleResult = { orderId: res.orderId, change: res.change, ticket: res.ticket };
        if (res.ticket) {
          try {
            if (s.autoPrintSale) {
              await printTickets([res.ticket], s, { openDrawer: true });
              result.printed = true;
              result.drawerOpened = shouldOpenDrawer(res.ticket, s);
            } else if (shouldOpenDrawer(res.ticket, s)) {
              await openDrawer(s);
              result.drawerOpened = true;
            }
          } catch (e) {
            result.error = e instanceof Error ? e.message : String(e);
          }
        }
        setClosed(result);
        finishTab(chargedId);
      } else {
        setMsg({ ok: false, text: res.error });
      }
    });
  }

  const quickCash = [total, 10000, 20000, 50000].filter((v, i, a) => v >= total && a.indexOf(v) === i && v > 0);

  const ticketPanel = (
    <>
        <h2 className="text-lg font-semibold">{tabLabel(cur)}</h2>
        {lines.length === 0 ? (
          <p className="text-sm text-cafe-600">Escanea el código o busca un producto para agregarlo.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {lines.map((l) => (
              <li key={l.p.id} className="flex items-center gap-2">
                <button className="h-7 w-7 rounded-full bg-cafe-100" onClick={() => add(l.p, -1)}>
                  −
                </button>
                <span className="w-5 text-center">{l.qty}</span>
                <button className="h-7 w-7 rounded-full bg-cafe-100" onClick={() => add(l.p, 1)}>
                  +
                </button>
                <span className="flex-1 truncate">{l.p.name}</span>
                <span className="tabular-nums">{money(l.p.price * l.qty)}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="flex justify-between border-t border-cafe-100 pt-3 text-xl font-semibold">
          <span>Total</span>
          <span className="tabular-nums">{money(total)}</span>
        </div>

        <input className="input" placeholder="Cliente o mesa (opcional)" value={customer} onChange={(e) => setCustomer(e.target.value)} />
        <input
          className="input"
          type="tel"
          inputMode="tel"
          placeholder="Teléfono para sellos (opcional)"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
        />
        {loyalty && (
          <div className="space-y-2">
            <LoyaltyCard status={loyalty} compact />
            {loyalty.rewards.length > 0 && (
              <label className="flex items-center gap-2 rounded-lg bg-green-50 p-2 text-sm text-green-800">
                <input type="checkbox" checked={useReward} onChange={(e) => setUseReward(e.target.checked)} />
                🎁 Aplicar bebida gratis
                {useReward && freeIdx < 0 && <span className="text-amber-700"> (agrega una bebida de hasta 12oz)</span>}
              </label>
            )}
          </div>
        )}
        {freeIdx >= 0 && (
          <p className="flex justify-between text-sm text-green-700">
            <span>🎁 Bebida gratis ({lines[freeIdx].p.name})</span>
            <span>−{money(freeValue)}</span>
          </p>
        )}

        <div className="grid grid-cols-3 gap-1">
          {(["efectivo", "tarjeta", "transferencia"] as Method[]).map((m) => (
            <button
              key={m}
              onClick={() => setMethod(m)}
              className={`rounded-lg py-2 text-xs font-medium capitalize ${
                method === m ? "bg-cafe-800 text-white" : "bg-cafe-50 ring-1 ring-cafe-200"
              }`}
            >
              {m}
            </button>
          ))}
        </div>

        {method === "efectivo" && (
          <div className="space-y-2">
            <input
              className="input text-lg"
              type="number"
              min={0}
              step="0.5"
              placeholder="Recibido"
              value={cash}
              onChange={(e) => setCash(e.target.value)}
            />
            <div className="flex flex-wrap gap-1">
              {quickCash.map((v) => (
                <button key={v} className="btn-secondary px-2 py-1 text-xs" onClick={() => setCash(String(v / 100))}>
                  {v === total ? "Exacto" : money(v)}
                </button>
              ))}
            </div>
            {cash && (
              <p className={`text-lg font-semibold ${change < 0 ? "text-red-700" : "text-green-700"}`}>
                {change < 0 ? `Faltan ${money(-change)}` : `Cambio: ${money(change)}`}
              </p>
            )}
          </div>
        )}

        {msg && (
          <p className={`rounded-lg p-2 text-sm ${msg.ok ? "bg-green-50 text-green-800" : "bg-red-50 text-red-700"}`}>{msg.text}</p>
        )}

        <button
          className="btn-primary w-full py-3 text-base"
          disabled={pending || lines.length === 0 || (method === "efectivo" && cash !== "" && change < 0)}
          onClick={charge}
        >
          {pending ? "Registrando…" : `Cobrar ${money(total)}`}
        </button>
        <div className="flex items-center justify-between gap-2">
          {lines.length > 0 ? (
            <button className="text-xs text-cafe-600 underline" onClick={() => setTicket({})}>
              Vaciar ticket
            </button>
          ) : (
            <span />
          )}
          {drawerEnabled && (
            <button className="btn-secondary px-3 py-1 text-xs" onClick={manualDrawer}>
              🗄️ Abrir cajón
            </button>
          )}
        </div>
    </>
  );

  return (
    <div className="mx-auto max-w-2xl space-y-3">
      <section className="min-w-0">
        {/* Pedidos abiertos */}
        <div className="sticky top-11 z-20 -mx-4 mb-3 flex gap-2 overflow-x-auto bg-cafe-50/95 px-4 py-2 backdrop-blur md:top-0 lg:static lg:mx-0 lg:bg-transparent lg:px-0 lg:py-0 lg:pb-1" role="tablist" aria-label="Pedidos abiertos">
          {tabs.map((t) => {
            const on = t.id === cur.id;
            const items = Object.values(t.ticket).reduce((a, q) => a + q, 0);
            const sum = Object.entries(t.ticket).reduce(
              (a, [id, q]) => a + (products.find((x) => x.id === Number(id))?.price ?? 0) * q,
              0,
            );
            return (
              <div
                key={t.id}
                className={`flex shrink-0 items-center rounded-xl text-sm ring-1 ${
                  on ? "bg-cafe-800 text-white ring-cafe-800" : "bg-white ring-cafe-200"
                }`}
              >
                <button role="tab" aria-selected={on} onClick={() => switchTo(t.id)} className="py-2 pr-1 pl-3 text-left">
                  <span className="block max-w-36 truncate font-semibold">{tabLabel(t)}</span>
                  <span className={`block text-xs ${on ? "text-cafe-200" : "text-cafe-500"}`}>
                    {items ? `${items} prod. · ${money(sum)}` : "Vacío"}
                  </span>
                </button>
                <button
                  onClick={() => closeTab(t.id)}
                  aria-label={`Cerrar ${tabLabel(t)}`}
                  className={`px-2 py-2 text-lg leading-none ${on ? "text-cafe-200" : "text-cafe-400"}`}
                >
                  ×
                </button>
              </div>
            );
          })}
          <button
            onClick={openNew}
            className="shrink-0 rounded-xl border border-dashed border-cafe-300 px-3 text-sm font-semibold text-cafe-700"
          >
            + Nuevo pedido
          </button>
        </div>
        <div className="mb-2 flex gap-2 lg:max-w-96">
          <input
            className="input min-w-0 flex-1"
            type="search"
            placeholder="Buscar producto o código…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              // Los lectores de código USB/Bluetooth escriben el número y presionan Enter
              if (e.key === "Enter" && /^\d{6,}$/.test(search.trim()) && addByBarcode(search)) setSearch("");
            }}
          />
          <button type="button" className="btn-secondary shrink-0 px-3" onClick={() => setScanning(true)} aria-label="Escanear código de barras">
            📷 Escanear
          </button>
        </div>
        {scanNote && (
          <p className={`mb-2 rounded-lg p-2 text-sm ${scanNote.ok ? "bg-green-50 text-green-800" : "bg-red-50 text-red-700"}`}>{scanNote.text}</p>
        )}
        {convert && (
          <div className="mb-2 space-y-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-950">
            <p>
              <b>{convert.name}</b> está registrado como <b>insumo</b>, por eso no aparece en caja. ¿Lo pasamos a producto de venta? Se
              conservan su código y sus {convert.qty} piezas.
            </p>
            <div className="flex flex-wrap gap-2">
              <input
                className="input w-28"
                type="number"
                step="0.01"
                min="0"
                inputMode="decimal"
                placeholder="Precio $"
                value={convPrice}
                onChange={(e) => setConvPrice(e.target.value)}
              />
              <input
                className="input min-w-0 flex-1"
                placeholder="Categoría (ej. Bebidas)"
                list="pos-cats"
                value={convCat}
                onChange={(e) => setConvCat(e.target.value)}
              />
              <datalist id="pos-cats">
                {categories.slice(1).map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </div>
            <div className="flex gap-2">
              <button className="btn-primary" disabled={converting || !(Number(convPrice) > 0)} onClick={doConvert}>
                {converting ? "Guardando…" : "Pasar a producto de venta"}
              </button>
              <button className="btn-secondary" onClick={() => setConvert(null)}>
                No
              </button>
            </div>
          </div>
        )}
        {scanning && (
          <BarcodeScanner
            onDetected={(c) => {
              setScanning(false);
              addByBarcode(c);
            }}
            onClose={() => setScanning(false)}
          />
        )}
        {search.trim() !== "" && (
          <div className="card divide-y divide-cafe-100 p-0">
            {shown.length === 0 && <p className="p-3 text-sm text-cafe-600">Sin resultados.</p>}
            {shown.slice(0, 8).map((p) => {
              const out = p.maxQty <= 0;
              const q = ticket[p.id] ?? 0;
              return (
                <button
                  key={p.id}
                  disabled={out || q >= p.maxQty}
                  onClick={() => {
                    add(p, 1);
                    setSearch("");
                  }}
                  className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-cafe-50 disabled:opacity-40"
                >
                  {p.icon && <span aria-hidden>{p.icon}</span>}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{p.name}</span>
                    {p.maxQty < 999 && <span className="text-xs text-cafe-500">{out ? "Agotado" : `Quedan ${p.maxQty}`}</span>}
                  </span>
                  <span className="tabular-nums text-cafe-700">{money(p.price)}</span>
                  <span className="rounded-full bg-cafe-800 px-2 text-sm font-bold text-white">+</span>
                </button>
              );
            })}
          </div>
        )}
      </section>

      {/* El pedido en curso, siempre a la vista */}
      <section className="card space-y-3">{ticketPanel}</section>

      {closed && <SaleClosedDialog sale={closed} onClose={() => setClosed(null)} />}
    </div>
  );
}
