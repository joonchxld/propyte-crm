# Smoke: reglas de comentarios sociales

Spec: `docs/superpowers/specs/2026-08-04-reglas-comentarios-sociales-design.md`
Plan: `docs/superpowers/plans/2026-08-04-reglas-comentarios-sociales.md`

Feature: un comentario con palabra clave en Instagram o Facebook dispara una
respuesta pública (con variantes rotativas) y un DM privado. Después del DM,
el bot Sage sigue la conversación en el Inbox del CRM. UI en
**Admin → Reglas de comentarios** (`/admin`, tab `comments`).

## Gate de infraestructura (sin esto la feature está dormida, no rota)

Nada de esto lo puede hacer el agente — requiere acceso a Meta App Review y a
la Supabase compartida.

- [ ] Migración `prisma/migrations-manual/2026-08-04-comment-rules.sql` aplicada en
      Supabase `oaijxdpevakashxshhvm` (esquema `propyte_crm`; la aplica Luis).
- [ ] App *CRM Propyte* → Webhooks → objeto `page`: suscribir campo **`feed`**.
- [ ] App *CRM Propyte* → Webhooks → objeto `instagram`: suscribir campo **`comments`**.
- [ ] Acceso Avanzado (App Review) a los 4 permisos: `pages_manage_engagement`,
      `pages_read_engagement`, `instagram_manage_comments`, `instagram_manage_messages`.
- [ ] Conector de Instagram y/o Messenger ACTIVO con `pageAccessToken` vigente
      (Admin → Integraciones).

## Verificación funcional

1. [ ] Admin → Reglas de comentarios carga sin error aun antes de aplicar la
       migración (la tabla no existe todavía → la API detecta `P2021` y
       devuelve lista vacía, no un 500 ni pantalla en blanco).
2. [ ] Crear regla con frase `info`, una respuesta pública y un DM. Toda regla
       **nace en pausa** (`isActive: false` fijo en el POST) — no hay forma de
       crearla ya activa.
3. [ ] Probador: comentario `mándame info` → muestra regla, la variante pública
       (misma rotación que usaría el motor real) y el DM. No llama a Graph:
       imposible publicar algo por accidente desde aquí.
4. [ ] Probador: comentario `informal` → ninguna regla coincide (el match es
       por palabra completa, sin acentos ni mayúsculas — no por substring).
5. [ ] Probador con la regla del paso 2 todavía en pausa → en vez de "ninguna
       regla coincide", avisa explícitamente: *"la regla en pausa
       '\<nombre>' habría disparado con '\<frase>'"*. Así se contesta el
       "¿por qué no disparó?" sin ir a la base de datos.
6. [ ] Con la regla del paso 2 ya **activa**, escribir la misma frase (`info`)
       al crear una segunda regla en la **misma cuenta** → el diálogo la marca
       como choque *mientras se escribe* (antes de guardar). Si se ignora y se
       guarda igual, la API responde **409** y la segunda regla no se crea.
7. [ ] Activar la regla (botón de pausa/play en la lista). Comentar `info`
       desde una cuenta personal en un post real.
8. [ ] Aparece la respuesta pública en el post y llega el DM privado. Son
       **acciones independientes**: una puede terminar `SENT` y la otra
       `FAILED` sin que una condicione a la otra (ver paso 8b más abajo para
       forzarlo).
9. [ ] El log (debajo del probador, mismo tab) muestra la fila con badge
       "público: SENT" y "DM: SENT" por separado. El botón **"ID del post"**
       copia el `postId` al portapapeles. El link **"Ver publicación"** solo
       aparece si la plataforma es **Facebook** — en Instagram no hay URL
       construible a partir del `media_id` que manda el webhook (usa
       shortcode, no ese id).
10. [ ] Comentar `info` otra vez en el MISMO post con la MISMA cuenta → el log
        registra **SKIPPED** en público y en DM (cuota: una respuesta por
        persona por publicación) y no se publica nada nuevo.
11. [ ] Comentar `info` en OTRO post → sí responde (la cuota es por
        publicación, no por cuenta).
12. [ ] Responder el DM desde la cuenta personal → se crea el contacto, el
        hilo aparece en el Inbox en estado **BOT**, con el opener (el DM que
        mandó la regla) antes de la respuesta del cliente, y el bot contesta.
13. [ ] El log de ese comentario ya muestra el contacto vinculado (link a
        `/contacts/[id]`).
14. [ ] Contacto → Cronología: aparece la nota "Origen: comentario en la
        publicación …".
15. [ ] Comentar una respuesta anidada (reply a otro comentario) con `info` →
        no se responde. Se detecta distinto por plataforma: en Facebook
        cuando `parent_id` difiere de `post_id` (en primer nivel vienen
        iguales); en Instagram cuando el comentario trae `parent_id`.
