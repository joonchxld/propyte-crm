// src/app/api/cron/google/gmail-sync/route.ts
// Respaldo de inbound cuando Pub/Sub no está disponible (p.ej. local) o como red de seguridad.
// #889: el tick /api/cron/workflows ya hace esta misma revisión cada minuto (misma función,
// lib/google/gmail-sync.ts). Esta ruta se conserva para correrla a mano o como respaldo.
// Agendado en el crontab de root del VPS (x-cron-secret), cada 15 min:
//   curl -s -H "x-cron-secret: $CRON_SECRET" https://crm.propyte.com/api/cron/google/gmail-sync
import { NextRequest, NextResponse } from "next/server"
import { rechazoCron } from "@/lib/cron/auth"
import { sincronizarCorreoEntrante } from "@/lib/google/gmail-sync"

export const dynamic = "force-dynamic"
export const maxDuration = 60


export async function GET(req: NextRequest) {
  const rechazo = rechazoCron(req)
  if (rechazo) return rechazo

  const startedAt = Date.now()
  let r
  try {
    r = await sincronizarCorreoEntrante()
  } catch {
    // tabla aún no migrada → no-op
    return NextResponse.json({ ok: true, note: "google_oauth_tokens no disponible", accounts: 0 })
  }

  return NextResponse.json({
    ok: true,
    accounts: r.cuentas,
    logged: r.registrados,
    skipped: r.omitidos,
    disconnected: r.desconectadas,
    errors: r.errores.slice(0, 10),
    ms: Date.now() - startedAt,
  })
}
