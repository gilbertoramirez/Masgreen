import { requireAdmin } from "@/lib/auth";
import { Field, PageTitle } from "@/components/admin/ui";
import { centsToInput } from "@/lib/format";
import { getSettings } from "@/lib/settings";
import { randomBytes } from "node:crypto";
import { saveLoyaltySettings, saveNtfySettings, saveSettings } from "../../actions";
import NtfyTestButton from "@/components/admin/NtfyTestButton";
import PrinterSettingsCard from "@/components/admin/PrinterSettingsCard";

export default async function SettingsPage() {
  await requireAdmin();
  const s = await getSettings();
  return (
    <div className="max-w-2xl space-y-6">
      <PageTitle>Ajustes</PageTitle>
      <form action={saveSettings} className="card grid gap-4 sm:grid-cols-2">
        <Field label="Nombre del negocio" className="sm:col-span-2">
          <input
            name="business_name"
            className="input"
            defaultValue={s.business_name}
            required
          />
        </Field>
        <Field
          label="WhatsApp del negocio"
          hint="10 dígitos, ej. 5512345678. Los pedidos por WhatsApp llegan aquí."
        >
          <input
            name="whatsapp_number"
            className="input"
            defaultValue={s.whatsapp_number}
            inputMode="tel"
          />
        </Field>
        <Field label="Horario" hint="Se imprime en el ticket.">
          <input name="hours" className="input" defaultValue={s.hours} />
        </Field>
        <Field label="Dirección" className="sm:col-span-2">
          <input name="address" className="input" defaultValue={s.address} />
        </Field>
        <div className="sm:col-span-2">
          <button className="btn-primary">Guardar ajustes</button>
        </div>
      </form>

      <form action={saveLoyaltySettings} className="card space-y-3 text-sm">
        <h2 className="font-semibold">☕ Programa de lealtad</h2>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            name="enabled"
            defaultChecked={s.loyalty.enabled}
          />{" "}
          Activar tarjeta de sellos
        </label>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label="Sellos para premio">
            <input
              name="needed"
              type="number"
              min="1"
              max="50"
              className="input"
              defaultValue={s.loyalty.needed}
            />
          </Field>
          <Field label="Compra mínima ($)">
            <input
              name="min"
              type="number"
              step="0.01"
              min="0"
              className="input"
              defaultValue={centsToInput(s.loyalty.minPurchase)}
            />
          </Field>
          <Field label="Sellos duran (meses)">
            <input
              name="months"
              type="number"
              min="1"
              max="24"
              className="input"
              defaultValue={s.loyalty.stampMonths}
            />
          </Field>
          <Field label="Bebida gratis dura (días)">
            <input
              name="days"
              type="number"
              min="1"
              max="365"
              className="input"
              defaultValue={s.loyalty.rewardDays}
            />
          </Field>
        </div>
        <p className="text-cafe-600">
          1 sello por día por teléfono en compras desde la compra mínima: en la caja escribe el teléfono del cliente. Premio:
          una bebida de hasta 12oz que se canjea en la caja. Cancelar una venta quita su sello.
        </p>
        <button className="btn-secondary">Guardar lealtad</button>
      </form>

      <form action={saveNtfySettings} className="card space-y-3 text-sm">
        <h2 className="font-semibold">🔔 Avisos al celular (ntfy)</h2>
        <ol className="list-decimal space-y-1 pl-5 text-cafe-700">
          <li>
            Instala la app gratuita <b>ntfy</b> en tu celular (Play Store o App
            Store).
          </li>
          <li>
            Toca <b>+</b>, escribe exactamente el mismo nombre de tema que
            aparece abajo y suscríbete.
          </li>
          <li>Toca “Enviar prueba”.</li>
        </ol>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Nombre del tema">
            <input
              name="topic"
              className="input font-mono"
              pattern="[A-Za-z0-9_\-]{1,64}"
              defaultValue={
                s.ntfy.topic || `cafe-allison-${randomBytes(5).toString("hex")}`
              }
              required
            />
          </Field>
          <Field label="Servidor">
            <input
              name="server"
              className="input"
              placeholder="https://ntfy.sh"
              defaultValue={
                s.ntfy.server === "https://ntfy.sh" ? "" : s.ntfy.server
              }
            />
          </Field>
        </div>
        <p className="text-amber-700">
          Cualquiera que conozca el nombre del tema puede leer los avisos: usa
          uno difícil de adivinar y no lo compartas. Los avisos no incluyen
          teléfonos ni direcciones.
        </p>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              name="new"
              defaultChecked={s.ntfy.newOrders}
            />{" "}
            Pedidos nuevos
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              name="updates"
              defaultChecked={s.ntfy.updates}
            />{" "}
            Cambios (estado, pago, cancelación)
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" name="pos" defaultChecked={s.ntfy.pos} />{" "}
            También ventas de caja
          </label>
        </div>
        <p className={s.ntfy.topic ? "text-green-700" : "text-cafe-600"}>
          {s.ntfy.topic
            ? `✓ Avisos activos en el tema “${s.ntfy.topic}”.`
            : "Avisos apagados hasta que guardes un tema."}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <button className="btn-primary">Guardar avisos</button>
          {s.ntfy.topic && (
            <a
              href={`ntfy://${s.ntfy.server.replace(/^https?:\/\//, "")}/${s.ntfy.topic}`}
              className="btn-secondary"
            >
              📲 Suscribirme en la app ntfy
            </a>
          )}
          {s.ntfy.topic && <NtfyTestButton />}
        </div>
      </form>

      <PrinterSettingsCard businessName={s.business_name} />

    </div>
  );
}