16. [ ] Comentar `info` **desde la propia cuenta** de la Página/IG Business
        (anti-loop: el eco de la respuesta pública vuelve como comentario
        nuevo) → se ignora sin crear log ni respuestas.
17. [ ] Provocar (o esperar) que solo una de las dos acciones falle — por
        ejemplo revocando temporalmente un permiso — y confirmar que el log
        muestra público `FAILED` con DM `SENT` (o viceversa), cada uno con su
        propio texto de error, y aparece el botón **Reintentar** en esa fila.
18. [ ] Con una fila con algo `FAILED`, click **Reintentar** → reintenta solo
        la(s) acción(es) fallida(s) reusando el texto **exacto** que ya se
        guardó (no genera otra variante ni recalcula el DM).
18b. [ ] Caso `PENDING` — si algún día ves un registro así (no es reproducible
        a voluntad: requiere matar el worker a mitad de la llamada a Graph,
        p. ej. un restart del proceso justo después de reclamar la acción).
        En el log se ve igual que cualquier otro estado: badge "público:
        PENDING" o "DM: PENDING" en `STATUS_BADGE` (mismo gris que
        `SKIPPED`, no hay color de alerta propio). Con el filtro "Solo
        pendientes o fallidos" activado, la fila aparece — antes de este fix
        un log así solo era visible hojeando todas las páginas sin filtro.
        El botón **Reintentar** aparece igual que para `FAILED`, pero su
        `title` (y el texto del botón, "Reintentar (puede duplicar)") avisa
        que puede duplicar el envío: a diferencia de `FAILED`, no hay
        certeza de que el proceso original nunca haya llegado a llamar a
        Graph.
19. [ ] El campo "Publicaciones" del formulario de regla **solo acepta IDs**,
        no URLs — pegar una URL no la resuelve. El ID de un post aparece en
        el log en cuanto llega su primer comentario; se copia con el botón
        del paso 9 y se pega ahí.
20. [ ] REGRESIÓN: mandar un DM normal (sin venir de un comentario) a la
        cuenta → sigue entrando al Inbox como siempre.

### Dónde mirar los comentarios descartados

El mismo endpoint que recibe los DMs (`/api/webhooks/meta-dm` — Meta solo
permite una callback URL por objeto) recibe también los comentarios. Cuando
un comentario SÍ pasa el filtro de objeto/campo pero le falta un dato
obligatorio (típicamente `from`, que Meta omite cuando el autor bloqueó la
Página, cuando falta el permiso `pages_read_engagement`, o cuando la cuenta
del autor fue borrada), el webhook emite un `console.warn` — uno por cada
descarte, con la razón, la plataforma, la cuenta y el id del comentario si se
alcanzó a leer:

```
[meta-dm] comentario descartado (sin-autor) platform=INSTAGRAM account=... comment=...
```

- [ ] Revisar los logs de runtime de `crm.propyte.com` (VPS: `docker compose -f /opt/propyte/crm/docker-compose.yml logs`) filtrando
      por `[meta-dm] comentario descartado` para confirmar que no se están
      perdiendo comentarios de clientes reales en silencio. No hay contador
      en la UI todavía — solo el log del servidor.

## Riesgos aceptados

Documentados en el spec (`2026-08-04-reglas-comentarios-sociales-design.md`,
sección "Riesgos aceptados (code review, 2026-08-05)"). Si aparecen durante
el smoke, **no es un bug** — ya se evaluó y se decidió no cerrarlos ahora:

- **Carrera de cuota entre webhooks distintos.** Si Meta entrega dos
  comentarios **distintos** de la misma persona en el mismo post en dos
  peticiones HTTP separadas casi simultáneas, ambos pueden pasar el chequeo
  de cuota antes de que cualquiera cree su log. Pasado ese chequeo, la
  respuesta pública y el DM se ejecutan siempre para cada uno — no es solo
  la respuesta pública repetida: la persona recibe **dos DMs de apertura**,
  porque el límite de "una vez" de Meta es por comentario, no por
  destinatario. Dentro de un mismo batch no pasa (se procesa en serie).
  Probabilidad baja; consecuencia visible pero benigna (una respuesta
  pública y un DM de apertura de más, sin daño de datos).
- **Presupuesto de tiempo del batch.** El webhook tiene `maxDuration = 30`;
  cada comentario puede hacer hasta dos llamadas a Graph de 8 s de timeout
  en serie. Con un batch de 2+ comentarios y Graph colgado (no fallando
  rápido) en ambas llamadas, la función puede morir a mitad del bucle y los
  comentarios restantes se pierden sin log. Probabilidad baja: requiere que
  Graph llegue al timeout, no que falle rápido.
- **Reintento manual sobre un log en `PENDING` puede duplicar el envío.**
  Ver el paso de smoke dedicado más abajo ("Caso PENDING") y la fila
  correspondiente en el spec.
