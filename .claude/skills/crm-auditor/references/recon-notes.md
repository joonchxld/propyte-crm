# recon-notes — hechos reales del CRM (2026-07-10)

> Extraído leyendo código en el worktree `feat/crm-auditor` (origin/main al momento del corte). Repo real: `Propyte-Team/propyte-crm`. Toda afirmación cita archivo:línea. Donde no se encontró evidencia en código se marca explícitamente **"no encontrado"** — no hay valores inventados.

## 1. Rutas por sección

App Router con grupo `(dashboard)` — **los paréntesis NO forman parte de la URL**: `src/app/(dashboard)/contacts/page.tsx` sirve `/contacts`, no `/dashboard/contacts`. Esto es relevante para la sección 2 (el middleware asume lo contrario).

| Sección | Ruta URL real | Archivo |
|---|---|---|
| Dashboard | `/dashboard` | `src/app/(dashboard)/dashboard/page.tsx` |
| Inbox / WhatsApp | `/inbox` | `src/app/(dashboard)/inbox/page.tsx` |
| Kanban / Deals (pipeline) | `/pipeline` (lista) · `/pipeline/[id]` (detalle) | `src/app/(dashboard)/pipeline/page.tsx` · `src/app/(dashboard)/pipeline/[id]/page.tsx` |
| Contactos / Leads | `/contacts` (lista) · `/contacts/[id]` (detalle) | `src/app/(dashboard)/contacts/page.tsx` · `src/app/(dashboard)/contacts/[id]/page.tsx` |
| Cotizador / Quotes | `/cotizaciones` | `src/app/(dashboard)/cotizaciones/page.tsx` |
| Meta-leads | **No existe en este repo.** Comentario explícito en el schema: la reconciliación Meta↔Zoho se retiró del CRM y "vive en el Hub (`/meta-leads`, tabla `real_estate_hub.meta_leads`)" — `prisma/schema.prisma:1116-1119`. Confirmado por grep sin resultados de `"meta-leads"` en `src/`. Lo más cercano en este repo es **Conexiones** (`/conexiones`, gestión de `LeadConnector` incl. provider `META`). |
| Settings / Perfiles | `/settings` ("Mi Config", perfil propio — `UserProfile`) · `/configuracion` ("Centro de Configuración" estilo Zoho Settings, org-wide) | `src/app/(dashboard)/settings/page.tsx` · `src/app/(dashboard)/configuracion/page.tsx` |
| Admin / Integraciones | `/admin` (usuarios, reglas de comisión, config, webhooks, API keys) · `/conexiones` (conectores de leads Meta/TikTok/Web) | `src/app/(dashboard)/admin/page.tsx` · `src/app/(dashboard)/conexiones/page.tsx` |
| Reportes | `/reports` | `src/app/(dashboard)/reports/page.tsx` |

Otras rutas del mismo grupo (no pedidas explícitamente pero relevantes para playbooks): `/activities`, `/career` (huérfano histórico, ver §7), `/cobranza`, `/commissions`, `/developments` (+ `/developments/[id]`), `/duplicados`, `/hoy`, `/journey`, `/metas`, `/walk-ins`.

Fuera del grupo `(dashboard)`: `/login` (`src/app/(auth)/login/page.tsx`), `/portal` + `/portal/developments/[id]` (portal de developer externo), `/p/[token]` (shortlist pública), `/q/[id]` (cotización pública), `/t/[slug]` (+`/qr`, `/vcard`, tarjeta digital pública).

## 2. Roles (enum) y gating por rol

**Enum real** `UserRole` (`prisma/schema.prisma:21-37`):
```
ADMIN, ASESOR, BROKER, MANTENIMIENTO,
// Legacy roles (mantener por compatibilidad hasta migración completa):
DIRECTOR, GERENTE, TEAM_LEADER, ASESOR_SR, ASESOR_JR, HOSTESS, MARKETING, DEVELOPER_EXT
```
El comentario del propio schema dice que los 4 primeros (`ADMIN, ASESOR, BROKER, MANTENIMIENTO`) son el set canónico destino y el resto son "legacy... hasta migración completa" — pero **toda la app hoy gatea con los roles legacy** (ver abajo), no con el set canónico. Migración de roles en curso, no completada.

