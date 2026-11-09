# QA smoke — Inbox social (Instagram DM + Messenger)

> Checklist E2E para validar la feature **en producción tras el merge + configuración de Meta**.
> La lógica unitaria ya está cubierta por la suite vitest (136 tests). Esto es el smoke que requiere config Meta viva.
>
> ⚠️ **No tiene sentido correr §1–§10 hasta que el PR esté mergeado Y el conector Meta esté configurado.** Una auditoría previa contra prod sin el deploy reportó "no existe el conector / filtro / webhook" — era porque la feature aún no estaba desplegada.

## 0. Prerrequisitos
- [ ] PR `feat/crm-inbox-social` **mergeado a main** y deploy confirmado (VPS: `tail /var/log/crm-deploy.log`).
- [ ] Conector IG/Messenger creado y **ACTIVE** en Admin → Integraciones (pageAccessToken/appSecret/pageId).
- [ ] Env vars `META_DM_VERIFY_TOKEN` + `META_DM_APP_SECRET` en el .env del VPS (`/opt/propyte/crm/shared/.env`).
- [ ] Webhook Meta suscrito al field `messages` (objetos `instagram` y `page`), callback `https://crm.propyte.com/api/webhooks/meta-dm`.
- [ ] IG profesional vinculada a la página FB.

## 1. Seguridad del webhook
- [ ] `GET …/meta-dm?hub.mode=subscribe&hub.verify_token=<token correcto>&hub.challenge=123` → responde `123` (**200**).
- [ ] Mismo GET con token incorrecto → **403**.
- [ ] `POST` con firma `x-hub-signature-256` **inválida** (con `META_DM_APP_SECRET` configurado) → **401**.
- [ ] `POST` con `object` desconocido → **200** `{processed:0}`.

> 🔴 **GATE DE INFRA (riesgo real, Grupo B de la auditoría):** una ruta inexistente en Hostinger devuelve **403 uniforme** (incluso a POST) desde el CDN/host, no desde la app. Tras el deploy, confirmar que el `POST` de Meta **llega al handler** (debe dar 401 con firma mala, no 403 genérico) y que el CDN `hcdn` **no bloquea** el POST. El webhook usa `x-hub-signature-256` (no `Authorization`), así que el stripping de header conocido no aplica — pero validar en vivo con el "Test" del panel de Meta. _(Esto era con hPanel y su CDN `hcdn`. Desde 2026-11 el CRM corre en el VPS detrás de Caddy, sin CDN: una ruta inexistente da el 404 de Next.)_

## 2. Recepción Instagram
- [ ] DM a la cuenta IG desde una cuenta personal → **conversación nueva en `/inbox`** con badge **Instagram**.
- [ ] Se crea **Contact** (lead) con `instagramId`, nombre del perfil, asignado por ruteo, con **SLA de primer contacto** corriendo.
- [ ] Reintento de Meta del mismo mensaje **no duplica** (dedup por `externalMessageId`).

## 3. Recepción Messenger
- [ ] Mensaje a la página FB → conversación con badge **Messenger**, lead con `messengerPsid`.

## 4. Identidad / dedup
- [ ] 2º DM del mismo usuario IG → **misma conversación/contacto** (match por `instagramId`), sin duplicar.
- [ ] Contacto que ya existe por teléfono y escribe por IG → crea contacto nuevo (en v1 **no** hay match cross-canal). `/duplicados` solo une si comparten tel/email.

## 5. Envío manual desde el inbox
- [ ] Takeover + responder por IG **dentro de la ventana de 24h** → llega; OUTBOUND con badge Instagram; `Activity INSTAGRAM_OUT`.
- [ ] Responder **fuera de la ventana de 24h** → error claro (**422** con mensaje de Graph), **no** 500/pantalla blanca.
- [ ] Nota interna (toggle del composer) → se guarda y **no** se envía al cliente.

## 6. Bot IA
- [ ] Conversación en **BOT**: DM entrante → el bot responde solo por IG con guardarraíles.
- [ ] El mensaje del bot queda con `sender:BOT` (`aiGenerated`).
- [ ] **Takeover** humano → el bot deja de responder ese hilo.

## 7. No-regresión WhatsApp (CRÍTICO — prod)
- [ ] WhatsApp entrante de contacto **existente** → hace match (no duplica), conversación WhatsApp, bot responde si BOT.
- [ ] Enviar **"BAJA"** por WhatsApp → marca opt-out; el bot no vuelve a responder.
- [ ] Contacto con opt-out manda mensaje normal → el bot **no** responde.
- [ ] `AutomationRule` que escuche `whatsapp.replied` **sigue disparándose**.
- [ ] Mensaje del bot por WhatsApp marcado como **BOT**.

## 8. Inbox UI
- [ ] Filtro por canal (Todos / WhatsApp / Instagram / Messenger) filtra la lista.
- [ ] Badge de canal visible por conversación.

## 9. Admin
- [ ] Provider **Instagram/Messenger** disponible al crear conector; el hint muestra **`/api/webhooks/meta-dm`**.
- [ ] Credenciales se guardan cifradas; conector queda ACTIVE.

## 10. Integridad de datos (BD)
- [ ] `messages`: inbound social con `externalMessageId` y `externalPhone` **null**; inbound WhatsApp con `externalPhone` poblado.
- [ ] `activities`: tipos `INSTAGRAM_IN/OUT`, `MESSENGER_IN/OUT`.

## 11. Reglas de comentarios → DM → Inbox (flujo nuevo)
> El DM que dispara una regla de comentarios ya no espera a que la persona conteste
> para existir: el contacto y el hilo se crean en el momento del envío.

- [ ] Comentar la palabra clave de una regla activa desde una cuenta que **no** es contacto del CRM → llega la respuesta pública **y** el DM.
- [ ] El hilo aparece en el **Inbox** de inmediato, con el DM como primer mensaje marcado **BOT** (no ADVISOR) y la conversación en **BOT**.
- [ ] El contacto nuevo aparece **sin dueño**, con `leadSourceDetail` = `comentario:<postId>` y apellido `(por identificar)`.
- [ ] **No** se creó SLA de primer toque, **no** hubo notificación de "lead asignado" y **no** salió evento `Lead` a Meta CAPI.
- [ ] La cronología del contacto tiene **una sola** nota `Origen: comentario en la publicación …`.
- [ ] El `CommentRuleLog` queda con `dmStatus: SENT` y `contactId` poblado (Admin → Comentarios).
- [ ] **La persona responde el DM** → el contacto queda **asignado** (round-robin), se crea el SLA `FIRST_TOUCH`, llega la notificación al asesor y la etapa sube a **MQL**.
- [ ] Sigue **sin** salir evento `Lead` a Meta CAPI tras la respuesta (decisión de producto).
- [ ] Segundo mensaje de la misma persona → **no** se re-asigna ni duplica la nota de origen.
- [ ] El bot (Sage) sigue respondiendo tras la respuesta: el eco del propio DM **no** disparó el takeover.
- [ ] `AutomationRule` que escuche `social.replied` se dispara con un inbound de IG/Messenger; la que escuche `whatsapp.replied` **no**.
