"use client";
import { createContext, useContext, useEffect, useReducer, useRef, useState, useCallback } from "react";
import Link from "next/link";
import { Phone, PhoneOff } from "lucide-react";
import { Device } from "@twilio/voice-sdk";
import type { Call } from "@twilio/voice-sdk";

import {
  ESTADO_INICIAL,
  datosDeLlamante,
  etiquetaLlamante,
  voiceReducer,
  type CallState,
  type DatosEntrante,
} from "./call-state";

interface VoiceCtx {
  ready: boolean;
  state: CallState;
  activeContactId: string | null;
  incoming: DatosEntrante | null;
  answer: () => void;
  reject: () => void;
  startCall: (to: string, contactId: string, userId: string) => Promise<void>;
  hangup: () => void;
}
const Ctx = createContext<VoiceCtx | null>(null);
export const useVoice = () => useContext(Ctx);

// Errores de token que se curan pidiendo uno nuevo:
//   20104 AccessTokenExpired — la pestaña durmió más de 1 h.
//   20101 AccessTokenInvalid — con @twilio/voice-sdk < 2.18.5 salía FALSO tras una caída del
//         WebSocket (el SDK reenviaba el registro antes de que el servidor validara el token;
//         ver CHANGELOG 2.18.5). El token de producción se verificó bien formado el 2026-10-22.
const ERRORES_DE_TOKEN = new Set([20104, 20101]);
// Caídas de red transitorias. El SDK ya las imprime en consola y reconecta solo: repetirlas
// con console.warn solo duplicaba cada línea roja con una amarilla.
const ERRORES_DE_RED = new Set([31005, 31009]);
// Tope de renovaciones seguidas: si el token falla de verdad (API key revocada, secret
// equivocado), no se queda pidiendo tokens para siempre.
const MAX_RENOVACIONES = 3;

/** Pide un token de voz nuevo. null = Twilio no configurado o petición fallida. */
async function fetchVoiceToken(): Promise<string | null> {
  try {
    const res = await fetch("/api/twilio/token");
    if (!res.ok) return null;
    const { token } = await res.json();
    return token ?? null;
  } catch {
    return null;
  }
}