**Gating real está en 3 capas distintas y NO están alineadas entre sí:**

1. **`src/middleware.ts`** (NextAuth `withAuth`) — protege por `matcher` (líneas 50-70): `/dashboard/:path*`, `/portal/:path*`, y varios prefijos `/api/*`. **Hallazgo estructural:** por el punto §1 (route group), `/dashboard/:path*` sólo cubre la URL literal `/dashboard` — NINGUNA de `/contacts`, `/pipeline`, `/admin`, `/settings`, `/configuracion`, `/reports`, etc. vive bajo `/dashboard/*`. Los checks internos de rol en el middleware para `/dashboard/admin` (línea 24) y `/dashboard/plazas` (línea 32) son código muerto: esas URLs no existen (la real es `/admin`; no existe página `/plazas` en absoluto — confirmado por `Glob` de `page.tsx`). El middleware SÍ protege el portal (`DEVELOPER_EXT`/`ADMIN` — línea 18) y los prefijos de API listados, que son rutas reales.

2. **Cada `page.tsx` hace su propio check server-side** (`getServerSession()` + `redirect()`), y es la capa que realmente protege. Dos patrones distintos:
   - **Con allowlist de rol** (además de exigir sesión): `admin/page.tsx:13` → `["ADMIN","DIRECTOR","GERENTE"]`; `configuracion/page.tsx:9` → `["ADMIN","DIRECTOR","GERENTE"]`; `duplicados/page.tsx:7` → `["ADMIN","DIRECTOR","DEVELOPER_EXT","MANTENIMIENTO"]`; `journey/page.tsx:7` → `["ADMIN","DIRECTOR"]`; `conexiones/page.tsx:6` → `["ADMIN","DIRECTOR","GERENTE","MARKETING"]`.
   - **Sólo exige sesión, sin allowlist de rol** (cualquier usuario autenticado puede navegar ahí por URL directa, independientemente de si el sidebar le muestra el link): `dashboard`, `inbox`, `career`, `metas`, `walk-ins`, `cotizaciones`, `contacts` (+ `[id]`), `reports`, `developments`, `hoy`, `settings`, `cobranza`, `commissions`, `pipeline` (+ `[id]`), `activities`. Confirmado por grep de `getServerSession|redirect` en `src/app/(dashboard)/**` — estos archivos sólo tienen el patrón `if (!session?.user) redirect("/login")`, sin segundo `if`.
   - **Hallazgo (permiso-gap real):** `/duplicados` es accesible por URL directa para `DEVELOPER_EXT` y `MANTENIMIENTO`, pero el sidebar (ver abajo) NO les muestra ningún link a esa página (de hecho no les muestra prácticamente nada — ver siguiente hallazgo). Es acceso "de más" respecto al menú, no una brecha de seguridad, pero es inconsistencia UI↔permiso real.
   - **Hallazgo (permiso-gap potencial, a verificar con negative-testing real):** roles como `HOSTESS`, `BROKER`, `ASESOR_JR` pueden navegar por URL directa a `/reports`, `/commissions`, `/cobranza`, etc. aunque el sidebar no les muestre esos links. Si la página carga datos sin scoping por rol, ven de más. **Verificado que SÍ hay scoping a nivel de datos en al menos un módulo:** `src/server/deals.ts:56-96` implementa `FULL_ACCESS_ROLES` / `PLAZA_ACCESS_ROLES` / `TEAM_ACCESS_ROLES` / scope "own" por `assignedToId`. No se verificó (sin acceso a runtime) si `reports`, `commissions`, `cobranza` aplican el mismo scoping — **candidato prioritario para el playbook `sistemas-qa.md` (negative testing real contra la app en vivo — el código no permite confirmarlo).**

