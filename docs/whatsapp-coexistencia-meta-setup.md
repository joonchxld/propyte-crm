# Configurar Meta para «Conectar WhatsApp (oficial)»

**Para quién:** la persona que administra la app de Meta de Propyte CRM y el VPS donde corre el CRM. No hace
falta saber programar. **Fecha:** 2026-10-14.

Con esto, un WhatsApp Business que ya se usa en el teléfono (el de Yaxnáh, el de cada asesor) se conecta al
CRM **sin dejar de funcionar en el teléfono**. Meta lo llama «Coexistence» (coexistencia) y usa una pantalla
de Meta llamada **Embedded Signup** (versión 4; la versión 2 deja de funcionar el 15 de octubre de 2026).

Para que funcione, Propyte CRM tiene que ser **Tech Provider** de Meta. Abajo va todo, en orden. Marca cada
casilla cuando la termines.

> Detalle técnico y decisiones: `docs/superpowers/specs/2026-10-14-whatsapp-coexistencia-design.md`.

---

## 0. Antes de empezar

- [ ] Tienes rol de **administrador** en la app de Meta de Propyte CRM (developers.facebook.com → Mis apps).
- [ ] La app es de tipo **Business** y está ligada al portafolio comercial (Business Manager) de Propyte.
- [ ] Tienes acceso por SSH al **VPS** del CRM para poner variables de entorno y redesplegar (ver `docs/infra/vps.md`).
- [ ] La dirección del CRM es **https://crm.propyte.com** (con candado: Meta exige HTTPS).

---

## 1. Volverse Tech Provider

Fuente: [Become a Tech Provider](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/get-started-for-tech-providers)

1. [ ] En el App Dashboard: **Casos de uso → WhatsApp → Personalizar → Incorporación de Tech Provider**
   (*Use cases > Customize > Tech Provider onboarding*). Si te pregunta, elige **Independent Tech Provider**
   (Propyte da el servicio por su cuenta).
2. [ ] **Verificar el negocio** (*Start verification*): nombre, dirección, teléfono, correo y sitio de Propyte.
   Puede pedir documentos. Tarda unos días.
3. [ ] **Datos básicos de la app** (*App settings > Basic*): ícono, URL de política de privacidad, categoría.
4. [ ] **App Review** — pedir **acceso avanzado** a estos dos permisos (se puede hacer después de probar,
   ver el paso 7):
   - [ ] `whatsapp_business_messaging` — para mandar y recibir mensajes por los clientes conectados.
   - [ ] `whatsapp_business_management` — para conectar clientes y administrar sus cuentas.
   Meta pide **dos videos**: uno mandando un mensaje desde el CRM que llega a WhatsApp, y otro creando una
   plantilla de mensaje (puede ser desde WhatsApp Manager).

> Mientras App Review no esté aprobado, el botón solo funciona para personas con rol en la app (administrador,
> desarrollador o tester). Sirve para probar con el número de Yaxnáh antes de abrirlo a todos los asesores.

---

## 2. Dominios permitidos (Facebook Login for Business)

Fuente: [Implementation, Step 1](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/implementation/)

En el App Dashboard: **Facebook Login for Business → Configuración → Configuración de OAuth del cliente**
(*Settings > Client OAuth settings*).

- [ ] Poner en **Sí**: *Client OAuth login*, *Web OAuth login*, *Enforce HTTPS*, *Embedded Browser OAuth Login*,
  *Use Strict Mode for redirect URIs* y *Login with the JavaScript SDK*.
- [ ] En **Allowed domains for the JavaScript SDK** agregar: `crm.propyte.com`
- [ ] En **Valid OAuth redirect URIs** agregar: `https://crm.propyte.com/`
- [ ] Si se prueba en otro dominio (por ejemplo uno de pruebas con HTTPS), agregarlo también en los dos campos.
- [ ] Guardar cambios.

Sin esto, Meta **no devuelve** al CRM los datos del número al terminar y el botón se queda esperando.

---

## 3. Crear la configuración de Embedded Signup y copiar su ID (`config_id`)

Fuentes: [Implementation, Step 2](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/implementation/),
[Version 4](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/version-4)

En el App Dashboard: **Facebook Login for Business → Configuraciones (*Configurations*) → Crear configuración**.

1. [ ] Nombre: por ejemplo «CRM · WhatsApp coexistencia v4».
2. [ ] Variación de inicio de sesión: **WhatsApp Embedded Signup**.
3. [ ] Productos: marca **WhatsApp Cloud API** (es lo que hace que sea la versión 4). No marques productos que
   no se van a usar.
4. [ ] Activos y permisos: deja **WhatsApp accounts** (viene marcado) y los permisos que Meta propone para Cloud
   API (`whatsapp_business_management`, `whatsapp_business_messaging`). No agregues Páginas, catálogos ni
   cuentas publicitarias: si los pides, la gente se atora en esas pantallas.
5. [ ] Al terminar, Meta muestra el **ID de la configuración** con un botón «Copiar». Ese número es el
   `config_id`: guárdalo para el paso 5.

Si ya existía una configuración vieja (v2 o v3), **crea una nueva**: Meta dice que las de v2 dejan de funcionar
el 15 de octubre de 2026.

Para probarla antes de tocar el CRM: **App Dashboard → WhatsApp → Embedded Signup Builder**, elige la
configuración nueva y pulsa «Login with Facebook».

