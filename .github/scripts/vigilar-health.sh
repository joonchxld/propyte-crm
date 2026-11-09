#!/usr/bin/env bash
# #905 (seguimiento de la #771) — vigila /api/health desde fuera del VPS y le avisa a
# una persona cuando el CRM no responde.
#
# Por qué existe: en septiembre el CRM estuvo ~3 días devolviendo 500 (5,399 errores en el
# log) y lo descubrió una persona al abrir la página. El log tenía la causa desde el primer
# minuto; lo que faltaba era que alguien la RECIBIERA. La #771 dejó la ruta `/api/health`,
# que hace un `SELECT 1` real; esto es lo que la llama y avisa.
#
# Qué hace:
#   1. Pide la ruta. Cuenta como sana SOLO si da HTTP 200 **y** el cuerpo trae "ok":true.
#      (Un 200 con otra cosa —p. ej. una página de error del hosting servida con 200— no
#      cuenta como sano.)
#   2. Si falla, espera REINTENTO_SEG y vuelve a probar. Dos fallos seguidos = caída. Un
#      fallo aislado (red lenta, un reinicio de segundos) solo deja un aviso en el log.
#   3. Caída y no hay incidente abierto → abre UN issue con la etiqueta $ETIQUETA, asignado
#      a $AVISAR_A y con @mención (la mención avisa aunque la asignación falle), y sale
#      con 1 para que la corrida quede en rojo.
#      Caída y ya hay incidente abierto → no duplica; si el último aviso tiene más de
#      RECORDAR_HORAS, deja un comentario de recordatorio (que vuelve a notificar).
#   4. Sana y hay incidente abierto → comenta la recuperación y lo cierra.
#
# Lo que esto NO hace (declarado a propósito, para no creerlo más fuerte de lo que es):
#   - No detecta en minutos: el cron de GitHub es cada 30 min y GitHub suele retrasarlo
#     5-15 min más en horas de carga. Pasa de «días» a «menos de una hora», no a «al
#     instante».
#   - No distingue «cayó el CRM» de «cayó la red entre GitHub y el VPS». Para eso están
#     los dos intentos; si los dos fallan, se avisa igual y lo decide una persona.
#   - No sabe qué versión está publicada: después de un push a main solo comprueba que lo
#     que sea que esté sirviendo el VPS responda. Si el proceso viejo sigue vivo y el
#     nuevo cae horas después (como el 10→11 de septiembre), lo atrapa el cron, no esta
#     comprobación posterior al push.
#   - Que el aviso LLEGUE depende de la configuración de notificaciones de GitHub de quien
#     lo recibe (correo / app). Eso no se puede comprobar desde aquí.
set -uo pipefail

HEALTH_URL="${HEALTH_URL:-https://crm.propyte.com/api/health}"
AVISAR_A="${AVISAR_A:-Propyte-Luis}"
ETIQUETA="${ETIQUETA:-caida-crm}"
REINTENTO_SEG="${REINTENTO_SEG:-60}"
TIMEOUT_SEG="${TIMEOUT_SEG:-20}"
RECORDAR_HORAS="${RECORDAR_HORAS:-6}"
MOTIVO="${MOTIVO:-manual}"
RUN_URL="${RUN_URL:-}"

ultimo_codigo=""
ultimo_cuerpo=""

# Devuelve 0 si la ruta está sana. Deja el código y un extracto del cuerpo en las globales.
comprobar() {
  local tmp
  tmp="$(mktemp)"
  ultimo_codigo="$(curl -sS -o "$tmp" -w '%{http_code}' --max-time "$TIMEOUT_SEG" \
    -H 'Cache-Control: no-cache' "$HEALTH_URL" 2>/dev/null)" || true
  [ -z "$ultimo_codigo" ] && ultimo_codigo="000"
  # Extracto corto y en una línea: si el servidor devuelve una página HTML, no queremos
  # pegarla entera en el issue.
  ultimo_cuerpo="$(head -c 300 "$tmp" | tr '\r\n\t' '   ')"
  rm -f "$tmp"
  [ "$ultimo_codigo" = "200" ] && printf '%s' "$ultimo_cuerpo" | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true'
}

incidente_abierto() {
  gh issue list --label "$ETIQUETA" --state open --limit 1 --json number --jq '.[0].number // empty'
}

ahora_utc() { date -u '+%Y-%m-%d %H:%M UTC'; }

# --- 1 y 2: dos intentos ---------------------------------------------------------------
if comprobar; then
  sano=1
else
  primer="HTTP ${ultimo_codigo}"
  echo "::warning::Primer intento falló (${primer}). Reintento en ${REINTENTO_SEG}s."
  sleep "$REINTENTO_SEG"
  if comprobar; then
    sano=1
    echo "::warning::Fallo aislado: el primer intento dio ${primer} y el segundo respondió bien. No se avisa."
  else
    sano=0
  fi
fi

abierto="$(incidente_abierto)" || {
  echo "::error::No se pudo consultar los issues de GitHub (¿permiso issues: write?)."
  exit 1
}