3. **`src/components/layout/sidebar.tsx:35-77`** — sólo controla qué **links se muestran**, no es un gate de seguridad. Usa los roles legacy reales (comentario propio: "Roles alineados al enum UserRole de Prisma", línea 33). `ADMIN` ve todo sin filtro (línea 123: `userRole === "ADMIN" || item.roles.includes(userRole)`). Grupos y roles exactos:
   - Sin título: Hoy, Dashboard → `TODOS`; Inbox → `TODOS` menos `ASESOR_JR`... no, Inbox roles = `["DIRECTOR","GERENTE","TEAM_LEADER","ASESOR","ASESOR_SR","ASESOR_JR","MARKETING"]` (falta `BROKER`/`HOSTESS`).
   - Ventas: Contactos → `TODOS`; Pipeline → `TODOS` menos `HOSTESS`,`MARKETING` (pero incluye `BROKER`); Cotizaciones → `TODOS` menos `HOSTESS`,`MARKETING` (incluye `BROKER`); Desarrollos → `TODOS` menos `HOSTESS` (incluye `BROKER`,`MARKETING`); Walk-ins → sólo `["DIRECTOR","GERENTE","HOSTESS"]`.
   - Desempeño: Comisiones/Cobranza/Metas → asesores+liderazgo (sin `HOSTESS`,`MARKETING`); Reportes → `["DIRECTOR","GERENTE","TEAM_LEADER","MARKETING"]`; Mi Carrera → `["TEAM_LEADER",...ASESORES]`.
   - Sistema: Mi Config → `TODOS`; Configuración/Admin → `["DIRECTOR","GERENTE"]`; Journey/Duplicados → `["ADMIN","DIRECTOR"]`; Conexiones → `["ADMIN","DIRECTOR","GERENTE","MARKETING"]`.
   - **`TODOS` = `["DIRECTOR","GERENTE","TEAM_LEADER","ASESOR","ASESOR_SR","ASESOR_JR","BROKER","HOSTESS","MARKETING"]` (sidebar.tsx:36). No incluye `MANTENIMIENTO` ni `DEVELOPER_EXT`.**
   - **Hallazgo (permiso-gap real, alto impacto potencial):** ningún `item.roles` en todo `navGroups` incluye `MANTENIMIENTO`. Un usuario `MANTENIMIENTO` (rol canónico activo, no legacy) vería el **sidebar completamente vacío** (todas las secciones se filtran a `items.length === 0` y no se renderizan — línea 124) salvo que sea `ADMIN`. Mismo problema histórico que ya se dio con `TEAM_LEADER` antes del fix documentado en `docs/audit-2026-06-10/AUDIT.md`. `DEVELOPER_EXT` no tiene este problema porque su superficie real es `/portal` (layout y middleware distintos), no el dashboard con sidebar.

**`src/lib/auth/rbac.ts` es código muerto / desalineado — no usar como fuente de verdad.** Define un vocabulario de roles completamente distinto (`VIEWER, SDR, SALES_REP, CLOSER, MARKETING, TEAM_LEAD, MANAGER, ADMIN, SUPER_ADMIN` — `rbac.ts:6-16`) que **no corresponde a ningún valor real del enum `UserRole`** (no existen `SDR`, `SALES_REP`, `CLOSER`, `TEAM_LEAD`, `MANAGER`, `SUPER_ADMIN`, `VIEWER` en Prisma). Verificado con grep de `canAccessResource|hasMinimumRole|getDataScope|filterByAccess` en todo `src/`: **cero imports/usos** fuera del propio archivo. No lo cites en playbooks como mecanismo real de permisos.

## 3. Tipos de contacto y catálogo de orígenes

**Enum `ContactType`** (`prisma/schema.prisma:60-72`), default `COMPRADOR` (`Contact.contactType`, línea 694):
`LEAD, PROSPECTO, CLIENTE, INVERSIONISTA, BROKER_EXTERNO, REFERIDO, EMPLEO, COMPRADOR, REFERIDOR`.
Labels ES en `src/lib/constants.ts:309-319` (`CONTACT_TYPE_LABELS`) — completo, cubre los 9 valores.