---

## 4. Campos del webhook

Fuentes: [Onboard WhatsApp Business app users, Step 1](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users),
[Implementation](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/implementation/)

En el App Dashboard: **WhatsApp → Configuración** (*Configuration*). La URL ya existe y **no cambia**:
`https://crm.propyte.com/api/webhooks/whatsapp/meta`.

En **Campos del webhook** (*Webhook fields*), suscribir (además de `messages`, que ya está):

- [ ] `account_update` — avisa cuando el negocio se desconecta, cambia de teléfono o se reconecta.
- [ ] `history` — el historial de chats (hasta 6 meses).
- [ ] `smb_app_state_sync` — la libreta de contactos de la app.
- [ ] `smb_message_echoes` — los mensajes que el negocio manda desde el teléfono.

> Importante: hay que suscribirlos **antes** de conectar el primer número. El historial solo se puede pedir
> una vez por conexión y hay 24 horas; si los campos no están, esos webhooks se pierden.

---

## 5. Variables de entorno en el VPS

En el VPS, en el archivo `/opt/propyte/crm/shared/.env` (`nano /opt/propyte/crm/shared/.env`), una por línea con el formato `NOMBRE="valor"`:

| Variable | Valor | ¿Secreta? |
|---|---|---|
| `NEXT_PUBLIC_META_APP_ID` | El **ID de la app** (arriba a la izquierda del App Dashboard) | No |
| `NEXT_PUBLIC_META_ES_CONFIG_ID` | El **ID de la configuración** del paso 3 | No |
| `META_WA_APP_SECRET` | **Ya existe**, no se cambia (App settings → Basic → App Secret). Ahora también se usa para canjear el código de Meta. | Sí |

- [ ] Poner las dos variables nuevas.
- [ ] Confirmar que `META_WA_APP_SECRET` ya está puesta (si falta, el webhook de WhatsApp tampoco funciona).
- [ ] **Redesplegar**: `/opt/propyte/crm/deploy.sh main` (unos 5 min; el CRM no se corta). Ver `docs/infra/vps.md`.

Si falta alguna, el botón «Conectar WhatsApp (oficial)» no falla: dice exactamente cuál falta.

---

## 6. Antes de desplegar el código (lo hace el desarrollador)

- [ ] Aplicar en la base, **antes** de subir cada PR, las migraciones que lista el PR
  (`prisma/migrations-manual/2026-10-14-whatsapp-coexistencia.sql` y, con el PR 2,
  `prisma/migrations-manual/2026-10-14-whatsapp-asesores.sql`).

---

## 7. Probar con el número de Yaxnáh

Lo hace alguien con rol en la app (mientras App Review no esté aprobado).

1. [ ] En el teléfono de Yaxnáh: WhatsApp **Business** actualizado (versión 2.24.17 o más nueva).
2. [ ] En el CRM: **Conexiones → Meta → WhatsApp · Cloud API → elegir la marca «Yaxnáh» → Conectar WhatsApp (oficial)**.
3. [ ] En la ventana de Meta: entrar con Facebook, elegir **conectar la cuenta de WhatsApp Business existente**
   (no «número nuevo»), escribir el número y seguir las instrucciones en el teléfono (escanear el código o
   pegar el código de verificación) y **aceptar compartir el historial** si se quiere importar.
4. [ ] Volver al CRM: debe decir «Conectado» y «Sincronizando historial». **Dejar la app abierta en el teléfono
   unos minutos.**
5. [ ] Escribir desde otro teléfono al número de Yaxnáh: el mensaje aparece en la bandeja del CRM.
6. [ ] Contestar desde el teléfono de Yaxnáh: la respuesta aparece en el CRM como de asesor.
7. [ ] Contestar desde el CRM: llega al cliente desde el número de Yaxnáh.

---

## 8. Cosas que hay que saber

- **Método de pago:** como Tech Provider, cada negocio conectado (cada marca y, con el PR 2, cada asesor) debe
  agregar una tarjeta a su cuenta de WhatsApp en WhatsApp Manager para poder mandar **plantillas** (mensajes
  fuera de la ventana de 24 h). Ver «Add a credit card to your WhatsApp Business Platform account» en el
  Centro de ayuda de Meta. Fuente: [Embedded Signup overview](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/overview).
- **Velocidad:** un número en coexistencia manda hasta 20 mensajes por segundo. Para un asesor o una marca chica sobra.
- **Grupos:** los chats de grupo no se sincronizan.
- **Dispositivos vinculados:** al conectar, Meta desvincula WhatsApp Web y otros equipos; hay que volver a
  vincularlos. WhatsApp para Windows y para WearOS no son compatibles.
- **Desconectar un número:** no se hace desde el CRM ni desde Meta: en la **app de WhatsApp Business del
  teléfono → Configuración → Cuenta → Plataforma para empresas → Desconectar** (*Settings > Account >
  Business Platform > Disconnect Account*). El CRM se entera solo y avisa a los administradores.
- **Cambio de teléfono:** si el negocio cambia de celular o reinstala WhatsApp Business, Meta lo desconecta y
  lo vuelve a conectar solo en unos minutos. El CRM lo muestra como «Desconectado temporalmente».
- **Privacidad (PR 2, números de asesor):** de un número de asesor solo entran al CRM los chats de personas que
  ya son contactos (o que el asesor marque como prospecto). Los chats personales no se guardan.
