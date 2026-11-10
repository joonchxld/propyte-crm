// #988 — Plantillas de la cadencia de nuevos: variables, variantes y enlaces.
//
// Los textos viven en propyte_crm.copilot_plantillas (los sembró la migración con el PDF de Luis) y
// se editan en Copilot → Plantillas. Aquí solo se llenan las variables del PDF (sección 2):
//   [NOMBRE] [ASESOR] [ROL] [PROYECTO] [ZONA] [wa.me/NÚMERO] [WhatsApp] [firma]/[signature]
//   [LÍNEA DE VALOR] (menú A–D del Correo 1) y [CIFRA] (regla zona–cifra).
// Lo que el CRM no sabe ([TICKET], [N], [M], [FECHA], [EVENTO]…) se queda entre corchetes y se le
// avisa al asesor para que lo llene antes de copiar.
//
// Lógica pura: sin Prisma ni React.

export type Idioma = "ES" | "EN";

export interface Plantilla {
  id: string;
  codigo: string;
  idioma: Idioma;
  variante: string;
  canal: string;
  nombre: string;
  asunto: string | null;
  cuerpo: string;
}

export interface VariablesPlantilla {
  nombre: string | null;
  asesor: string | null;
  rol: string | null;
  proyecto: string | null;
  zona: string | null;
  /** wa.me del asesor (https://wa.me/52…), o null si no tiene teléfono en Mi perfil. */
  waAsesor: string | null;
  /** Texto de la línea de valor ya elegido para la zona (sin variables adentro todavía). */
  lineaValor: string | null;
  /** Cifra SHF de la zona («+13.5%»), o null si la zona no tiene cifra. */
  cifra: string | null;
  /** #993: nombre del mes para [MES] (plantillas de las ramas). */
  mes?: string | null;
}

// ───────────────────────────── zona ─────────────────────────────

export type ClaveZona = "PDC" | "CANCUN" | "QROO" | "TULUM";

const PLAZA_A_ZONA: Record<string, string> = { PDC: "Playa del Carmen", TULUM: "Tulum", MERIDA: "Mérida" };

function sinAcentos(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Zona del contacto: la «Zona preferida»; si está vacía, la de la plaza de su campaña. */
export function zonaDelContacto(preferredZone: string | null | undefined, targetPlaza: string | null | undefined): string | null {
  const z = (preferredZone ?? "").trim();
  if (z) return z;
  return targetPlaza ? PLAZA_A_ZONA[targetPlaza] ?? null : null;
}

/** A qué cifra y línea de valor corresponde la zona (regla zona–cifra del PDF). */
export function claveDeZona(zona: string | null | undefined): ClaveZona | null {
  if (!zona) return null;
  const z = sinAcentos(zona);
  if (/\bplaya\b|playa del carmen|solidaridad|coco beach|playacar/.test(z)) return "PDC";
  if (/cancun|benito juarez/.test(z)) return "CANCUN";
  if (/tulum/.test(z)) return "TULUM";
  if (/quintana roo|q\.? ?roo|riviera maya|puerto morelos|bacalar|cozumel|chetumal|holbox|isla mujeres|akumal|mahahual|puerto aventuras/.test(z)) return "QROO";
  return null;
}

/** Línea de valor del Correo 1: A Playa, B Cancún, C Quintana Roo, D Honesta (Tulum y el resto). */
export function varianteLineaValor(clave: ClaveZona | null): "A" | "B" | "C" | "D" {
  if (clave === "PDC") return "A";
  if (clave === "CANCUN") return "B";
  if (clave === "QROO") return "C";
  return "D";
}

/** Variante de la cifra (copilot_plantillas codigo CIFRA). Tulum y el resto no llevan cifra. */
export function varianteCifra(clave: ClaveZona | null): "PDC" | "CANCUN" | "QROO" | null {
  return clave === "PDC" || clave === "CANCUN" || clave === "QROO" ? clave : null;
}

// ───────────────────────────── variantes ─────────────────────────────

/** Plantillas con «elige variante» en el PDF, y la que sale por defecto. */
export const VARIANTES: Record<string, { valor: string; etiqueta: string }[]> = {
  WA3: [
    { valor: "METODO", etiqueta: "Método (cualquier proyecto)" },
    { valor: "TRACCION", etiqueta: "Tracción (solo dato real y favorable)" },
  ],
  CORREO3: [
    { valor: "METODO", etiqueta: "Método" },
    { valor: "TRACCION", etiqueta: "Tracción" },
  ],
  WA4: [
    { valor: "FIDEICOMISO", etiqueta: "Fideicomiso (extranjero)" },
    { valor: "SEGURIDAD", etiqueta: "Seguridad jurídica (universal)" },
  ],
  CORREO4: [
    { valor: "FIDEICOMISO", etiqueta: "Fideicomiso" },
    { valor: "SEGURIDAD", etiqueta: "Seguridad jurídica" },
  ],
};

/**
 * Variante por defecto. Tracción solo «si la absorción es genuinamente buena» (guardarraíl), así
 * que se arranca con Método. Fideicomiso es para extranjeros: número de fuera o idioma inglés.
 */
export function varianteInicial(codigo: string, ctx: { pais: string; idioma: Idioma }): string {
  if (codigo === "WA3" || codigo === "CORREO3") return "METODO";
  if (codigo === "WA4" || codigo === "CORREO4") return ctx.pais !== "MX" || ctx.idioma === "EN" ? "FIDEICOMISO" : "SEGURIDAD";
  return "";
}

/** Elige la plantilla: idioma del lead y su variante; si no hay en ese idioma, la otra. */
export function elegirPlantilla(
  plantillas: readonly Plantilla[],
  codigo: string,
  idioma: Idioma,
  variante = "",
): Plantilla | null {
  const delCodigo = plantillas.filter((p) => p.codigo === codigo && p.variante === variante);
  return delCodigo.find((p) => p.idioma === idioma) ?? delCodigo.find((p) => p.idioma !== idioma) ?? null;
}

// ───────────────────────────── llenado ─────────────────────────────

export interface TextoListo {
  texto: string;
  asunto: string | null;
  /** Variables que quedaron sin llenar, tal como aparecen («[PROYECTO]», «[N]»). */
  faltan: string[];
  /** La plantilla no existe en el idioma del lead y salió en el otro. */
  otroIdioma: boolean;
}

const MARCA = /\[[^\]\n]{1,60}\]/g;