**Enum `LeadSource`** (`prisma/schema.prisma:75-100`), campo obligatorio `Contact.leadSource` (línea 695, sin default):
`WALK_IN, FACEBOOK_ADS, GOOGLE_ADS, INSTAGRAM, TIKTOK_ADS, PORTAL_INMOBILIARIO, REFERIDO_CLIENTE, REFERIDO_BROKER, LLAMADA_FRIA, EVENTO, WEBSITE, WHATSAPP, MESSENGER, META_ADS, BASE_DE_DATOS, SELF_GEN, REGISTRO_BROKER, WEBINAR, LINKEDIN, OTRO, LLAMADA_ENTRANTE` (21 valores; los últimos 8 —desde `META_ADS`— se agregaron en el cutover de Zoho, comentario línea 89).

**Hallazgo (bug de UI real, relevante para el journey "identificar origen" del Asesor):** los mapas de labels ES para `LeadSource` están **triplicados y desincronizados** — sólo cubren 12 de los 21 valores del enum:
- `src/lib/constants.ts:188-201` (`LEAD_SOURCE_LABELS`)
- `src/components/contacts/contacts-list.tsx:79-92` (`SOURCE_LABEL`, copia local)
- `src/components/contacts/contact-detail.tsx:48-53` (copia local análoga)

Todos omiten: `TIKTOK_ADS, MESSENGER, META_ADS, BASE_DE_DATOS, SELF_GEN, REGISTRO_BROKER, WEBINAR, LINKEDIN, LLAMADA_ENTRANTE`. `report-viewer.tsx:165` hace fallback (`LEAD_SOURCE_LABELS[row.leadSource] ?? row.leadSource`), pero no está confirmado que `contacts-list.tsx`/`contact-detail.tsx` hagan el mismo fallback — a verificar visualmente en el journey del Asesor con un lead QA de origen `TIKTOK_ADS` o `META_ADS` (si no hay fallback, se rompe el render o muestra `undefined`).

**Cómo se puebla `leadSource` en intake real** (`src/lib/intake/connectors.ts:131-142`, mapa `PROVIDER_SOURCE`) — default por `ConnectorProvider` si la regla de mapeo no trae un `source` válido:
```
META → FACEBOOK_ADS
INSTAGRAM → INSTAGRAM
MESSENGER → MESSENGER
TIKTOK → TIKTOK_ADS
GOOGLE_ADS → GOOGLE_ADS
LINKEDIN → LINKEDIN
(cualquier otro / sin match) → WEBSITE
```
Es decir: un lead real de **Meta Lead Ads** entra por defecto con `leadSource = FACEBOOK_ADS` (no `META_ADS` — ese valor es el legado de Zoho, distinto canal). Esto es el valor a usar para la dimensión "Lead nuevo por origen: Meta Lead Ads" del playbook Asesor. El default es overrideable por `LeadConnector.config.defaultLeadSource` o por regla de mapeo (`fieldMap`) — dato de runtime, no verificable desde código estático.

**Catálogo de conectores** (`ConnectorProvider`, `prisma/schema.prisma:544-565`): `META, INSTAGRAM, MESSENGER, TIKTOK, WEBSITE, ZAPIER, MANUAL, GOOGLE, LINKEDIN, INMUEBLES24, LAMUDI_PROPPIT, PROPIEDADES, VIVANUNCIOS, EASYBROKER, GOOGLE_ADS, YOUTUBE, PINTEREST, CUSTOM`. Se gestionan en `/conexiones` (§1).

## 4. Mecanismo de tags (o fallback elegido)

**SÍ existe y SÍ está funcional — el plan/spec original asumía que no existía; es incorrecto. No usar el fallback de nombre+fuente; usar el tag real.**

