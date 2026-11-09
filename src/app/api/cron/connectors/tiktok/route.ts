// Pull de TikTok Lead Generation (Anexo B §H.4) — agendado en el crontab de root del VPS CADA 5 MIN:
//   curl -s -H "x-cron-secret: $CRON_SECRET" https://crm.propyte.com/api/cron/connectors/tiktok
// Trae leads con create_time > lastSyncAt por cada conector TIKTOK activo.
import { NextRequest, NextResponse } from "next/server";
import { rechazoCron } from "@/lib/cron/auth";
import prisma from "@/lib/db";
import { readCredentials, mapExternalFields, processIncomingLead } from "@/lib/intake/connectors";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface TikTokCredentials {
  advertiserId: string;
  accessToken: string;
}

interface TikTokLead {
  lead_id: string;
  create_time?: string;
  form_fields?: Array<{ field_name?: string; name?: string; value?: string }>;
  campaign_name?: string;
  ad_name?: string;
}

export async function GET(req: NextRequest) {
  const rechazo = rechazoCron(req);
  if (rechazo) return rechazo;

  const connectors = await prisma.leadConnector.findMany({
    where: { provider: "TIKTOK", status: "ACTIVE", deletedAt: null },
  });

  const summary: Record<string, unknown>[] = [];
  for (const connector of connectors) {
    const creds = readCredentials<TikTokCredentials>(connector);
    if (!creds?.advertiserId || !creds.accessToken) {
      summary.push({ connector: connector.name, error: "Credenciales incompletas" });
      continue;
    }

    const since = connector.lastSyncAt ?? new Date(Date.now() - 24 * 3_600_000);
    try {
      // TikTok Business API — Lead Gen leads por advertiser (paginado simple)
      const url = new URL("https://business-api.tiktok.com/open_api/v1.3/page/lead/task/download/");
      url.searchParams.set("advertiser_id", creds.advertiserId);
      const res = await fetch(
        `https://business-api.tiktok.com/open_api/v1.3/pages/leads/?advertiser_id=${creds.advertiserId}&page_size=100&start_time=${Math.floor(since.getTime() / 1000)}`,
        { headers: { "Access-Token": creds.accessToken } }
      );
      if (!res.ok) throw new Error(`TikTok API ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = (await res.json()) as { code?: number; message?: string; data?: { leads?: TikTokLead[]; list?: TikTokLead[] } };
      if (data.code !== 0) throw new Error(`TikTok code ${data.code}: ${data.message}`);

      const leads = data.data?.leads ?? data.data?.list ?? [];
      let processed = 0;
      for (const lead of leads) {
        const external: Record<string, unknown> = {};
        for (const f of lead.form_fields ?? []) {
          const name = f.field_name ?? f.name;
          if (name) external[name] = f.value;
        }
        const defaultMap: Record<string, string> = {
          full_name: "fullName",
          name: "fullName",
          phone_number: "phone",
          phone: "phone",
          email: "email",
        };
        const fieldMap = { ...defaultMap, ...((connector.fieldMap ?? {}) as Record<string, string>) };
        const mapped = mapExternalFields(fieldMap, external);
        mapped.sourceDetail = [lead.campaign_name, lead.ad_name].filter(Boolean).join(" / ") || mapped.sourceDetail;

        const r = await processIncomingLead(connector.id, lead.lead_id, { external, tiktok: lead }, mapped);
        if (r.status !== "ALREADY_PROCESSED") processed++;
      }

      await prisma.leadConnector.update({
        where: { id: connector.id },
        data: { lastSyncAt: new Date() },
      });
      summary.push({ connector: connector.name, leads: leads.length, processed });
    } catch (err) {
      const detail = String(err instanceof Error ? err.message : err).slice(0, 500);
      await prisma.leadConnector.update({
        where: { id: connector.id },
        data: { errorCount: { increment: 1 }, lastError: detail },
      });
      summary.push({ connector: connector.name, error: detail });
    }
  }

  return NextResponse.json({ ok: true, connectors: summary });
}
