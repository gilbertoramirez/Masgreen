import { requireAdmin } from "@/lib/auth";
import { all } from "@/lib/db";
import { PageTitle } from "@/components/admin/ui";
import { deleteStaff, saveStaff } from "../../actions";

type Row = { id: number; name: string; role: string; active: number; has_pin: boolean; locked_until: string | null };

/** Bloqueado por intentos fallidos (se calcula al pedir la página). */
function isLocked(until: string | null) {
  return Boolean(until && Date.parse(until) > Date.now());
}

const ERRORS: Record<string, string> = {
  nombre: "Escribe el nombre.",
  pin: "El PIN debe tener de 4 a 6 números.",
};

export default async function UsersPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const me = await requireAdmin();
  const sp = await searchParams;
  const users = await all<Row>(
    "SELECT id, name, role, active, pin_hash <> '' AS has_pin, locked_until FROM staff ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, name",
  );

  return (
    <div className="space-y-5">
      <PageTitle>Usuarios</PageTitle>
      <p className="-mt-3 text-sm text-cafe-600">
        Cada persona entra con su nombre y un PIN de 4 a 6 números. Los <b>vendedores</b> solo ven Caja, Pedidos, Corte de caja e
        Inventario (sin editar precios ni costos). Los <b>administradores</b> ven todo.
      </p>
      {sp.error && <p className="rounded-lg bg-red-50 p-2 text-sm text-red-700">{ERRORS[sp.error] ?? "No se pudo guardar."}</p>}
      {sp.ok && <p className="rounded-lg bg-green-50 p-2 text-sm text-green-800">✓ Guardado.</p>}

      <section className="card divide-y divide-cafe-100">
        {users.map((u) => (
          <form key={u.id} action={saveStaff} className="grid grid-cols-2 items-end gap-2 py-3 sm:grid-cols-[1fr_9rem_8rem_auto_auto]">
            <input type="hidden" name="id" value={u.id} />
            <label className="col-span-2 flex flex-col gap-0.5 sm:col-span-1">
              <span className="text-[11px] font-medium text-cafe-600">Nombre</span>
              <input name="name" defaultValue={u.name} className="input" required />
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-[11px] font-medium text-cafe-600">Rol</span>
              <select name="role" defaultValue={u.role} className="input" disabled={u.id === me.uid}>
                <option value="vendedor">Vendedor</option>
                <option value="admin">Administrador</option>
              </select>
              {/* No te puedes quitar tu propio rol de administrador */}
              {u.id === me.uid && <input type="hidden" name="role" value={u.role} />}
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-[11px] font-medium text-cafe-600">{u.has_pin ? "PIN nuevo (opcional)" : "PIN ⚠️ sin PIN"}</span>
              <input
                name="pin"
                type="password"
                inputMode="numeric"
                pattern="\d{4,6}"
                maxLength={6}
                autoComplete="new-password"
                className={`input ${u.has_pin ? "" : "border-amber-400"}`}
                placeholder={u.has_pin ? "••••" : "4 a 6 números"}
              />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="active" defaultChecked={Boolean(u.active)} disabled={u.id === me.uid} />
              {u.id === me.uid && <input type="hidden" name="active" value="1" />}
              Activo
            </label>
            <div className="flex items-center gap-3">
              <button className="btn-secondary">Guardar</button>
              {u.id !== me.uid && (
                <button formAction={deleteStaff.bind(null, u.id)} formNoValidate className="text-sm text-red-700 underline">
                  Borrar
                </button>
              )}
            </div>
            {isLocked(u.locked_until) && (
              <p className="col-span-2 text-xs text-red-700 sm:col-span-5">🔒 Bloqueado por intentos fallidos. Ponle un PIN nuevo para desbloquear.</p>
            )}
          </form>
        ))}
      </section>

      <form action={saveStaff} className="card grid grid-cols-2 items-end gap-2 sm:grid-cols-[1fr_9rem_8rem_auto]">
        <p className="col-span-2 font-medium sm:col-span-4">➕ Nuevo usuario</p>
        <label className="col-span-2 flex flex-col gap-0.5 sm:col-span-1">
          <span className="text-[11px] font-medium text-cafe-600">Nombre</span>
          <input name="name" className="input" required />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[11px] font-medium text-cafe-600">Rol</span>
          <select name="role" className="input" defaultValue="vendedor">
            <option value="vendedor">Vendedor</option>
            <option value="admin">Administrador</option>
          </select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[11px] font-medium text-cafe-600">PIN</span>
          <input name="pin" type="password" inputMode="numeric" pattern="\d{4,6}" maxLength={6} autoComplete="new-password" className="input" required />
        </label>
        <button className="btn-primary">Agregar</button>
      </form>
    </div>
  );
}