- Campo: `Contact.tags String[]` (`prisma/schema.prisma:718`), default `[]`. Es texto libre (no hay catálogo/enum de tags, ni modelo `Tag` separado).
- **Expuesto en UI:** `src/components/contacts/contact-form.tsx:691-695` — campo "Etiquetas (separadas por coma)", input de texto que se parsea a array por comas (línea 227-235). Visible en `contact-detail.tsx:425-426` como chips.
- **Validado:** `z.array(z.string().max(50)).max(20)` en tres sitios (`src/server/contacts.ts:47`, `src/components/contacts/contact-form.tsx:57`, `src/app/api/contacts/route.ts:52`, `src/lib/validations/contact.ts:111`).
- **Persistido:** `src/server/contacts.ts:307,392` y `src/app/api/contacts/route.ts:297,423` (create/update).
- **Se puede asignar también por automatización:** acción de workflow `ADD_TAG` (enum `WorkflowActionType`, `prisma/schema.prisma:484`) implementada en `src/lib/workflows/actions.ts:144-145` (`prisma.contact.update({ data: { tags: { push: tag } } })`, con guarda de duplicado/tag vacío).
- **Se puede evaluar en condiciones de reglas:** `src/lib/workflows/evaluate-conditions.ts` soporta `field: "contact.tags", op: "contains"` (cubierto por test `evaluate-conditions.test.ts:27`).
- **Entrada externa (Zapier) también acepta tags:** `src/app/api/webhooks/zapier/contacts/route.ts:21,47`.

**Mecanismo elegido para el marcador QA:** usar el tag real `QA_AUDIT` (o `QA-AUDIT`, cuidando el máx. 50 chars / 20 tags) vía el campo `tags` del formulario/API de Contacto — **no** se necesita el fallback de prefijo de nombre. Se puede combinar de todos modos con prefijo `QA-<rol>-<timestamp>` en el nombre para doble señal (regla del safety-contract), pero el tag es el mecanismo primario real y disponible hoy.

## 5. Provisioning de usuarios (+ ADMIN temporal)

**No existe una herramienta MCP para crear usuarios.** Verificado en `src/lib/mcp/dispatch.ts:16`: la única ruta relacionada a usuarios expuesta por `propyte-crm-mcp` (vía `/api/mcp/[...path]`) es `"GET /users": intro.listUsers()` — **sólo lectura**. No hay `POST /users` ni ruta de creación. El plan original asumía "vía propyte-crm-mcp (admin) o seed script" como si fueran alternativas equivalentes; en realidad el MCP no puede crear usuarios en absoluto.

**Mecanismos reales de alta de usuario (2, con roles permitidos distintos):**

1. **UI Admin en producción** (`/admin` → `src/components/admin/admin-content.tsx:154` → server action `createUser` en `src/server/admin.ts:178-232`). Requiere sesión con rol `ADMIN|DIRECTOR|GERENTE` (`requireAdminRole`, `src/server/admin.ts:17-31`). **Restricción crítica y no documentada en el plan:** el esquema Zod `createUserSchema.role` (`src/server/admin.ts:41-50`) sólo acepta:
   ```
   DIRECTOR, GERENTE, TEAM_LEADER, ASESOR_SR, ASESOR_JR, HOSTESS, MARKETING, DEVELOPER_EXT
   ```
   **Es decir: NO se puede crear `ADMIN`, `ASESOR` (plano), `BROKER` ni `MANTENIMIENTO` desde la UI.** No es un "clasificador de seguridad" heurístico como especulaba el spec — es un enum Zod codificado. Para provisionar un rol `qa-asesor` habría que usar `ASESOR_SR` o `ASESOR_JR` (sí permitidos vía UI) en vez de `ASESOR` plano, o usar la vía 2.
2. **Scripts directos contra la BD** (`npx tsx scripts/<archivo>.ts`, usan `PrismaClient`/`prisma.user.create` sin pasar por el Zod de arriba — pueden setear cualquier rol del enum, incluido `ADMIN`/`ASESOR`/`BROKER`/`MANTENIMIENTO`): `scripts/seed-admin-users.ts` (crea/actualiza ADMIN), `scripts/create-user-marketing.ts` (rol `MARKETING`), `scripts/seed-mcp-user.ts` (usuario de sistema `mcp@propyte.local`, rol `ADMIN`, password inutilizable a propósito), `scripts/seed-agentes.ts` (usuario de sistema `agentes@propyte.local`, rol `ASESOR`).

**Columnas `NOT NULL` reales al insertar `User`** (`prisma/schema.prisma:625-643`): `email` (único), `name`, `role`, `plaza`, `passwordHash`. `id` y `updatedAt` los gestiona Prisma automáticamente (`@default(uuid())` / `@updatedAt`); `careerLevel` tiene default `JR`; el resto son opcionales.

