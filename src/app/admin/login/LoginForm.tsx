"use client";

import { useActionState, useState } from "react";
import { login } from "../actions";

type U = { id: number; name: string; role: string };

export default function LoginForm({ users }: { users: U[] }) {
  const [error, action, pending] = useActionState(login, null);
  const [userId, setUserId] = useState<number | null>(null);
  const [usePassword, setUsePassword] = useState(users.length === 0);
  const user = users.find((u) => u.id === userId);

  if (usePassword) {
    return (
      <form action={action} className="space-y-3">
        <div>
          <label className="label" htmlFor="password">
            Contraseña de administrador
          </label>
          <input id="password" name="password" type="password" className="input" autoFocus required />
        </div>
        {error && <p className="text-sm text-red-700">{error}</p>}
        <button className="btn-primary w-full" disabled={pending}>
          {pending ? "Entrando…" : "Entrar"}
        </button>
        {users.length > 0 && (
          <button type="button" className="w-full text-sm text-cafe-600 underline" onClick={() => setUsePassword(false)}>
            Entrar con mi nombre y PIN
          </button>
        )}
      </form>
    );
  }

  if (!user) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-cafe-600">¿Quién eres?</p>
        <div className="grid grid-cols-2 gap-2">
          {users.map((u) => (
            <button key={u.id} type="button" className="btn-secondary flex-col py-4" onClick={() => setUserId(u.id)}>
              <span className="font-semibold">{u.name}</span>
              <span className="text-xs text-cafe-500">{u.role === "admin" ? "Administrador" : "Vendedor"}</span>
            </button>
          ))}
        </div>
        <button type="button" className="w-full text-sm text-cafe-600 underline" onClick={() => setUsePassword(true)}>
          Usar contraseña de administrador
        </button>
      </div>
    );
  }

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="staff_id" value={user.id} />
      <p className="text-lg font-semibold">Hola, {user.name}</p>
      <div>
        <label className="label" htmlFor="pin">
          Tu PIN
        </label>
        <input
          id="pin"
          name="pin"
          type="password"
          inputMode="numeric"
          pattern="\d{4,6}"
          maxLength={6}
          autoComplete="current-password"
          className="input text-center text-2xl tracking-[0.5em]"
          autoFocus
          required
        />
      </div>
      {error && <p className="text-sm text-red-700">{error}</p>}
      <button className="btn-primary w-full" disabled={pending}>
        {pending ? "Entrando…" : "Entrar"}
      </button>
      <button type="button" className="w-full text-sm text-cafe-600 underline" onClick={() => setUserId(null)}>
        No soy {user.name}
      </button>
    </form>
  );
}