export function VoiceDeviceProvider({ userId, children }: { userId?: string; children: React.ReactNode }) {
  const deviceRef = useRef<Device | null>(null);
  const callRef = useRef<Call | null>(null);
  const [ready, setReady] = useState(false);
  const [vs, dispatch] = useReducer(voiceReducer, ESTADO_INICIAL);
  const notifRef = useRef<Notification | null>(null);

  const cerrarNotificacion = useCallback(() => {
    notifRef.current?.close();
    notifRef.current = null;
  }, []);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    // El Device vive en el closure del efecto, no solo en deviceRef: antes se asignaba a
    // deviceRef DESPUÉS de `await device.register()`, así que si el registro fallaba o el
    // efecto se limpiaba a medio registro, el cleanup no lo encontraba y el Device quedaba
    // vivo, reconectando y llenando la consola sin que nada lo pudiera destruir.
    let device: Device | null = null;
    let renovaciones = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const renovarYRegistrar = async () => {
      const fresh = await fetchVoiceToken();
      if (cancelled || !device || !fresh) return;
      device.updateToken(fresh);
      try {
        await device.register();
      } catch {
        /* el evento "error" ya lo reportó */
      }
    };

    (async () => {
      const token = await fetchVoiceToken();
      if (cancelled || !token) return; // sin Twilio configurado → degrada silencioso

      device = new Device(token, { logLevel: "error" });
      deviceRef.current = device;

      // El token dura 1 h. El SDK avisa ~10 s antes de que venza: se pide uno
      // nuevo y se le pasa al Device sin colgar ni desregistrar.
      device.on("tokenWillExpire", async () => {
        const fresh = await fetchVoiceToken();
        if (fresh && !cancelled) device?.updateToken(fresh);
      });

      device.on("error", (err: { code?: number; message?: string }) => {
        if (err.code !== undefined && ERRORES_DE_TOKEN.has(err.code)) {
          if (renovaciones >= MAX_RENOVACIONES) {
            console.warn("[TwilioVoice] el token sigue rechazado tras renovarlo; voz deshabilitada", err.code);
            return;
          }
          renovaciones += 1;
          if (timer) clearTimeout(timer);
          // Espera creciente (2 s, 4 s, 6 s) para no reintentar en ráfaga contra una red caída.
          timer = setTimeout(renovarYRegistrar, 2000 * renovaciones);
          return;
        }
        if (err.code !== undefined && ERRORES_DE_RED.has(err.code)) return;
        console.warn("[TwilioVoice]", err.code, err.message);
      });

      // "ready" refleja el estado real: sin registro no hay llamadas entrantes y las salientes
      // pueden fallar, así que el botón Llamar se oculta. Desde voice-sdk 2.18.4, al entrar y
      // salir del back/forward cache el Device emite unregistered → registered: es esperado.
      device.on("registered", () => {
        renovaciones = 0;
        if (!cancelled) setReady(true);
      });
      device.on("unregistered", () => {
        if (!cancelled) setReady(false);
      });
      device.on("incoming", (call: Call) => {
        // Ya hay una llamada en curso o timbrando en esta pestaña: no se pisa; las demás pestañas
        // (o el buzón, tras 20 s) la atienden.
        if (callRef.current) {
          call.ignore();
          return;
        }
        callRef.current = call;
        const datos = datosDeLlamante(call.customParameters, call.parameters);
        dispatch({ type: "incoming", datos });
        // El timbre lo reproduce el propio SDK (sonido "incoming", activo por defecto); si el
        // navegador bloquea el audio sin interacción, el SDK lo registra y no rompe nada.
        // Con la pestaña oculta y permiso ya concedido, aviso del sistema (no se pide permiso aquí).
        try {
          if (
            typeof document !== "undefined" &&
            document.visibilityState !== "visible" &&
            typeof Notification !== "undefined" &&
            Notification.permission === "granted"
          ) {
            notifRef.current?.close();
            const n = new Notification(`Llamada entrante de ${etiquetaLlamante(datos)}`, {
              tag: "llamada-entrante",
              requireInteraction: true,
            });
            n.onclick = () => {
              window.focus();
              n.close();
            };
            notifRef.current = n;
          }
        } catch {
          /* notificaciones no disponibles: solo timbre */
        }
        const terminar = (tipo: "cancel" | "disconnect") => {
          if (callRef.current === call) callRef.current = null;
          notifRef.current?.close();
          notifRef.current = null;
          dispatch({ type: tipo });
        };
        // "cancel": el llamante colgó antes de contestar, o OTRA pestaña/dispositivo contestó
        // (Twilio cancela las demás patas <Client> del mismo identity; el SDK emite "cancel").
        call.on("cancel", () => terminar("cancel"));
        call.on("disconnect", () => terminar("disconnect"));
        call.on("error", () => terminar("disconnect"));
      });

      try {
        await device.register();
      } catch {
        /* el evento "error" ya lo reportó y, si es de token, ya programó la renovación */
      }
    })();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      device?.destroy();
      device = null;
      deviceRef.current = null;
      callRef.current = null;
      notifRef.current?.close();
      notifRef.current = null;
      setReady(false);
    };
  }, [userId]);

  const startCall = useCallback(async (to: string, contactId: string, uid: string) => {
    if (!deviceRef.current) return;
    dispatch({ type: "dial", contactId });
    try {
      const call = await deviceRef.current.connect({ params: { To: to, contactId, userId: uid } });
      callRef.current = call;
      call.on("accept", () => dispatch({ type: "outbound-accept" }));
      call.on("ringing", () => dispatch({ type: "outbound-ringing" }));
      call.on("disconnect", () => { dispatch({ type: "disconnect" }); callRef.current = null; });
      call.on("cancel", () => { dispatch({ type: "disconnect" }); callRef.current = null; });
      call.on("error", () => dispatch({ type: "error" }));
    } catch {
      dispatch({ type: "error" });
    }
  }, []);

  const hangup = useCallback(() => {
    callRef.current?.disconnect();
    dispatch({ type: "disconnect" });
  }, []);

  const answer = useCallback(() => {
    const call = callRef.current;
    if (!call) return;
    cerrarNotificacion();
    call.accept();
    dispatch({ type: "accept" });
  }, [cerrarNotificacion]);

  // call.reject() hace que el <Dial> padre termine con DialCallStatus busy/no-answer
  // (docs de Twilio Voice SDK) → dial-action manda al llamante al buzón.
  const reject = useCallback(() => {
    const call = callRef.current;
    if (!call) return;
    cerrarNotificacion();
    call.reject();
    callRef.current = null;
    dispatch({ type: "reject" });
  }, [cerrarNotificacion]);

  const { state, activeContactId, incoming } = vs;
  return (
    <Ctx.Provider value={{ ready, state, activeContactId, incoming, answer, reject, startCall, hangup }}>
      {children}
      {state === "incoming" && incoming && (
        <div
          role="alertdialog"
          aria-label="Llamada entrante"
          className="fixed bottom-6 right-6 z-[100] w-80 rounded-xl border bg-white p-4 shadow-2xl"
        >
          <p className="text-[12px] font-medium uppercase tracking-wide text-gray-500">Llamada entrante</p>
          <p className="mt-1 text-[16px] font-semibold text-gray-900">
            {incoming.esNuevo ? "Número nuevo" : etiquetaLlamante(incoming)}
          </p>
          {(incoming.nombre || incoming.esNuevo) && incoming.telefono && (
            <p className="text-[13px] text-gray-600">{incoming.telefono}</p>
          )}
          {incoming.contactId && !incoming.esNuevo && (
            <Link href={`/contacts/${incoming.contactId}`} className="mt-1 inline-block text-[12px] text-blue-600 underline">
              Ver contacto
            </Link>
          )}
          <div className="mt-3 flex gap-2">
            <button className="btn-secondary flex-1 text-[13px]" onClick={reject}>
              <PhoneOff className="h-3.5 w-3.5" /> Rechazar
            </button>
            <button className="btn-primary flex-1 text-[13px]" onClick={answer}>
              <Phone className="h-3.5 w-3.5" /> Contestar
            </button>
          </div>
        </div>
      )}
    </Ctx.Provider>
  );
}
