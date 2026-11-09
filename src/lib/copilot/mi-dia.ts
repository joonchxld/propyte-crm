// #988 — Arma las tareas de «Mi día» y de la ficha a partir de las filas de la base.
//
// Una tarea = un contacto + un día de su cadencia, con los toques de ese día adentro (Luis, ronda 4).
// Cada toque trae su texto ya llenado en el idioma del lead (y sus variantes, si las hay), cuándo
// hacerlo y su resultado. Lógica pura: la consulta vive en cadencia-servicio.ts.
import { normalizePhoneE164 } from "@/lib/phone";
import { CANAL_LABELS, compararTareas, estaVencida, paisDeTelefono, type Canal, type Pais } from "./cadencia-nuevos";
import {
  VARIANTES,
  claveDeZona,
  elegirPlantilla,
  enlaceWhatsApp,
  rolDelAsesor,
  textoListo,
  varianteCifra,
  varianteInicial,
  varianteLineaValor,
  zonaDelContacto,
  type Idioma,
  type Plantilla,
  type TextoListo,
  type VariablesPlantilla,
} from "./plantillas";

export interface FilaCadencia {
  id: string;
  contactId: string;
  tipo: string;
  estado: string;
  motivoFin: string | null;
  inicio: Date | string;
  diaInicio: Date | string;
  /** #993: nombre de la cadencia en el catálogo y su plazo en días (null si va por fecha de recontacto). */
  nombre?: string;
  finDias?: number | null;
  /** La confirmación de baja sale aunque el contacto ya tenga «No contactar». */
  ignoraNoContactar?: boolean;
}

export interface FilaToque {
  id: string;
  cadenciaId: string;
  contactId: string;
  dia: number;
  fecha: Date | string;
  codigo: string;
  canal: string;
  orden: number;
  plantilla: string | null;
  cuando: string;
  variante: string | null;
  resultado: string | null;
  resultadoAt: Date | string | null;
  createdAt: Date | string;
  /** #993: cuándo toca; de aquí se cuentan las 24 h (las filas de la #988 lo tienen igual a createdAt). */
  programadoAt?: Date | string | null;
  nota?: string | null;
}

export interface FilaContacto {
  id: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  email: string | null;
  preferredLanguage: string | null;
  preferredZone: string | null;
  targetPlaza: string | null;
  estado: string | null;
  doNotContact: boolean;
  whatsappOptOut?: boolean;
  /** AAAA-MM-DD; llena [MES] del toque B2a («te escribo en [MES]»). */
  fechaRecontacto?: string | null;
  assignedToId: string | null;
}

export interface FilaAsesor {
  id: string;
  name: string;
  role: string;
  phone: string | null;
}

export interface FilaTemperatura {
  contactId: string;
  temperatura: string | null;
  orden: number;
  motivo: string;
}

export interface VarianteLista {
  valor: string;
  etiqueta: string;
  texto: TextoListo | null;
}

export interface ToqueListo {
  id: string;
  codigo: string;
  canal: Canal;
  canalLabel: string;
  orden: number;
  cuando: string;
  resultado: string | null;
  resultadoAt: string | null;
  vencido: boolean;
  /** Texto con las variables llenas. null en las llamadas (llevan guion, no plantilla). */
  texto: TextoListo | null;
  /** Solo WA3/WA4/Correo 3/Correo 4. */
  variantes: VarianteLista[] | null;
  variante: string | null;
  /** Por qué no se puede hacer (sin teléfono, sin correo, No contactar). null si se puede. */
  bloqueo: string | null;
  /** Aviso del paso («Solo si contestó sin horario»). */
  nota: string | null;
}

export interface TareaLista {
  /** `${cadenciaId}:${fecha}` */
  clave: string;
  cadenciaId: string;
  tipo: string;
  /** Nombre de la cadencia («Cadencia de nuevos», «Agendar cita»…). */
  nombreCadencia: string;
  dia: number;
  /** Plazo en días; null si la cadencia va por fecha de recontacto. */
  ultimoDia: number | null;
  fecha: string;
  vencida: boolean;
  pendientes: number;
  contacto: {
    id: string;
    nombre: string;
    telefono: string | null;
    correo: string | null;
    idioma: Idioma;
    pais: Pais;
    estado: string | null;
    temperatura: string | null;
    motivoTemperatura: string | null;
  };
  toques: ToqueListo[];
}

function iso(d: Date | string | null): string | null {
  if (!d) return null;
  return new Date(d).toISOString();
}

