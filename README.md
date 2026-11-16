# Masgreen — Punto de venta, inventario y finanzas

Basado en el sistema de Café Allison, sin tienda en línea, pagos con Stripe, envíos a domicilio
(reparto y repartidores) ni pedidos programados.

**Panel** (`/admin`, la página principal manda ahí)
- **Punto de venta**: varios pedidos abiertos en pestañas, buscador tolerante a errores, cobro en efectivo,
  tarjeta (terminal) o transferencia, impresión de tickets y cajón.
- **Pedidos**: ventas del día, cambio de estado, cancelar y reimprimir.
- **Menú**: productos con tamaños, costo, días de venta y foto desde el celular (Vercel Blob). Empieza vacío.
- **Corte de caja**: fondo inicial, entradas/salidas, efectivo esperado contra contado e historial.
- **Inventario**, **Gastos** y **Finanzas**.
- **Programa de lealtad** en la caja (1 sello por día; con 10, bebida gratis).
- **Avisos al celular con ntfy** y **impresora de tickets** (Bluetooth, USB, RawBT o navegador).

## Variables de entorno (Vercel → Settings → Environment Variables)
- `DATABASE_URL`: base de datos Postgres (Neon). Sin ella se usa una base temporal que se borra.
- `ADMIN_PASSWORD`: contraseña del panel.
- `BLOB_READ_WRITE_TOKEN`: se agrega sola al conectar un Blob store (para fotos del menú).
- `SESSION_SECRET` (opcional): clave para firmar sesiones.

## En tu computadora
```bash
npm install
npm run dev   # http://localhost:3000 (contraseña en desarrollo: admin)
```
