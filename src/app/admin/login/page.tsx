import { all } from "@/lib/db";
import LoginForm from "./LoginForm";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  // Solo aparecen los usuarios activos que ya tienen PIN
  const users = await all<{ id: number; name: string; role: string }>(
    "SELECT id, name, role FROM staff WHERE active = 1 AND pin_hash <> '' ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, name",
  );
  return (
    <main className="flex flex-1 items-center justify-center p-4">
      <div className="card w-full max-w-sm space-y-4">
        <h1 className="text-xl font-semibold">Entrar</h1>
        <LoginForm users={users} />
      </div>
    </main>
  );
}
