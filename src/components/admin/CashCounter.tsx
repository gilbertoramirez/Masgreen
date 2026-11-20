"use client";

import { useState } from "react";
import { money } from "@/lib/format";

const BILLS = [1000, 500, 200, 100, 50, 20];
const COINS = [10, 5, 2, 1, 0.5];
const label = (d: number) => (d < 1 ? `$${d.toFixed(2)}` : `$${d.toLocaleString("es-MX")}`);

/**
 * Conteo del efectivo: por billetes y monedas (suma sola) o solo el total.
 * Envía "counted" (pesos) y "breakdown" (texto del desglose) con el formulario.
 * `expected` (centavos) solo se pasa al administrador para ver la diferencia al momento.
 */
export default function CashCounter({ expected }: { expected?: number }) {
  const [mode, setMode] = useState<"desglose" | "total">("desglose");
  const [qty, setQty] = useState<Record<string, string>>({});
  const [total, setTotal] = useState("");

  const pieces = (d: number) => Math.max(0, Math.floor(Number(qty[d]) || 0));
  const breakdownCents = [...BILLS, ...COINS].reduce((a, d) => a + Math.round(d * 100) * pieces(d), 0);
  const countedCents = mode === "desglose" ? breakdownCents : Math.round((Number(total) || 0) * 100);
  const filled = mode === "desglose" ? Object.values(qty).some((v) => v !== "") : total !== "";
  const breakdown =
    mode === "desglose"
      ? [...BILLS, ...COINS]
          .filter((d) => pieces(d) > 0)
          .map((d) => `${pieces(d)}×${label(d)}`)
          .join(", ")
      : "";
  const diff = countedCents - (expected ?? 0);

  const row = (d: number) => (
    <label key={d} className="flex items-center justify-between gap-2">
      <span className="w-16 font-semibold tabular-nums">{label(d)}</span>
      <span className="text-cafe-400">×</span>
      <input
        type="number"
        inputMode="numeric"
        min="0"
        step="1"
        placeholder="0"
        aria-label={`Cantidad de ${label(d)}`}
        className="input w-20 text-center"
        value={qty[d] ?? ""}
        onChange={(e) => setQty({ ...qty, [d]: e.target.value })}
      />
    </label>
  );

  return (
    <div className="space-y-3">
      {/* Lo que se envía: total en pesos y el desglose para el historial */}
      <input type="hidden" name="counted" value={filled ? (countedCents / 100).toFixed(2) : ""} />
      <input type="hidden" name="breakdown" value={breakdown} />

      <div className="grid grid-cols-2 gap-1 rounded-xl bg-cafe-100 p-1" role="tablist">
        {(["desglose", "total"] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            onClick={() => setMode(m)}
            className={`rounded-lg px-2 py-2 text-sm font-semibold ${mode === m ? "bg-white shadow-sm" : "text-cafe-600"}`}
          >
            {m === "desglose" ? "Billetes y monedas" : "Solo total"}
          </button>
        ))}
      </div>

      {mode === "desglose" ? (
        <div className="grid grid-cols-2 gap-x-4 gap-y-2">
          <div className="space-y-2">
            <p className="text-xs font-semibold tracking-wide text-cafe-600 uppercase">Billetes</p>
            {BILLS.map(row)}
          </div>
          <div className="space-y-2">
            <p className="text-xs font-semibold tracking-wide text-cafe-600 uppercase">Monedas</p>
            {COINS.map(row)}
          </div>
        </div>
      ) : (
        <input
          type="number"
          inputMode="decimal"
          step="0.5"
          min="0"
          placeholder="Total contado $"
          aria-label="Efectivo contado"
          className="input text-lg"
          value={total}
          onChange={(e) => setTotal(e.target.value)}
        />
      )}

      <div className="flex items-center justify-between border-t border-cafe-100 pt-2 text-base">
        <span className="font-semibold">Total contado</span>
        <span className="text-xl font-bold tabular-nums">{money(countedCents)}</span>
      </div>
      {expected != null && filled && (
        <p
          className={`rounded-lg p-2 text-center font-semibold ${
            diff === 0 ? "bg-green-50 text-green-800" : diff > 0 ? "bg-amber-50 text-amber-800" : "bg-red-50 text-red-700"
          }`}
        >
          {diff === 0 ? "✓ La caja cuadra" : diff > 0 ? `Sobran ${money(diff)}` : `Faltan ${money(-diff)}`}
        </p>
      )}
    </div>
  );
}