# --- 4: sano ----------------------------------------------------------------------------
if [ "$sano" = "1" ]; then
  echo "CRM sano: HTTP ${ultimo_codigo} ${ultimo_cuerpo}"
  if [ -n "$abierto" ]; then
    gh issue comment "$abierto" --body "🟢 **Recuperado** — \`${HEALTH_URL}\` volvió a responder \`HTTP ${ultimo_codigo}\` \`${ultimo_cuerpo}\` a las $(ahora_utc).

Comprobación: ${RUN_URL:-(ejecución local)}

Cierro el incidente. Si la causa no quedó clara, conviene anotarla aquí antes de olvidarla." \
      && gh issue close "$abierto" --reason completed
    echo "Incidente #${abierto} cerrado."
  fi
  exit 0
fi

# --- 3: caído ---------------------------------------------------------------------------
echo "::error::CRM caído: dos intentos seguidos fallaron. Último: HTTP ${ultimo_codigo} ${ultimo_cuerpo}"

if [ -n "$abierto" ]; then
  # Ya hay incidente: no duplicar. Recordar solo si el último aviso es viejo.
  ultimo_aviso="$(gh issue view "$abierto" --json createdAt,comments \
    --jq '([.createdAt] + [.comments[].createdAt]) | max')" || ultimo_aviso=""
  if [ -n "$ultimo_aviso" ]; then
    edad_h=$(( ( $(date -u +%s) - $(date -u -d "$ultimo_aviso" +%s) ) / 3600 ))
  else
    edad_h=0
  fi
  if [ "$edad_h" -ge "$RECORDAR_HORAS" ]; then
    gh issue comment "$abierto" --body "🔴 @${AVISAR_A} **sigue caído** a las $(ahora_utc): \`HTTP ${ultimo_codigo}\` \`${ultimo_cuerpo}\`.

Comprobación: ${RUN_URL:-(ejecución local)}"
    echo "Recordatorio dejado en el incidente #${abierto} (último aviso hace ${edad_h} h)."
  else
    echo "Incidente #${abierto} ya abierto (último aviso hace ${edad_h} h). Sin duplicar."
  fi
  # Corrida en verde mientras el incidente ya está abierto: el aviso es el issue. Si cada
  # corrida quedara en rojo, GitHub mandaría un correo de «workflow falló» cada 30 min a
  # quien editó el cron por última vez, y un aviso que llega cada media hora se deja de leer.
  exit 0
fi

gh label create "$ETIQUETA" --color B60205 \
  --description "El monitor de /api/health detectó el CRM caído (#905)" >/dev/null 2>&1 || true

titulo="🔴 CRM caído: /api/health no responde ($(ahora_utc))"
cuerpo="@${AVISAR_A} el monitor externo del CRM detectó una caída.

| | |
|---|---|
| Ruta | \`${HEALTH_URL}\` |
| Respuesta | \`HTTP ${ultimo_codigo}\` |
| Cuerpo (extracto) | \`${ultimo_cuerpo:-(vacío)}\` |
| Intentos | 2 seguidos, separados por ${REINTENTO_SEG}s |
| Disparado por | \`${MOTIVO}\` |
| Comprobación | ${RUN_URL:-(ejecución local)} |

**Qué significa:** \`/api/health\` hace un \`SELECT 1\` real contra la base. Si falla, todo lo que toca la base está caído —el tablero, la sesión y **los webhooks de Meta**, o sea que los leads que escriban ahora se están perdiendo— aunque \`/login\` siga cargando normal (así pasó en septiembre).

**Por dónde empezar:**
1. En el VPS: \`docker compose -f /opt/propyte/crm/docker-compose.yml logs --tail 200\` → buscar la primera línea de error; y \`tail -30 /var/log/crm-deploy.log\` por si falló un despliegue automático (guía: \`docs/infra/vps.md\`).
2. ¿Hubo un push a \`main\` justo antes? En septiembre la causa fue un build mal formado (\`Cannot find module '.prisma/client/default'\`).
3. Si \`HTTP 000\`: el servidor ni contestó (caído, DNS o red), no es un error de la app.

Este issue se cierra solo cuando la ruta vuelva a responder bien. Mientras siga abierto no se abre otro; se deja un recordatorio cada ${RECORDAR_HORAS} h.

_Monitor: \`.github/workflows/vigilancia-crm.yml\` · tarjetas #771 y #905 del Hub._"

if ! url="$(gh issue create --title "$titulo" --label "$ETIQUETA" --assignee "$AVISAR_A" --body "$cuerpo" 2>&1)"; then
  # La asignación falla si el usuario no existe o no tiene acceso al repo. La @mención del
  # cuerpo sigue notificando, así que se abre sin asignar en vez de no abrir nada.
  echo "::warning::No se pudo asignar a ${AVISAR_A} (${url}). Abro el issue sin asignar."
  url="$(gh issue create --title "$titulo" --label "$ETIQUETA" --body "$cuerpo")" || {
    echo "::error::Tampoco se pudo abrir el issue. El CRM está caído y NADIE fue avisado."
    exit 1
  }
fi
echo "Incidente abierto: ${url}"
exit 1
