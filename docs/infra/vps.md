# El CRM en el VPS de Hostinger

Desde el **2026-11-06** `crm.propyte.com` ya no corre en hPanel: corre en el VPS de Hostinger
(`srv1698109`, IP `2.24.123.88`, Ubuntu 22.04). La base de datos y los archivos siguen en
Supabase, igual que antes. Esta guía dice dónde está cada cosa y cómo se opera.

Todos los comandos se corren en el VPS como `root` (`ssh root@2.24.123.88`).

## Dónde está cada cosa

| Qué | Dónde |
|---|---|
| Variables de producción | `/opt/propyte/crm/shared/.env` (permisos 600) |
| Contenedores | `propyte-crm-1` y `propyte-crm-2` (imagen `node:22-bookworm`, 2 GB y 1.5 CPU cada uno) |
| Definición de los contenedores | `/opt/propyte/crm/docker-compose.yml` |
| Versión publicada | `/opt/propyte/crm/current` → enlace a `/opt/propyte/crm/releases/<fecha>` (se guardan las últimas 5) |
| Script de despliegue | `/opt/propyte/crm/deploy.sh` |
| Despliegue automático | `/opt/propyte/crm/autodeploy.sh`, llamado cada 2 min por `/etc/cron.d/propyte-crm` |
| Log de despliegues | `/var/log/crm-deploy.log` |
| HTTPS | Contenedor `propyte-caddy` (lo comparten otros sitios del VPS). Archivo: `/opt/propyte/caddy/Caddyfile`, bloques `crm.propyte.com` y `www.crm.propyte.com` |
| Log de accesos | `/data/access-crm.log` dentro de `propyte-caddy` (rota cada 10 MiB, guarda 5) |
| Crons del CRM | Crontab de root del VPS (`crontab -l`): `workflows` cada minuto, `tiktok` cada 5 min, `linkedin` y `gmail-sync` cada 15 min. Llaman a `https://crm.propyte.com/...` con `x-cron-secret` |
| DNS | Zona propia de `crm.propyte.com` en hPanel (Dominios → propyte.com → Subdominios → crm): A `@` → `2.24.123.88`, sin AAAA. Además, la fila `crm` de la zona de `propyte.com` también apunta al VPS |
| Monitor | `.github/workflows/vigilancia-crm.yml` (GitHub, cada 30 min, contra `/api/health`) |
| Respaldos | Respaldo diario del VPS en hPanel. La base va por su cuenta en Supabase |

## Despliegue

Cada merge a `main` se publica solo:
1. A los 0–2 minutos, `autodeploy.sh` ve que `main` cambió en GitHub (`git ls-remote`; el repo
   es público).
2. `deploy.sh` clona ese commit en una carpeta nueva y copia ahí el `.env`. Instala con
   `pnpm 10.32.1 --frozen-lockfile` y compila. Usa un contenedor desechable con tope de 2 CPU y
   6 GB, para no quitarles recursos a los demás servicios del VPS.
3. Si la compilación falla, **no se toca lo que está en línea**. El commit queda anotado en
   `/opt/propyte/crm/.ultimo-fallido` y no se reintenta hasta que haya otro commit.
4. Si compila, cambia `propyte-crm-1` y luego `propyte-crm-2`, esperando a que cada uno responda
   `/api/health`. Caddy reparte entre los dos, así que el CRM no se corta. Si uno no queda sano,
   regresa solo a la versión anterior.

Con eso, un merge tarda unos **2–8 minutos** en estar en producción. Para ver qué pasó:
`tail -30 /var/log/crm-deploy.log`.

Para desplegar a mano (por ejemplo, después de cambiar una variable):

```bash
/opt/propyte/crm/deploy.sh main          # o un commit concreto: deploy.sh <sha>
```

> Ojo: como producción instala con `--frozen-lockfile`, si un PR cambia `package.json` sin
> actualizar `pnpm-lock.yaml`, el despliegue se detiene y se queda la versión anterior. La CI ya
> falla en ese caso, antes del merge.

## Cambiar una variable de entorno

hPanel **ya no** sirve para esto: una variable cambiada allá no tiene efecto.

1. `nano /opt/propyte/crm/shared/.env`. Una línea por variable, con el formato `NOMBRE="valor"`.
   Si un valor lleva `$`, se escribe `\$`, porque Next expande `$VAR` dentro del `.env`.
