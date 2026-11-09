# Instrucciones para Claude Code

> Para contexto de este proyecto lee: `~/.claude/projects/c--Users-Luis/memory/project_propyte_crm.md`

## Reglas de seguridad
- NUNCA leas ni muestres el contenido de archivos .env
- NUNCA accedas a archivos .pem, .key, o carpetas .ssh/.aws
- Siempre trabaja en la rama actual, nunca cambies a main sin preguntar
- Pregunta antes de eliminar archivos o carpetas

## Lineamientos para evitar Fallos
- Antes de editar, lee MÁXIMO 3 archivos.
- No hagas grep exploratorio sin pedirlo.
- Pregunta si necesitas más contexto.

## Variables de entorno
Este proyecto usa variables de entorno definidas en .env.example
Los valores reales estan en .env (que NO debes acceder).
Consulta .env.example para conocer la estructura.

## Dependencias: solo pnpm 10 (#921)
- Producción (VPS, `deploy.sh`) instala con **pnpm 10.32.1** y `--frozen-lockfile` a partir de `pnpm-lock.yaml`; la CI usa lo mismo. Si el lock no casa con `package.json`, el despliegue se detiene y se queda la versión anterior.
- **No uses `npm install` ni `npm ci`**: generarían `package-lock.json`, que está en `.gitignore`. Usa `npx pnpm@10 install` (o `pnpm install` si lo tienes instalado), y `npx pnpm@10 add <paquete>` para agregar uno.
- Si cambias `package.json`, commitea también `pnpm-lock.yaml`. Si no, la CI falla con `ERR_PNPM_OUTDATED_LOCKFILE`, y es a propósito.
- `npm run <script>` sigue funcionando para correr scripts (`build`, `lint`, `typecheck`, `test`).

## Producción: VPS de Hostinger (desde 2026-11-06)
- El CRM ya **no** corre en hPanel. Corre en el VPS (`srv1698109`, `2.24.123.88`), en Docker (`propyte-crm-1` y `propyte-crm-2`) detrás del Caddy del VPS. Guía: `docs/infra/vps.md`.
- Cada merge a `main` se despliega solo en unos 2–8 min (cron del VPS cada 2 min + build). Log: `/var/log/crm-deploy.log`.
- Las variables de producción viven en `/opt/propyte/crm/shared/.env` (nunca en hPanel) y se aplican con `/opt/propyte/crm/deploy.sh main`.
- Las migraciones SQL manuales (`prisma/migrations-manual/`) se siguen aplicando a mano en Supabase, igual que antes.

## Estructura del proyecto
<!-- Describe aqui la estructura de tu proyecto -->

## Convenciones
<!-- Agrega aqui las convenciones de codigo de tu equipo -->