/** Fecha (AAAA-MM-DD) de una columna DATE, venga como Date (UTC) o como texto. */
export function fechaDe(d: Date | string): string {
  return typeof d === "string" ? d.slice(0, 10) : d.toISOString().slice(0, 10);
}

/** Variables de la plantilla para un contacto, su asesor y el idioma del lead. */
const MESES: Record<Idioma, string[]> = {
  ES: ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"],
  EN: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
};

/** Nombre del mes de una fecha AAAA-MM-DD (o de `ahora`). */
export function nombreMes(fecha: string | null, ahora: Date, idioma: Idioma): string {
  const m = fecha ? Number(fecha.slice(5, 7)) - 1 : new Date(ahora.getTime() - 5 * 3_600_000).getUTCMonth();
  return MESES[idioma][m] ?? MESES[idioma][0];
}

export function variablesDe(
  c: FilaContacto,
  asesor: FilaAsesor | null,
  idioma: Idioma,
  plantillas: readonly Plantilla[],
  ahora: Date = new Date(),
): VariablesPlantilla {
  const zona = zonaDelContacto(c.preferredZone, c.targetPlaza);
  const clave = claveDeZona(zona);
  const linea = elegirPlantilla(plantillas, "LINEA_VALOR", idioma, varianteLineaValor(clave));
  const cifraVar = varianteCifra(clave);
  const cifra = cifraVar ? elegirPlantilla(plantillas, "CIFRA", "ES", cifraVar) : null;
  return {
    nombre: c.firstName?.trim() || null,
    asesor: asesor?.name?.trim() || null,
    rol: asesor ? rolDelAsesor(asesor.role, idioma) : null,
    proyecto: null,
    zona,
    waAsesor: enlaceWhatsApp(asesor?.phone),
    lineaValor: linea?.cuerpo ?? null,
    cifra: cifra?.cuerpo?.trim() || null,
    mes: nombreMes(null, ahora, idioma),
  };
}

function bloqueoDe(canal: Canal, c: FilaContacto, ignoraNoContactar: boolean): string | null {
  if (c.doNotContact && !ignoraNoContactar) return "Marcado como No contactar";
  if (canal === "CORREO") return c.email ? null : "Sin correo";
  if (canal === "WHATSAPP" && c.whatsappOptOut) return "Pidió no recibir WhatsApp";
  if (canal === "MISMO_CANAL") return null;
  return c.phone && c.phone.trim() ? null : "Sin teléfono";
}

/** Un toque con su texto listo. */
export function toqueListo(
  t: FilaToque,
  c: FilaContacto,
  varsBase: VariablesPlantilla,
  idioma: Idioma,
  pais: Pais,
  plantillas: readonly Plantilla[],
  ahora: Date,
  ignoraNoContactar = false,
): ToqueListo {
  const canal = t.canal as Canal;
  // [MES] del B2a es el mes que pidió el lead («te escribo en [MES]»); en el resto, el mes en curso.
  const vars = t.codigo === "B2A" && c.fechaRecontacto ? { ...varsBase, mes: nombreMes(c.fechaRecontacto, ahora, idioma) } : varsBase;
  const opciones = t.plantilla ? VARIANTES[t.plantilla] ?? null : null;
  const variante = opciones ? t.variante || varianteInicial(t.plantilla!, { pais, idioma }) : null;
  const variantes = opciones
    ? opciones.map((o) => ({
        valor: o.valor,
        etiqueta: o.etiqueta,
        texto: textoListo(elegirPlantilla(plantillas, t.plantilla!, idioma, o.valor), vars, idioma),
      }))
    : null;
  const texto = t.plantilla
    ? variantes
      ? variantes.find((v) => v.valor === variante)?.texto ?? null
      : textoListo(elegirPlantilla(plantillas, t.plantilla, idioma), vars, idioma)
    : null;
  return {
    id: t.id,
    codigo: t.codigo,
    canal,
    canalLabel: CANAL_LABELS[canal] ?? t.canal,
    orden: t.orden,
    cuando: t.cuando,
    resultado: t.resultado,
    resultadoAt: iso(t.resultadoAt),
    vencido: !t.resultado && estaVencida(t.programadoAt ?? t.createdAt, ahora),
    texto,
    variantes,
    variante,
    bloqueo: bloqueoDe(canal, c, ignoraNoContactar),
    nota: t.nota ?? null,
  };
}

