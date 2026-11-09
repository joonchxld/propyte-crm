# Centro de Conexiones — Smoke E2E (requiere credenciales vivas)

> Estos pasos los valida Luis con cuentas/tokens reales. La feature arranca DORMIDA
> hasta aplicar la migración + configurar permisos/webhooks por plataforma.

## Pre-requisitos de activación (fuera del código)
1. Aplicar migración `prisma/migrations-manual/2026-06-19-conexiones-multicuenta.sql`
   a la Supabase compartida (`oaijxdpevakashxshhvm`) + `npx prisma generate`.
2. Cron del VPS (crontab de root, ya agendado) `*/15 * * * *` → `/api/cron/connectors/linkedin`
   (header `x-cron-secret`, mismo `CRON_SECRET`; NO Authorization Bearer).
3. Webhooks: Meta `/api/connectors/meta/webhook` (ya existe) por página;
   Google Ads: en cada Lead Form, Webhook URL `https://crm.propyte.com/api/connectors/google/webhook`
   + Key = `webhookKey` del conector.
4. Permisos/app por plataforma: `leads_retrieval` (Meta), Lead Gen (TikTok),
   Lead Form + OAuth (Google Ads), `r_marketing_leadgen_automation` (LinkedIn).

## Checklist
- [ ] Login admin → `/conexiones` carga con secciones Meta, TikTok, Google, LinkedIn, Pinterest.
- [ ] YouTube y Pinterest muestran "push-only · v2" (sin botón de conectar).
- [ ] "Conectar cuenta" en Facebook → wizard de 4 pasos.
- [ ] Pegar credenciales → "Probar conexión" → verde con nombre de la página.
- [ ] "Guardar y activar" → la cuenta aparece con dot verde en su sección.
- [ ] (Tras configurar webhook en Meta) un lead de prueba del formulario aparece como contacto nuevo, ruteado.
- [ ] Pausar / Activar / Eliminar una cuenta funciona y refresca la lista.
- [ ] Conectar una segunda cuenta de la misma plataforma (multicuenta) funciona.

## Verificaciones de activación de APIs (anotadas en review)
- LinkedIn: confirmar shape real de `leadFormResponses` (URL/version/`submittedAtTimeRange` con `end`),
  y que los `questionId` mapeen a los campos correctos (puede requerir fieldMap por conector).
- Google Ads: confirmar `column_id` reales del Lead Form vs el defaultMap.
