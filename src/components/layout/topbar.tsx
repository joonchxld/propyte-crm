// Barra superior del CRM — Design System v2
"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { useSession, signOut } from "next-auth/react"
import { Search, Bell, LogOut } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
// Las opciones de sistema salieron del sidebar y viven aquí (pedido de Luis, ago-2026).
// Se importan de nav-config para que sidebar y menú compartan UNA sola definición de roles.
import { visibleUserMenuItems } from "./nav-config"
import { useToast } from "@/components/ui/use-toast"
import { ToastAction } from "@/components/ui/toast"
import { TIPO_AVISO_CORREO, contactoDelAviso } from "@/lib/google/aviso-correo"
import {
  avisosNuevos,
  asignacionesPendientesAlEntrar,
  avisarEnNavegador,
  debeRevisar,
  EVENTO_CORREO_ENTRANTE,
  TIPOS_AVISO_EMERGENTE,
  type PermisoNavegador,
} from "@/lib/notificaciones/avisos-nuevos"

/** Cada cuánto la campana vuelve a preguntar (#889). Además pregunta al volver a la pestaña. */
const REVISAR_CADA_MS = 30_000
/** Cuántos avisos no leídos trae cada revisión. */
const PAGINA_AVISOS = 10

/** El permiso de avisos del navegador, o `null` si el navegador no tiene la API (#915). */
function permisoNavegador(): PermisoNavegador {
  if (typeof window === "undefined" || !("Notification" in window)) return null
  return window.Notification.permission as PermisoNavegador
}

const MODULE_LABELS: Record<string, string> = {
  "/hoy": "Hoy",
  "/agenda": "Agenda",
  "/copilot": "Copilot",
  "/contacts": "Contactos",
  "/inbox": "Inbox",
  "/pipeline": "Negocios",
  "/cotizaciones": "Cotizaciones",
  "/cobranza": "Cobranza",
  "/developments": "Desarrollos y Propiedades",
  "/empresas": "Empresas", // #949: antes «Desarrolladores»
  "/commissions": "Comisiones",
  "/metas": "Metas",
  "/reports": "Reportes",
  "/reclutamiento": "Reclutamiento",
  "/cadencias": "Cadencias",
  "/career": "Mi Carrera",
  "/settings": "Mi Perfil",
  "/duplicados": "Duplicados",
  // Antes que "/conexiones": gana la primera ruta que empareja.
  "/conexiones/huerfanos": "Leads huérfanos",
  "/conexiones": "Conexiones",
  "/admin": "Configuración",
  "/configuracion": "Configuración",
}

type NotificationItem = {
  id: string
  title: string
  message: string
  type: string
  isRead: boolean
  link: string | null
  createdAt: string
}