**Enum `Plaza`** (`prisma/schema.prisma:51-57`): `PDC, TULUM, MERIDA`.

**ADMIN temporal — SÍ existe uno documentado, estado a verificar en vivo:**
- Usuario: `audit-temp@propyte.local`, rol `ADMIN`. Creado en la auditoría previa (`docs/audit-2026-06-10/AUDIT.md:4`): *"Usuario temporal: `audit-temp@propyte.local` (ADMIN) — DESACTIVADO al cierre (reactivar: `isActive=true` en Admin)"*.
- Confirmado en `task_manager.md:22` (triage 2026-06-15): *"BUG-01 creds de auditoría no entran — `audit-temp@propyte.local` está DESACTIVADO a propósito (changelog 06-10) + sin hash. Expected. Gap real derivado: falta UI 'reset password by admin'."* — es decir, además de `isActive=false`, el password hash puede no ser usable para login directo; probablemente requiere reset vía Admin (no hay UI de "reset password by admin" — gap conocido, no bloqueante: se puede resetear por script directo tipo `seed-admin-users.ts`).
- **No verificable desde código estático** si el usuario sigue existiendo/desactivado en la BD de producción actual (han pasado ~1 mes desde el audit). Antes de reusarlo, verificar en vivo (`/admin` como ADMIN real, o script de lectura) su `isActive` y si tiene `passwordHash` usable.
- **No confundir con `mcp@propyte.local`** (`scripts/seed-mcp-user.ts`, `src/lib/mcp/auth.ts:16`): es un usuario de sistema para atribuir `AuditLog` de las llamadas del MCP, con password aleatorio explícitamente inutilizable para login interactivo — no es candidato para el auditor.
- **No confundir con `marketing@nativatulum.mx`** (`scripts/seed-admin-users.ts:17-22`, `scripts/create-user-marketing.ts`): es la cuenta ADMIN real de producción de Luis (usuario de esta sesión) — nunca usar como "ADMIN temporal" del auditor.

## 6. Automatizaciones observables

**Modelos** (`prisma/schema.prisma`): `AutomationRule` (2265), `ActionPlan`/`ActionPlanStep`/`ActionPlanEnrollment` (cadencias, 1287-1344), `ActionQueue` (cola pg-backed, 1348-1370), `RoutingRule` (1373-1388), `SlaPolicy`/`SlaTimer` (1391-1433), `WorkflowEvent` (log append-only de eventos de dominio, 1248-1262).

**Disparo:** cron `GET /api/cron/workflows` (`src/app/api/cron/workflows/route.ts`), protegido por header `x-cron-secret` (NO Bearer — coincide con el gotcha ya conocido de Hostinger) comparado contra `CRON_SECRET` (líneas 51-57). En cada tick corre, en orden: `processPendingEvents` → `runQueue` (ActionQueue) → `checkSlaBreaches` → `runEnrollments` (ActionPlan) → `runInactivityRules` → `checkOverduePayments` (PaymentSchedule → VENCIDA + evento `payment.overdue`) → `processPendingConversionsSafe` (CAPI). Comentario en el archivo (línea 2): está agendado en el crontab de root del VPS "CADA MINUTO". **Ya documentado como pendiente/gap en `task_manager.md:24`: BUG-19 — el cron no estaba agendado en Hostinger al 2026-06-15** (no confirmado si ya se agendó desde entonces — verificar en vivo).

