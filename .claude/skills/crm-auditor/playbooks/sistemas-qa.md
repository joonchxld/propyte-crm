# Playbook — Sistemas / QA (transversal)

## Persona
Auditor de sistema. Revisa permisos por rol, journey global lead→cierre, automatizaciones y mejoras. Usa login `ADMIN` (`audit-temp@propyte.local`) para observabilidad + logins de rol para el negative testing.

## 1. Matriz de permisos (negative testing REAL — el código no basta, hay que probar en vivo)

Contexto (recon-notes §2): el gating tiene 3 capas desalineadas. **Solo 5 páginas exigen allowlist de rol server-side**; el resto solo checan "hay sesión". El sidebar oculta links pero NO protege por URL directa.

**a) Páginas con allowlist (deben redirigir a un rol no permitido):** probar por URL directa con `qa-asesor` (`ASESOR_SR`, no permitido):
| Ruta | Allowlist real | Esperado con ASESOR_SR |
|---|---|---|
| `/admin` | ADMIN, DIRECTOR, GERENTE | redirect/bloqueo |
| `/configuracion` | ADMIN, DIRECTOR, GERENTE | redirect/bloqueo |
| `/duplicados` | ADMIN, DIRECTOR, DEVELOPER_EXT, MANTENIMIENTO | redirect/bloqueo |
| `/journey` | ADMIN, DIRECTOR | redirect/bloqueo |
| `/conexiones` | ADMIN, DIRECTOR, GERENTE, MARKETING | redirect/bloqueo |
Hallazgo (`permiso-gap`) si alguna NO redirige.

**b) Páginas que SOLO checan sesión (candidato permiso-gap de datos):** con `qa-asesor` navegar por URL directa a `/reports`, `/commissions`, `/cobranza`. Verificar si cargan y **si muestran datos de otros asesores/plazas** (no debería). `deals.ts` sí hace scoping por rol/plaza/equipo/own, pero **no está confirmado que reports/commissions/cobranza lo hagan** → esta es la prueba prioritaria. Hallazgo (`permiso-gap`, severidad alta) si un asesor ve datos que no le corresponden.

**c) Bug conocido sin resolver — sidebar vacío de `MANTENIMIENTO`:** crear `qa-mantenimiento` (rol `MANTENIMIENTO`, solo por script DB), login, confirmar que el sidebar sale **completamente vacío** (ningún `navGroup` incluye `MANTENIMIENTO`, sidebar.tsx:36). Confirmar/re-reportar como `permiso-gap` (mismo tipo que el fix de TEAM_LEADER de 2026-06-10, aún abierto para MANTENIMIENTO).

## 2. Journey completo lead→cierre (cross-rol)
Seguir un lead QA desde intake hasta deal cerrado cruzando roles: intake (`/conexiones` o alta manual) → asignación (`/pipeline`, o ruteo del gerente) → seguimiento/actividad → cotización (`/cotizaciones`) → cierre del deal. Éxito: cada handoff tiene su paso en la UI. Hallazgo (`missing-feature`) si hay hueco en la cadena.

## 3. Automatizaciones (recon-notes §6)
Observabilidad en `GET /api/admin/automation` (consumido desde `/configuracion` → automation-section / cadence-editor) y `/journey` (+ `/api/admin/journey/metrics`).
- Con un lead/deal QA, disparar la condición de una regla/cadencia y verificar el efecto: revisar el bloque `observability` (ActionQueue por status, últimas 10 FAILED, `eventsPending`/`eventsDone24h`) y el `Activity` resultante en el historial del contacto/deal.
- Verificar en vivo si el cron `GET /api/cron/workflows` está agendado en el crontab de root del VPS (BUG-19 lo reportó sin agendar al 2026-06-15). Si `eventsPending` crece sin drenar → el cron no corre → `automation-gap` crítico.
- Anotar **mejoras** posibles de cada automatización (categoría `mejora`).

## 4. Consistencia de estados
Verificar que el estado de un lead/deal QA sea coherente entre `/contacts`, `/pipeline` (kanban) y el detalle. Hallazgo si difieren.

## Criterio de hallazgo
Enfatizar `permiso-gap`, `automation-gap` y `mejora`. Cruzar SIEMPRE contra prior-art (recon-notes §7 + `task_manager.md` BUG-01…22 + `docs/audit-2026-06-10`) antes de reportar como nuevo — muchos gaps ya están triados.