2. Guarda (Ctrl+O, Enter) y sal (Ctrl+X).
3. Corre `/opt/propyte/crm/deploy.sh main`. Cada versión copia el `.env` al arrancar; sin
   redesplegar, el cambio no entra.

`KYC_ENCRYPTION_KEY`, `GOOGLE_TOKEN_ENCRYPTION_KEY` y `NEXTAUTH_SECRET` **no se cambian**: con
otro valor, los datos cifrados se vuelven ilegibles y todos pierden la sesión.

## Ver qué está pasando

```bash
docker ps --filter name=propyte-crm --format 'table {{.Names}}\t{{.Status}}'   # ambos (healthy)
docker compose -f /opt/propyte/crm/docker-compose.yml logs -f --tail 50        # logs en vivo (Ctrl+C)
docker stats --no-stream propyte-crm-1 propyte-crm-2                           # memoria y CPU
git -c safe.directory='*' -C /opt/propyte/crm/current log -1 --oneline         # commit publicado
tail -30 /var/log/crm-deploy.log                                               # despliegues
```

Para saber si una petición llegó y qué se le contestó (webhooks de Meta, Twilio, crons), hay
que leer el log de accesos de Caddy, incluidos los archivos rotados:

```bash
docker exec propyte-caddy sh -c 'for f in /data/access-crm*; do case "$f" in *.gz) zcat "$f";; *) cat "$f";; esac; done' | grep -c '/api/cron/workflows'
```

## Regresar a una versión anterior

```bash
ls -1t /opt/propyte/crm/releases/                       # la primera es la actual
ln -sfn /opt/propyte/crm/releases/<anterior> /opt/propyte/crm/current
docker compose -f /opt/propyte/crm/docker-compose.yml up -d --force-recreate
```

El despliegue automático **vuelve a publicar `main`** con el siguiente merge. Si el problema está
en `main`, hay que revertir el commit en GitHub.

## Mantenimiento

- **Parches de Node, una vez al mes:**
  `docker pull node:22-bookworm && /opt/propyte/crm/deploy.sh main`. Para cambiar de versión
  mayor (por ejemplo, a 24), hay que cambiar la imagen en `docker-compose.yml` y en `deploy.sh`,
  y también `node-version` en `.github/workflows/ci.yml`.
- **Sistema operativo:** `unattended-upgrades` lo actualiza solo.
- **Certificados:** Caddy los renueva solo (Let's Encrypt).
- **Disco:** `df -h /`. Cada versión ocupa alrededor de 1 GB y se guardan 5.

## Si `crm.propyte.com` no responde

1. `docker ps`: ¿están los dos contenedores `(healthy)`? Si no, revisa sus logs (arriba).
2. `docker ps --filter name=propyte-caddy`: si Caddy está caído, caen también los demás sitios
   del VPS.
3. `tail /var/log/crm-deploy.log`: ¿falló o está a medias un despliegue?
4. `docker exec propyte-crm-1 curl -s localhost:3000/api/health` debe dar
   `{"ok":true,"db":"up"}`. Si da `"db":"down"`, el problema está en Supabase o en
   `DATABASE_URL`.

## Historia

- **Hasta el 2026-11-06:** Node.js app de hPanel (Passenger/LiteSpeed, CDN `hcdn` delante),
  compilada en cada push a `main`. Muchos comentarios del código hablan de ese entorno (el
  multipart truncado, los 502 en llamadas largas, `next/font/local`, `node-linker=hoisted`). Se
  dejaron porque explican por qué el código es como es.
- **La mudanza** se hizo sin cortes: el VPS corrió en paralelo, se probó con el dominio real
  desde una PC y luego se cambió el DNS. La bitácora completa está en el proyecto Sistemas
  (`claude/migracion-crm-a-vps-hostinger-2026-11-05.md`).
- **Pendiente:** detener la app vieja en hPanel (detenerla, no borrar el sitio). Antes de borrar
  el sitio `crm.propyte.com` de hPanel, copiar a la zona de `propyte.com` los registros de correo y
  envío de su zona (MX, SPF, `autodiscover`, `autoconfig`, `send` y `resend._domainkey`).
