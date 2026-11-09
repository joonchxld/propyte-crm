// Pull de LinkedIn Lead Gen Forms — agendado en el crontab de root del VPS CADA 15 MIN:
//   curl -s -H "x-cron-secret: $CRON_SECRET" https://crm.propyte.com/api/cron/connectors/linkedin
import { NextRequest, NextResponse } from "next/server";
import { rechazoCron } from "@/lib/cron/auth";
import prisma from "@/lib/db";
import { readCredentials, mapExternalFields, processIncomingLead } from "@/lib/intake/connectors";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface LinkedInCredentials { adAccountId: string; accessToken: string; }

interface LIResponse {
  id: string;
  submittedAt?: number;
  formResponse?: { answers?: Array<{ questionId?: string; answer?: { textQuestionAnswer?: { value?: string } } }> };
  // Forma simplificada; el parser real depende del shape de la API de leadFormResponses.
}

export async function GET(req: NextRequest) {
  const rechazo = rechazoCron(req);
  if (rechazo) return rechazo;

  const connectors = await prisma.leadConnector.findMany({
    where: { provider: "LINKEDIN", status: "ACTIVE", deletedAt: null },
  });

  const summary: Record<string, unknown>[] = [];
  for (const connector of connectors) {
    const creds = readCredentials<LinkedInCredentials>(connector);
    if (!creds?.adAccountId || !creds.accessToken) {
      summary.push({ connector: connector.name, error: "Credenciales incompletas" });
      continue;
    }
    const since = connector.lastSyncAt ?? new Date(Date.now() - 24 * 3_600_000);
    try {
      const url = `https://api.linkedin.com/rest/leadFormResponses?q=owner&owner=(sponsoredAccount:urn:li:sponsoredAccount:${encodeURIComponent(creds.adAccountId)})&submittedAtTimeRange=(start:${since.getTime()})`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${creds.accessToken}`, "LinkedIn-Version": "202401", "X-Restli-Protocol-Version": "2.0.0" },
      });
      if (!res.ok) throw new Error(`LinkedIn API ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = (await res.json()) as { elements?: LIResponse[] };
      const responses = data.elements ?? [];

      let processed = 0;
      for (const r of responses) {
        const external: Record<string, unknown> = {};
        for (const a of r.formResponse?.answers ?? []) {
          const q = a.questionId;
          const v = a.answer?.textQuestionAnswer?.value;
          if (q && v) external[q] = v;
        }
        const defaultMap: Record<string, string> = {
          FIRST_NAME: "firstName", LAST_NAME: "lastName",
          EMAIL: "email", PHONE_NUMBER: "phone",
        };
        const fieldMap = { ...defaultMap, ...((connector.fieldMap ?? {}) as Record<string, string>) };
        const mapped = mapExternalFields(fieldMap, external);
        if (!mapped.source) mapped.source = "LINKEDIN";
        const result = await processIncomingLead(connector.id, r.id, { external, linkedin: r }, mapped);
        if (result.status !== "ALREADY_PROCESSED") processed++;
      }
      await prisma.leadConnector.update({ where: { id: connector.id }, data: { lastSyncAt: new Date() } });
      summary.push({ connector: connector.name, responses: responses.length, processed });
    } catch (err) {
      const detail = String(err instanceof Error ? err.message : err).slice(0, 500);
      await prisma.leadConnector.update({
        where: { id: connector.id }, data: { errorCount: { increment: 1 }, lastError: detail },
      });
      summary.push({ connector: connector.name, error: detail });
    }
  }
  return NextResponse.json({ ok: true, connectors: summary });
}
