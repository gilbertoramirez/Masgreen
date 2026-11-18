"use client";

import { useState } from "react";
import { fuzzyFilter } from "@/lib/fuzzy";
import BarcodeScanner from "./BarcodeScanner";

export type PickItem = { item: string; label: string; barcode: string; qty: number; unit: string; group: string };

/** Elige un producto o insumo escaneando su código o buscándolo por nombre (en vez de una lista larga). */
export default function ItemPicker({ items, name = "item" }: { items: PickItem[]; name?: string }) {
  const [sel, setSel] = useState("");
  const [q, setQ] = useState("");
  const [scanning, setScanning] = useState(false);
  const [note, setNote] = useState("");
  const current = items.find((i) => i.item === sel);

  function byCode(raw: string) {
    const code = raw.replace(/\s+/g, "");
    const hit = items.find((i) => i.barcode && i.barcode === code);
    if (hit) {
      setSel(hit.item);
      setQ("");
      setNote("");
    } else setNote(`El código ${code} no está registrado. Regístralo con el escáner de arriba.`);
    return Boolean(hit);
  }

  const term = q.trim();
  const exact = term ? items.filter((i) => i.barcode && i.barcode === term) : [];
  const matches = exact.length
    ? exact
    : term
      ? fuzzyFilter(items, term, (i) => [
          { text: i.label, weight: 1 },
          { text: i.barcode, weight: 0.9 },
        ]).slice(0, 6)
      : [];

  return (
    <div className="space-y-2">
      {/* Valor real que se envía; obligatorio para que no se mande sin elegir */}
      <input name={name} value={sel} onChange={() => {}} required className="sr-only" tabIndex={-1} aria-hidden="true" />
      {current ? (
        <div className="flex items-center justify-between gap-2 rounded-lg bg-cafe-50 p-2 text-sm ring-1 ring-cafe-200">
          <div className="min-w-0">
            <p className="truncate font-semibold">{current.label}</p>
            <p className="text-xs text-cafe-600">
              Hay {current.qty} {current.unit}
              {current.barcode ? ` · ${current.barcode}` : ""}
            </p>
          </div>
          <button type="button" className="shrink-0 text-xs underline" onClick={() => setSel("")}>
            Cambiar
          </button>
        </div>
      ) : (
        <>
          <div className="flex gap-2">
            <input
              className="input min-w-0 flex-1"
              type="search"
              inputMode="search"
              placeholder="Escanea o escribe código o nombre…"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setNote("");
              }}
              onKeyDown={(e) => {
                // Lector USB/Bluetooth: escribe el código y presiona Enter
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (/^\d{6,}$/.test(term)) byCode(term);
                  else if (matches[0]) {
                    setSel(matches[0].item);
                    setQ("");
                  }
                }
              }}
            />
            <button type="button" className="btn-secondary shrink-0 px-3" onClick={() => setScanning(true)} aria-label="Escanear código de barras">
              📷
            </button>
          </div>
          {note && <p className="text-xs text-red-700">{note}</p>}
          {matches.length > 0 && (
            <div className="divide-y divide-cafe-100 rounded-lg ring-1 ring-cafe-200">
              {matches.map((m) => (
                <button
                  type="button"
                  key={m.item}
                  className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-cafe-50"
                  onClick={() => {
                    setSel(m.item);
                    setQ("");
                  }}
                >
                  <span className="min-w-0 truncate">{m.label}</span>
                  <span className="shrink-0 text-xs text-cafe-600">
                    hay {m.qty} {m.unit}
                  </span>
                </button>
              ))}
            </div>
          )}
          {term && matches.length === 0 && !note && <p className="text-xs text-cafe-600">Sin resultados.</p>}
        </>
      )}
      {scanning && (
        <BarcodeScanner
          onDetected={(c) => {
            setScanning(false);
            byCode(c);
          }}
          onClose={() => setScanning(false)}
        />
      )}
    </div>
  );
}