**Cómo OBSERVAR que corrió, en la app (no sólo BD):**
- `GET /api/admin/automation` (`src/app/api/admin/automation/route.ts:10-56`) — requiere sesión (cualquier rol autenticado para el GET; el PATCH de toggle requiere `ADMIN|DIRECTOR`). Devuelve en un solo payload: reglas (`AutomationRule`, con `lastFiredAt`), planes/cadencias (`ActionPlan` con conteo de `enrollments`), políticas SLA (con conteo de `timers`), **conteo de `ActionQueue` agrupado por status**, y un bloque `observability`: últimas 10 acciones `FAILED` de `ActionQueue` (con `error`, `attempts`) + `eventsPending`/`eventsDone24h` de `WorkflowEvent`. Esta es la vista real de "¿corrió la automatización?" — se consume desde `/configuracion` (`src/components/config/automation-section.tsx`, `src/components/config/cadence-editor.tsx`).
- Retry manual de una acción fallida: `POST /api/admin/automation/retry` (`src/app/api/admin/automation/retry/route.ts`), sólo `ADMIN|DIRECTOR` — re-encola una fila `ActionQueue` en `FAILED` a `PENDING`.
- Journey / canvas visual: `/journey` (`ALLOWED = ["ADMIN","DIRECTOR"]`), respaldado por `GET /api/admin/journey/metrics` (`src/app/api/admin/journey/metrics/route.ts`) que corre SQL crudo sobre `propyte_crm.action_queue` agrupando por `dedupeKey` para contar entidades únicas afectadas por regla en una ventana de tiempo. Componentes `decision-inspector.tsx` / `rule-inspector-panel.tsx` sugieren inspección nodo-por-nodo de por qué una regla decidió algo.
- **Para un lead/deal QA específico:** la señal más directa y sin UI dedicada es revisar filas de `ActionQueue`/`SlaTimer`/`WorkflowEvent` con `entityId = <id del contacto/deal QA>` (vía DB, no hay list-by-entity en la UI actual) — o revisar el `Activity` resultante si la acción fue `CREATE_TASK`/`SEND_WHATSAPP`, que sí aparece en el historial del contacto/deal.

## 7. Prior-art (issues + auditorías previas)

**GitHub Issues:** `gh issue list --repo Propyte-Team/propyte-crm --limit 100 --state all` → **0 resultados** (exit code 0, lista vacía; confirmado repo existente vía `gh repo view Propyte-Team/propyte-crm` → `"CRM Propyte - Sistema de gestión inmobiliaria"`). No hay issues abiertos ni cerrados que deduplicar contra.

**Auditorías previas:** una sola, `docs/audit-2026-06-10/AUDIT.md` ("Audit Playwright — propyte-crm núcleo post-migración CRM→Hub", autor Claude/sesión autónoma). Hallazgos principales (todos marcados como **corregidos** en `feat/audit-fixes-minimal-ui`, según el propio doc):
- Validación de teléfono rechazaba su propio formato placeholder (Zod `max(15)` contaba espacios) — fix: normalización antes de validar.
- `GET /api/users?role=advisor` → 500 (valor `advisor` no existe en `UserRole`) — fix: validación de enum + 400.
- Kanban/contador de contactos no refrescaba tras crear (falta refetch) — fix: refetch/optimistic update.
- Fecha de cierre off-by-one (parseo UTC, display local) — fix: `timeZone: "UTC"` en formateo de fechas-calendario.
- `favicon.ico` 404 — fix: `src/app/icon.svg`.
- `/career` era ruta huérfana (no estaba en el sidebar) — fix: agregado a sidebar para roles asesor/TL.
- Roles del sidebar desalineados del enum real (ej. `TEAM_LEADER` veía menú vacío) — fix parcial: alineado para los roles legacy comunes, **pero el gap de `MANTENIMIENTO` (§2) sigue sin resolver hoy**.
- Rediseño visual B/N (fuera del alcance funcional).

**Complementario (no es un `docs/audit-*` pero es prior-art real de bugs conocidos):** `task_manager.md` contiene el triage de una "Auditoría externa 2026-06-15" con 22 bugs numerados (BUG-01…BUG-22), clasificados en: (A) probable falso positivo por outage transitorio de BD Supabase el mismo día, (B) conocido/en progreso — incluye el propio `audit-temp@propyte.local` desactivado (BUG-01, ver §5) y el cron de workflows no agendado (BUG-19, ver §6), (C) falso positivo confirmado, (D) bugs reales pendientes de UX (form de Deal sin validación visible, Walk-ins valida sólo el primer campo, routing SPA carga página incorrecta en URL directa, breadcrumb no actualiza, copy roto en Cotizaciones, "Request Access" es `mailto:` no formulario), (E) mejoras backlog (error boundaries en commissions/cobranza/career). **Cruzar cualquier hallazgo nuevo del auditor contra esta lista antes de reportarlo como nuevo.**