/** Llena las variables conocidas. Las desconocidas o vacías se quedan y se listan en `faltan`. */
export function llenarVariables(texto: string, v: VariablesPlantilla): string {
  const firma = `${v.asesor ?? "[ASESOR]"} · ${v.rol ?? "[ROL]"} · Propyte · ${v.waAsesor ?? "[wa.me/NÚMERO]"}`;
  const reemplazos: Array<[RegExp, string | null]> = [
    // Primero las que traen otras variables adentro.
    [/\[(L[IÍ]NEA DE VALOR|VALUE LINE)[^\]]*\]/gi, v.lineaValor],
    [/\[(firma|signature)\]/gi, firma],
    [/\[NOMBRE\]/g, v.nombre],
    [/\[ASESOR\]/g, v.asesor],
    [/\[ROL\]/g, v.rol],
    [/\[PROYECTO\]/g, v.proyecto],
    [/\[ZONA\]/g, v.zona],
    [/\[CIFRA\]/g, v.cifra],
    [/\[wa\.me\/N[ÚU]MERO\]/gi, v.waAsesor],
    [/\[WhatsApp\]/g, v.waAsesor],
    [/\[MES\]/g, v.mes ?? null],
  ];
  let out = texto;
  // Dos pasadas: la línea de valor y la firma traen [ZONA], [ASESOR]… adentro.
  for (let i = 0; i < 2; i++) {
    for (const [re, valor] of reemplazos) {
      if (valor && valor.trim()) out = out.replace(re, valor.trim());
    }
  }
  return out;
}

export function variablesSinLlenar(texto: string): string[] {
  return [...new Set(texto.match(MARCA) ?? [])];
}

export function textoListo(p: Plantilla | null, v: VariablesPlantilla, idioma: Idioma): TextoListo | null {
  if (!p) return null;
  const texto = llenarVariables(p.cuerpo, v);
  const asunto = p.asunto ? llenarVariables(p.asunto, v) : null;
  return {
    texto,
    asunto,
    faltan: variablesSinLlenar(`${asunto ?? ""}\n${texto}`),
    otroIdioma: p.idioma !== idioma,
  };
}

// ───────────────────────────── asesor ─────────────────────────────

/** [ROL] del asesor. No viene en el PDF: se toma el rol del usuario en el CRM. */
export function rolDelAsesor(role: string | null | undefined, idioma: Idioma): string {
  const es: Record<string, string> = { GERENTE: "Gerente comercial", DIRECTOR: "Director comercial", TEAM_LEADER: "Líder comercial" };
  const en: Record<string, string> = { GERENTE: "Sales Manager", DIRECTOR: "Sales Director", TEAM_LEADER: "Sales Team Lead" };
  const r = role ?? "";
  return idioma === "EN" ? en[r] ?? "Sales Advisor" : es[r] ?? "Asesor comercial";
}

/** Enlace wa.me de un teléfono (solo dígitos). null si no hay teléfono. */
export function enlaceWhatsApp(telefono: string | null | undefined, texto?: string): string | null {
  const digitos = (telefono ?? "").replace(/\D/g, "");
  if (digitos.length < 10) return null;
  return `https://wa.me/${digitos}${texto ? `?text=${encodeURIComponent(texto)}` : ""}`;
}

export function enlaceCorreo(correo: string | null | undefined, asunto: string | null, texto: string): string | null {
  if (!correo) return null;
  const q = [asunto ? `subject=${encodeURIComponent(asunto)}` : null, `body=${encodeURIComponent(texto)}`].filter(Boolean).join("&");
  return `mailto:${correo}?${q}`;
}

export function enlaceSms(telefono: string | null | undefined, texto: string): string | null {
  const s = (telefono ?? "").trim();
  if (!s) return null;
  return `sms:${s}?&body=${encodeURIComponent(texto)}`;
}
