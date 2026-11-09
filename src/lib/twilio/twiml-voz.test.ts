import { describe, it, expect } from "vitest";
import { buzonTwiml, clientesTwiml, escapeXml, parametrosLlamanteTwiml, twimlTrasDial } from "./twiml-voz";

describe("twiml-voz", () => {
  it("escapeXml escapa los cinco caracteres", () => {
    expect(escapeXml(`<a href="x">&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&apos;&lt;/a&gt;");
  });

  it("buzonTwiml: mensaje + Record con callback escapado", () => {
    const x = buzonTwiml("https://crm.test?a=1&b=2");
    expect(x).toContain("Deja tu mensaje");
    expect(x).toContain('<Record maxLength="120"');
    expect(x).toContain("https://crm.test?a=1&amp;b=2/api/webhooks/twilio/voice/recording");
  });

  it("parametrosLlamanteTwiml escapa valores", () => {
    const x = parametrosLlamanteTwiml({ contactId: "c1", nombre: `O"Brien <x>`, esNuevo: true });
    expect(x).toContain('name="nombre" value="O&quot;Brien &lt;x&gt;"');
    expect(x).toContain('name="esNuevo" value="1"');
  });

  it("clientesTwiml: un <Client> por usuario con los mismos parámetros; sinAsesor solo si aplica", () => {
    const x = clientesTwiml(["u1", "u<2"], { contactId: "c1", nombre: "A", esNuevo: false, sinAsesor: true });
    expect(x.match(/<Client>/g)).toHaveLength(2);
    expect(x).toContain("<Client>u1<Parameter");
    expect(x).toContain("<Client>u&lt;2<Parameter");
    expect(x.match(/name="sinAsesor" value="1"/g)).toHaveLength(2);
    expect(clientesTwiml(["u1"], { contactId: "c1", nombre: "A", esNuevo: false })).not.toContain("sinAsesor");
  });

  it.each(["completed", "answered"])("twimlTrasDial %s → Hangup", (st) => {
    expect(twimlTrasDial(st, "https://x")).toBe("<Hangup/>");
  });

  it.each(["no-answer", "busy", "failed", "canceled", undefined])("twimlTrasDial %s → buzón", (st) => {
    expect(twimlTrasDial(st, "https://x")).toContain("<Record");
  });
});
