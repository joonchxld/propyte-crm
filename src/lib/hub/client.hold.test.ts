import { describe, it, expect, vi, afterEach } from "vitest";

// #961 — el hold dice POR QUÉ falló: un «no» del Hub (4xx) se respeta; no tener configurado el Hub
// o que no responda (red, 5xx) deja apartar de respaldo en el CRM.
vi.mock("@/lib/db", () => ({ default: { $queryRawUnsafe: vi.fn(async () => []) } }));

async function cliente(env: { base?: string; key?: string }) {
  vi.resetModules();
  process.env.HUB_API_BASE_URL = env.base ?? "";
  process.env.HUB_API_KEY = env.key ?? "";
  return import("./client");
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.HUB_API_BASE_URL;
  delete process.env.HUB_API_KEY;
});

const args = { hubUnitId: "u1", crmDealId: "d1" };

describe("variables del Hub (#961, seguimiento)", () => {
  it("se leen en cada llamada: ponerlas después de cargar el módulo basta (.env del VPS + redespliegue)", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ unit: { id: "u1", status: "APARTADA", holdExpiresAt: null } }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const { requestUnitHold } = await cliente({});
    expect(await requestUnitHold(args)).toMatchObject({ ok: false, motivo: "sin_configurar" });
    process.env.HUB_API_BASE_URL = "https://hub.example";
    process.env.HUB_API_KEY = "k";
    expect(await requestUnitHold(args)).toMatchObject({ ok: true });
  });

  it("el mensaje dice cuál falta (nunca el valor)", async () => {
    vi.stubGlobal("fetch", vi.fn());
    let c = await cliente({ base: "https://hub.example" });
    expect((await c.requestUnitHold(args)).error).toBe("Hub API no configurada: el servidor no tiene HUB_API_KEY");
    c = await cliente({});
    expect((await c.requestUnitHold(args)).error).toBe("Hub API no configurada: el servidor no tiene HUB_API_BASE_URL ni HUB_API_KEY");
  });

  it("tolera comillas, espacios y la diagonal final al copiar el valor", async () => {
    const { hubApiConfig } = await cliente({});
    expect(hubApiConfig({ HUB_API_BASE_URL: ' "https://hub.example/" ', HUB_API_KEY: " 'abc' " })).toEqual({
      base: "https://hub.example",
      key: "abc",
      faltan: [],
    });
    expect(hubApiConfig({ HUB_API_BASE_URL: '""', HUB_API_KEY: "  " }).faltan).toEqual(["HUB_API_BASE_URL", "HUB_API_KEY"]);
  });

  it("clave equivocada (401/403) o ruta que no existe (404): mal_configurado, con pista", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 })));
    let c = await cliente({ base: "https://hub.example", key: "k" });
    expect(await c.requestUnitHold(args)).toEqual({
      ok: false,
      motivo: "mal_configurado",
      error: "Unauthorized (revisa HUB_API_KEY: tiene que ser la HUB_INTERNAL_API_KEY del Hub)",
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>", { status: 404 })));
    c = await cliente({ base: "https://hub.example", key: "k" });
    expect(await c.requestUnitHold(args)).toMatchObject({ motivo: "mal_configurado", error: "Hub respondió 404 (revisa HUB_API_BASE_URL)" });
  });
});

describe("requestUnitHold — motivo del fallo (#961)", () => {
  it("sin HUB_API_BASE_URL / HUB_API_KEY: sin_configurar, sin llamar a la red", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { requestUnitHold } = await cliente({});
    expect(await requestUnitHold(args)).toMatchObject({ ok: false, motivo: "sin_configurar" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("el Hub dice que no (409): rechazo, con su mensaje", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Unidad ya apartada" }), { status: 409 })));
    const { requestUnitHold } = await cliente({ base: "https://hub.example", key: "k" });
    expect(await requestUnitHold(args)).toEqual({ ok: false, motivo: "rechazo", error: "Unidad ya apartada" });
  });

  it("el Hub falla (502) o no hay red: sin_respuesta", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 502 })));
    let c = await cliente({ base: "https://hub.example", key: "k" });
    expect(await c.requestUnitHold(args)).toMatchObject({ ok: false, motivo: "sin_respuesta", error: "Hub respondió 502" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    c = await cliente({ base: "https://hub.example", key: "k" });
    expect(await c.requestUnitHold(args)).toMatchObject({ ok: false, motivo: "sin_respuesta", error: "ECONNREFUSED" });
  });

  it("aparta: ok, a la URL y con la clave del Hub", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ unit: { id: "u1", status: "APARTADA", holdExpiresAt: null } }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const { requestUnitHold } = await cliente({ base: "https://hub.example/", key: "k" });
    expect(await requestUnitHold(args)).toMatchObject({ ok: true, unit: { id: "u1" } });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://hub.example/api/inventory/units/u1/hold");
    expect((init.headers as Record<string, string>)["x-hub-api-key"]).toBe("k");
  });
});