export interface EntradaArmar {
  cadencias: readonly FilaCadencia[];
  toques: readonly FilaToque[];
  contactos: readonly FilaContacto[];
  asesores: readonly FilaAsesor[];
  temperaturas: readonly FilaTemperatura[];
  plantillas: readonly Plantilla[];
  ahora: Date;
}

/** Agrupa los toques por contacto y día y les llena el texto. Sin ordenar. */
export function armarTareas(e: EntradaArmar): TareaLista[] {
  const cad = new Map(e.cadencias.map((k) => [k.id, k]));
  const con = new Map(e.contactos.map((c) => [c.id, c]));
  const ase = new Map(e.asesores.map((a) => [a.id, a]));
  const tem = new Map(e.temperaturas.map((t) => [t.contactId, t]));

  const grupos = new Map<string, FilaToque[]>();
  for (const t of e.toques) {
    const clave = `${t.cadenciaId}:${fechaDe(t.fecha)}`;
    const g = grupos.get(clave);
    if (g) g.push(t);
    else grupos.set(clave, [t]);
  }

  const out: TareaLista[] = [];
  for (const [clave, toques] of grupos) {
    const k = cad.get(toques[0].cadenciaId);
    const c = con.get(toques[0].contactId);
    if (!k || !c) continue;
    const idioma: Idioma = c.preferredLanguage === "EN" ? "EN" : "ES";
    const pais = paisDeTelefono(normalizePhoneE164(c.phone));
    const asesor = c.assignedToId ? ase.get(c.assignedToId) ?? null : null;
    const vars = variablesDe(c, asesor, idioma, e.plantillas, e.ahora);
    const listos = [...toques]
      .sort((a, b) => new Date(a.programadoAt ?? a.createdAt).getTime() - new Date(b.programadoAt ?? b.createdAt).getTime() || a.orden - b.orden)
      .map((t) => toqueListo(t, c, vars, idioma, pais, e.plantillas, e.ahora, !!k.ignoraNoContactar));
    const temp = tem.get(c.id);
    out.push({
      clave,
      cadenciaId: k.id,
      tipo: k.tipo,
      nombreCadencia: k.nombre ?? k.tipo,
      dia: toques[0].dia,
      ultimoDia: k.finDias ?? null,
      fecha: fechaDe(toques[0].fecha),
      vencida: listos.some((t) => t.vencido),
      pendientes: listos.filter((t) => !t.resultado).length,
      contacto: {
        id: c.id,
        nombre: `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim() || "Sin nombre",
        telefono: c.phone,
        correo: c.email,
        idioma,
        pais,
        estado: c.estado,
        temperatura: temp?.temperatura ?? null,
        motivoTemperatura: temp?.motivo ?? null,
      },
      toques: listos,
    });
  }
  return out;
}

export interface MiDia {
  /** Las tareas con algo pendiente, en orden y hasta el tope. */
  tareas: TareaLista[];
  /** Cuántas tareas pendientes quedaron fuera por el tope. */
  fueraDelTope: number;
  /** Tareas de hoy ya terminadas. */
  hechasHoy: TareaLista[];
  vencidas: number;
}

/** Ordena (calientes → nuevos en su tiempo → resto por temperatura) y aplica el tope. */
export function ordenarMiDia(
  tareas: readonly TareaLista[],
  hoy: string,
  tope: number,
  ordenTemperatura: (contactId: string) => number | null,
  inicioDe: (cadenciaId: string) => Date | string,
): MiDia {
  const pendientes = tareas.filter((t) => t.pendientes > 0);
  const hechasHoy = tareas.filter((t) => t.pendientes === 0 && t.fecha === hoy);
  const ordenadas = [...pendientes].sort((a, b) =>
    compararTareas(
      {
        ordenTemperatura: ordenTemperatura(a.contacto.id),
        dia: a.dia,
        fecha: a.fecha,
        l1Pendiente: a.toques.some((t) => t.codigo === "L1" && !t.resultado),
        inicio: inicioDe(a.cadenciaId),
      },
      {
        ordenTemperatura: ordenTemperatura(b.contacto.id),
        dia: b.dia,
        fecha: b.fecha,
        l1Pendiente: b.toques.some((t) => t.codigo === "L1" && !t.resultado),
        inicio: inicioDe(b.cadenciaId),
      },
    ),
  );
  return {
    tareas: ordenadas.slice(0, tope),
    fueraDelTope: Math.max(0, ordenadas.length - tope),
    hechasHoy,
    vencidas: pendientes.filter((t) => t.vencida).length,
  };
}
