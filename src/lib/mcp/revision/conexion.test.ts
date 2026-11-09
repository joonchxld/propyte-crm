import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { avisoDeOrigen, datosDeConexion, puedeVerTokenRevision } from "./conexion";
import { configFalso } from "./dobles.testutil";
import { leerTokenEsperado } from "./token";

const EN_BASE = "b".repeat(64);
const EN_ENTORNO = "e".repeat(64);

let previo: string | undefined;

beforeEach(() => {
  previo = process.env.MCP_REVISION_TOKEN;
  delete process.env.MCP_REVISION_TOKEN;
});

afterEach(() => {
  if (previo === undefined) delete process.env.MCP_REVISION_TOKEN;
  else process.env.MCP_REVISION_TOKEN = previo;
});

describe("leerTokenEsperado", () => {
  it("prefiere la base sobre el entorno", async () => {
    // El orden es la diferencia entre una rotación real y una que miente: si el entorno
    // ganara, la pantalla diría "rotado" y el secreto viejo seguiría abriendo.
    process.env.MCP_REVISION_TOKEN = EN_ENTORNO;
    const r = await leerTokenEsperado(configFalso({ token: EN_BASE, rotadoEn: "2026-08-28T10:00:00Z" }));
    expect(r).toEqual({ token: EN_BASE, origen: "base", rotadoEn: "2026-08-28T10:00:00Z" });
  });

  it("cae al entorno cuando no hay fila: es el arranque", async () => {
    process.env.MCP_REVISION_TOKEN = EN_ENTORNO;
    const r = await leerTokenEsperado(configFalso(null));
    expect(r).toEqual({ token: EN_ENTORNO, origen: "entorno", rotadoEn: null });
  });

  it("sin nada configurado devuelve cadena vacía y `ausente`", async () => {
    // La puerta rechaza todo con cadena vacía. Devolver `null` aquí obligaría a cada
    // llamador a acordarse de comprobarlo.
    expect(await leerTokenEsperado(configFalso(null))).toEqual({
      token: "",
      origen: "ausente",
      rotadoEn: null,
    });
  });

  it("una fila con el token vacío o de otro tipo no cuenta como configurado", async () => {
    // Una fila a medias —creada a mano, o por una migración— no debe abrir la puerta ni
    // impedir el respaldo del entorno.
    process.env.MCP_REVISION_TOKEN = EN_ENTORNO;
    expect((await leerTokenEsperado(configFalso({ token: "   " }))).origen).toBe("entorno");
    expect((await leerTokenEsperado(configFalso({}))).origen).toBe("entorno");
  });
});

describe("puedeVerTokenRevision", () => {
  it("deja pasar a ADMIN y DIRECTOR", () => {
    expect(puedeVerTokenRevision("ADMIN")).toBe(true);
    expect(puedeVerTokenRevision("DIRECTOR")).toBe(true);
  });

  it("no deja pasar a nadie más, ni a un rol vacío", () => {
    // Aquí se PINTA una credencial: no es esconder un botón.
    for (const rol of ["GERENTE", "MARKETING", "ASESOR_SR", "TEAM_LEADER", "", null, undefined]) {
      expect(puedeVerTokenRevision(rol), String(rol)).toBe(false);
    }
  });
});

describe("datosDeConexion", () => {
  it("arma la URL con el host de la petición, no con una constante", () => {
    // En localhost la URL tiene que apuntar ahí, o la pantalla entrega una que no sirve
    // para probar.
    const d = datosDeConexion({
      host: "localhost:3000",
      token: EN_BASE,
      origen: "base",
      rotadoEn: null,
      githubPat: "ghp_x",
    });
    expect(d.url).toBe(`https://localhost:3000/api/mcp/revision/${EN_BASE}`);
    expect(d.lista).toBe(true);
  });

  it("sin token no está lista y explica qué hacer", () => {
    const d = datosDeConexion({
      host: "crm.propyte.com",
      token: "",
      origen: "ausente",
      rotadoEn: null,
      githubPat: undefined,
    });
    expect(d.lista).toBe(false);
    expect(d.url).toBe("");
    expect(d.motivo).toMatch(/Genera uno con el botón/);
  });

  it("el estado del PAT de GitHub es independiente del token", () => {
    // La puerta a medias dice CUÁL mitad le falta: sin PAT, las tools de datos y fallos
    // siguen sirviendo y la revisión diaria corre igual.
    const base = { host: "h", token: EN_BASE, origen: "base" as const, rotadoEn: null };
    expect(datosDeConexion({ ...base, githubPat: undefined }).githubListo).toBe(false);
    expect(datosDeConexion({ ...base, githubPat: "   " }).githubListo).toBe(false);
    expect(datosDeConexion({ ...base, githubPat: "ghp_x" }).githubListo).toBe(true);
    expect(datosDeConexion({ ...base, githubPat: undefined }).lista).toBe(true);
  });
});

describe("avisoDeOrigen", () => {
  it("avisa cuando el token viene del entorno y no se puede rotar desde la pantalla", () => {
    // Callarlo dejaría un botón que parece funcionar y no cambia nada.
    expect(avisoDeOrigen("entorno")).toMatch(/MCP_REVISION_TOKEN/);
    expect(avisoDeOrigen("entorno")).toMatch(/borrarla del \.env del VPS/);
  });

  it("no avisa nada cuando ya vive en la base", () => {
    expect(avisoDeOrigen("base")).toBe("");
    expect(avisoDeOrigen("ausente")).toBe("");
  });
});
