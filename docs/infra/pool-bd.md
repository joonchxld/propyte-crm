# Pool de conexiones a la base de datos (tarjeta 974)

## Qué pasa

Algunas pantallas (Hoy, Administración, Huérfanos) fallan a veces con:

    EMAXCONNSESSION ... pool_size: 15

El CRM se conecta a Supabase por el **pooler en modo sesión (puerto 5432)**. En ese modo cada
conexión que abre el CRM queda reservada mientras el proceso vive, y el máximo del pooler es **15**.

Desde el 2026-11-06 el CRM corre en el **VPS de Hostinger, en 2 contenedores de Docker**
(`propyte-crm-1` y `propyte-crm-2`; ver `docs/infra/vps.md`). Cada contenedor es un proceso de
Node con su propio pool de Prisma del tamaño de `connection_limit` en `DATABASE_URL`: con `5`
son 10 conexiones. (Antes corría en hPanel con Passenger, que podía tener 3 procesos = 15, el
tope.) **Mientras la app vieja de hPanel siga encendida, sus procesos pueden tener conexiones
abiertas también**: detenerla libera ese margen. Si además una pantalla lanza 11–13 consultas a
la vez, se piden todas juntas.

## Qué arregla el código (este PR)

- Hoy, Administración y Huérfanos piden sus datos en tandas de 4 (o 2) en vez de todas a la vez.
- El cliente de Prisma se reutiliza siempre (no se crea uno nuevo si el módulo se recarga).

## Qué hacer en infraestructura (Luis)

**No pasar al puerto 6543 (modo transacción).** En junio de 2026 ese pooler se quedó trabado de
forma permanente (`ECHECKOUTTIMEOUT`) y por eso el CRM está en 5432.

### Paso 1. Bajar `connection_limit` a 3

1. En el VPS: `nano /opt/propyte/crm/shared/.env`.
2. En `DATABASE_URL`, cambia `connection_limit=5` por `connection_limit=3`. No toques nada más
   de la URL.
3. Guarda y redespliega: `/opt/propyte/crm/deploy.sh main`. Las variables solo se leen al
   arrancar.

Así los 2 contenedores usan 6 conexiones y quedan 9 para el Hub, scripts y picos.

### Paso 2 (solo si vuelve a pasar). Subir el tamaño del pool en Supabase

Supabase > proyecto > **Database > Settings > Connection pooling > Pool size**. El máximo
depende del tamaño de la instancia. Subirlo da más margen a todos los que usan el pooler.

### Si algo falla

- Si aparece «Timed out fetching a new connection from the connection pool», sube a
  `connection_limit=4`.
- Para volver atrás, pon de nuevo `connection_limit=5` y corre `deploy.sh main`.
