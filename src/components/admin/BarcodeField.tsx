"use client";

import { useState } from "react";
import BarcodeScanner from "./BarcodeScanner";

/** Campo de código de barras con botón para leerlo con la cámara. */
export default function BarcodeField({ name = "barcode", defaultValue = "", className = "" }: { name?: string; defaultValue?: string; className?: string }) {
  const [value, setValue] = useState(defaultValue);
  const [scanning, setScanning] = useState(false);
  return (
    <div className={`flex gap-1 ${className}`}>
      <input
        name={name}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="input min-w-0 flex-1 font-mono text-xs"
        inputMode="numeric"
        placeholder="—"
        onKeyDown={(e) => {
          // Un lector USB escribe el código y presiona Enter: que no envíe el formulario
          if (e.key === "Enter") e.preventDefault();
        }}
      />
      <button type="button" className="btn-secondary shrink-0 px-2" onClick={() => setScanning(true)} aria-label="Escanear código de barras">
        📷
      </button>
      {scanning && (
        <BarcodeScanner
          onDetected={(c) => {
            setValue(c.replace(/\s+/g, ""));
            setScanning(false);
          }}
          onClose={() => setScanning(false)}
        />
      )}
    </div>
  );
}
