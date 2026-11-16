import { redirect } from "next/navigation";

/** Masgreen no tiene tienda en línea: la entrada es el panel (caja y administración). */
export default function Home() {
  redirect("/admin");
}