export function Topbar() {
  const pathname = usePathname()
  const router = useRouter()
  const { data: session } = useSession()
  const moduleLabel =
    Object.entries(MODULE_LABELS).find(([href]) => pathname?.startsWith(href))?.[1] ?? ""
  const [unreadCount, setUnreadCount] = React.useState(0)
  const [notifications, setNotifications] = React.useState<NotificationItem[]>([])
  const [loadingNotifications, setLoadingNotifications] = React.useState(false)

  const { toast } = useToast()
  // Fecha del aviso más reciente ya visto (correo o asignación); null = aún no se revisa.
  const avisosVistoHasta = React.useRef<string | null>(null)
  // #915: si el navegador puede mostrar avisos. Se lee al montar y al pedir el permiso.
  const [permiso, setPermiso] = React.useState<PermisoNavegador>(null)
  React.useEffect(() => { setPermiso(permisoNavegador()) }, [])
  // El clic de un aviso del navegador ocurre fuera del ciclo de React: se lee la versión vigente.
  const abrirAvisoRef = React.useRef<(n: NotificationItem) => void>(() => {})

  // Conteo real de notificaciones no leídas + avisos emergentes (#889, #915).
  //
  // Antes el conteo se pedía UNA vez al montar la barra, que en la navegación interna no se
  // vuelve a montar: una notificación nueva no aparecía hasta recargar la página. Ahora se
  // pregunta cada 30 s y al volver a la pestaña. En la misma llamada vienen las últimas no
  // leídas de correo y de asignaciones (tarea, conversación, negocio, lead): las nuevas salen
  // como aviso en pantalla y, con la pestaña oculta y permiso concedido, como aviso del
  // navegador. Antes una asignación solo subía el número de la campana.
  React.useEffect(() => {
    if (!session?.user) return
    let alive = true

    const revisar = () => {
      const oculta = typeof document !== "undefined" && document.visibilityState === "hidden"
      const permisoActual = permisoNavegador()
      if (!debeRevisar(oculta, permisoActual)) return
      fetch(`/api/notifications?unreadOnly=true&type=${TIPOS_AVISO_EMERGENTE.join(",")}&pageSize=${PAGINA_AVISOS}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (!alive || !data) return
          if (typeof data.unreadCount === "number") setUnreadCount(data.unreadCount)
          const items = (Array.isArray(data.data) ? data.data : []) as NotificationItem[]
          const primeraVez = avisosVistoHasta.current === null
          const { nuevos, vistoHasta } = avisosNuevos(items, avisosVistoHasta.current)
          avisosVistoHasta.current = vistoHasta

          // Al entrar: un solo aviso con las asignaciones que quedaron sin ver.
          if (primeraVez) {
            const pendientes = asignacionesPendientesAlEntrar(items)
            if (pendientes.length > 0) {
              const ultima = pendientes[0]
              toast({
                title:
                  pendientes.length === 1
                    ? ultima.title
                    : `Tienes ${pendientes.length >= PAGINA_AVISOS ? `${PAGINA_AVISOS} o más` : pendientes.length} asignaciones sin ver`,
                description: ultima.message,
                action: ultima.link ? (
                  <ToastAction altText="Ver" onClick={() => abrirAvisoRef.current(ultima)}>
                    Ver
                  </ToastAction>
                ) : undefined,
              })
            }
            return
          }
          if (nuevos.length === 0) return

          for (const n of nuevos) {
            if (n.type !== TIPO_AVISO_CORREO) continue
            const contactId = contactoDelAviso(n.link)
            if (contactId) window.dispatchEvent(new CustomEvent(EVENTO_CORREO_ENTRANTE, { detail: { contactId } }))
          }

          if (avisarEnNavegador(oculta, permisoActual)) {
            // Uno por aviso, hasta 3: más que eso es una ráfaga que nadie lee.
            for (const n of nuevos.slice(-3)) {
              try {
                const aviso = new window.Notification(n.title, { body: n.message, tag: n.id })
                aviso.onclick = () => {
                  window.focus()
                  abrirAvisoRef.current(n)
                  aviso.close()
                }
              } catch {
                // Algunos navegadores (Android) solo permiten avisos desde un service worker.
              }
            }
          }

          // El Toaster muestra uno a la vez: el más reciente, con cuántos más llegaron.
          const ultimo = nuevos[nuevos.length - 1]
          const extra = nuevos.length > 1 ? ` (y ${nuevos.length - 1} más)` : ""
          toast({
            title: `${ultimo.title}${extra}`,
            description: ultimo.message,
            action: ultimo.link ? (
              <ToastAction altText="Ver" onClick={() => abrirAvisoRef.current(ultimo)}>
                Ver
              </ToastAction>
            ) : undefined,
          })
        })
        .catch(() => {})
    }

    revisar()
    const intervalo = setInterval(revisar, REVISAR_CADA_MS)
    const alVolver = () => { if (document.visibilityState === "visible") revisar() }
    document.addEventListener("visibilitychange", alVolver)
    return () => {
      alive = false
      clearInterval(intervalo)
      document.removeEventListener("visibilitychange", alVolver)
    }
  }, [session?.user, toast])

  // Antes el botón de la campana no tenía ningún manejador de click, así que
  // no pasaba nada al darle clic. Ahora abre un panel con las notificaciones
  // recientes (se piden al backend al abrir, /api/notifications ya existía).
  const loadNotifications = React.useCallback(() => {
    if (!session?.user) return
    setLoadingNotifications(true)
    fetch("/api/notifications?pageSize=10")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (Array.isArray(data?.data)) setNotifications(data.data)
        if (typeof data?.unreadCount === "number") setUnreadCount(data.unreadCount)
      })
      .catch(() => {})
      .finally(() => setLoadingNotifications(false))
  }, [session?.user])

  const handleNotificationClick = (notification: NotificationItem) => {
    if (!notification.isRead) {
      fetch("/api/notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notificationIds: [notification.id] }),
      }).catch(() => {})
      setNotifications((prev) =>
        prev.map((item) => (item.id === notification.id ? { ...item, isRead: true } : item))
      )
      setUnreadCount((prev) => Math.max(0, prev - 1))
    }
    if (notification.link) router.push(notification.link)
  }

  // Fuera del render: el aviso del navegador y el del resumen llaman siempre a la versión vigente.
  React.useEffect(() => { abrirAvisoRef.current = handleNotificationClick })

  // #915: el permiso se pide con un clic (los navegadores ignoran o castigan pedirlo solos).
  const activarAvisosNavegador = () => {
    if (permiso !== "default") return
    window.Notification.requestPermission()
      .then((p) => setPermiso(p as PermisoNavegador))
      .catch(() => {})
  }

  const handleMarkAllRead = () => {
    if (unreadCount === 0) return
    fetch("/api/notifications", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markAll: true }),
    }).catch(() => {})
    setNotifications((prev) => prev.map((item) => ({ ...item, isRead: true })))
    setUnreadCount(0)
  }

  // Las notificaciones ya leídas se quedaban acumuladas para siempre, sin forma
  // de limpiar el panel (backend nuevo: DELETE /api/notifications).
  const handleDeleteAll = () => {
    if (notifications.length === 0) return
    fetch("/api/notifications", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deleteAll: true }),
    }).catch(() => {})
    setNotifications([])
    setUnreadCount(0)
  }

  const userName = session?.user?.name || "Usuario"
  const userEmail = session?.user?.email || ""
  const userRole = (session?.user as { role?: string })?.role || "ASESOR"
  const menuItems = React.useMemo(() => visibleUserMenuItems(userRole), [userRole])

  const initials = userName
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2)

  return (
    <header
      className="flex h-12 items-center justify-between px-4"
      style={{ background: "var(--bg-sidebar)", borderBottom: "1px solid var(--border-subtle)" }}
    >
      {/* Módulo activo + búsqueda con hint de teclado */}
      <div className="flex items-center gap-4">
        <span className="text-[13px] font-semibold tracking-tight" style={{ color: "var(--text-primary)" }}>
          {moduleLabel}
        </span>
        <div className="relative hidden w-72 sm:block">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2" style={{ color: "var(--text-tertiary)" }} />
          <input
            type="text"
            placeholder="Buscar contactos, deals..."
            className="form-input py-1.5 pl-8 pr-12 text-[13px]"
            style={{ background: "var(--bg-input)", height: "32px" }}
          />
          <span className="kbd absolute right-2 top-1/2 -translate-y-1/2">⌘K</span>
        </div>
      </div>

      {/* Right actions */}
      <div className="flex items-center gap-2">
        {/* Role badge */}
        <span
          className="rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
          style={{ background: "var(--color-teal-light)", color: "var(--color-teal)" }}
        >
          {userRole}
        </span>

        {/* Notifications */}
        <DropdownMenu onOpenChange={(open) => { if (open) loadNotifications() }}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Notificaciones"
              className="relative flex h-8 w-8 items-center justify-center rounded-md transition-colors"
              style={{ color: "var(--text-secondary)" }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)" }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent" }}
            >
              <Bell className="h-4 w-4" />
              {unreadCount > 0 && (
                <span
                  className="absolute -right-0.5 -top-0.5 flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-bold text-white"
                  style={{ background: "var(--color-error)" }}
                >
                  {unreadCount}
                </span>
              )}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-80" align="end" forceMount>
            <DropdownMenuLabel className="flex items-center justify-between font-normal">
              <span className="text-sm font-medium">Notificaciones</span>
              <div className="flex items-center gap-2">
                {unreadCount > 0 && (
                  <button
                    type="button"
                    className="text-[11px] font-medium"
                    style={{ color: "var(--color-teal)" }}
                    onClick={(e) => { e.stopPropagation(); handleMarkAllRead() }}
                  >
                    Marcar todas como leídas
                  </button>
                )}
                {notifications.length > 0 && (
                  <button
                    type="button"
                    className="text-[11px] font-medium text-destructive"
                    onClick={(e) => { e.stopPropagation(); handleDeleteAll() }}
                  >
                    Eliminar todo
                  </button>
                )}
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {permiso === "default" && (
              <button
                type="button"
                className="mx-2 mb-1 w-[calc(100%-1rem)] rounded-md px-2 py-1.5 text-left text-[12px] font-medium"
                style={{ background: "var(--color-teal-light)", color: "var(--color-teal)" }}
                onClick={(e) => { e.stopPropagation(); activarAvisosNavegador() }}
              >
                Activar avisos del navegador para enterarte de lo que te asignan aunque estés en otra pestaña
              </button>
            )}
            {loadingNotifications && (
              <div className="px-2 py-4 text-center text-[12px]" style={{ color: "var(--text-tertiary)" }}>
                Cargando...
              </div>
            )}
            {!loadingNotifications && notifications.length === 0 && (
              <div className="px-2 py-4 text-center text-[12px]" style={{ color: "var(--text-tertiary)" }}>
                Sin notificaciones
              </div>
            )}
            {!loadingNotifications && notifications.length > 0 && (
              <div className="max-h-80 overflow-y-auto">
                {notifications.map((notification) => (
                  <DropdownMenuItem
                    key={notification.id}
                    className="flex flex-col items-start gap-0.5 whitespace-normal py-2"
                    onClick={() => handleNotificationClick(notification)}
                  >
                    <div className="flex w-full items-center gap-1.5">
                      {!notification.isRead && (
                        <span
                          className="h-1.5 w-1.5 shrink-0 rounded-full"
                          style={{ background: "var(--color-error)" }}
                        />
                      )}
                      <span className="text-[13px] font-medium">{notification.title}</span>
                    </div>
                    <span className="text-[12px]" style={{ color: "var(--text-secondary)" }}>
                      {notification.message}
                    </span>
                  </DropdownMenuItem>
                ))}
              </div>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* User dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex h-8 w-8 items-center justify-center rounded-full text-[10px] font-semibold" style={{ background: "var(--color-teal)", color: "var(--text-inverse)" }}>
              {initials}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-56" align="end" forceMount>
            <DropdownMenuLabel className="font-normal">
              <div className="flex flex-col space-y-1">
                <p className="text-sm font-medium leading-none">{userName}</p>
                <p className="text-xs leading-none text-muted-foreground">{userEmail}</p>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {/* Antes había dos items sin `href` que no navegaban a ningún lado.
                Ahora cada uno es un Link real y la lista se filtra por rol. */}
            {menuItems.map((item) => {
              const Icon = item.icon
              return (
                <DropdownMenuItem key={item.href} asChild>
                  <Link href={item.href} className="cursor-pointer">
                    <Icon className="mr-2 h-4 w-4" />
                    <span>{item.label}</span>
                  </Link>
                </DropdownMenuItem>
              )
            })}
            {menuItems.length > 0 && <DropdownMenuSeparator />}
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onClick={() => signOut()}
            >
              <LogOut className="mr-2 h-4 w-4" />
              <span>Cerrar Sesión</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
