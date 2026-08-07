# Consent Notification Broadcaster

Script de notificaciones con consentimiento explícito para una API compatible que controles.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — ejecutar el API server en el `PORT` que inyecte el workflow
- `pnpm --filter @workspace/scripts run notify -- --help` — mostrar las opciones del broadcaster
- `pnpm --filter @workspace/scripts run notify -- --scope=city` — ejecutar solo la búsqueda de Terrassa
- `pnpm --filter @workspace/scripts run notify -- --scope=country` — ejecutar las búsquedas de países configuradas
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm install --frozen-lockfile` — restaurar dependencias después de importar o clonar el proyecto
- Required env for the API server: `DATABASE_URL` — Postgres connection string
- Required env for the broadcaster: `MESSAGING_API_BASE_URL`, `MESSAGING_API_TOKEN`, `MESSAGE_ONE`, `MESSAGE_TWO`
- El broadcaster usa `DRY_RUN=true` por defecto; no activar envíos reales hasta validar la API controlada.
- Consulta `scripts/.env.example` para todas las variables de geolocalización, límites, pausas y archivos de auditoría.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `scripts/src/notification-broadcaster.ts` — resolución de ubicaciones, generación de geohash, búsquedas, consentimiento, deduplicación y envíos.
- `scripts/.env.example` — configuración documentada del broadcaster.
- `artifacts/api-server/src/` — API Express; actualmente expone `/api/healthz`.
- `lib/db/` — conexión y esquema de PostgreSQL con Drizzle.
- `lib/api-spec/` — contrato OpenAPI fuente.
- `lib/api-zod/` y `lib/api-client-react/` — tipos, validación y cliente generado.

## Architecture decisions

- En `SEARCH_LOCATION_MODE=geohash`, las búsquedas usan exactamente `GET /v4/discover?geohash=<12 caracteres>` y no envían `city`, `country`, `latitude` ni `longitude`.
- `SEARCH_LOCATION_MODE=legacy` no está soportado: Grindr Discover rechaza búsquedas basadas en nombres de ciudad o códigos de país.
- Terrassa puede usar `TERRASSA_LATITUDE` y `TERRASSA_LONGITUDE` directamente, o resolverse mediante `GEOCODING_URL`.
- Las ubicaciones de país usan automáticamente un punto central aproximado; `LOCATION_COORDINATES` solo es necesario para sobrescribir un punto o añadir un país fuera de la lista predeterminada.
- Solo se procesan usuarios con consentimiento explícito y `DRY_RUN` evita envíos mientras se valida el flujo.

## Product

El proyecto proporciona un broadcaster de campañas con dos mensajes secuenciales, pausas configurables, límite por ubicación, estado persistente para evitar duplicados y archivo de auditoría JSONL. Incluye un API server base para integrar endpoints adicionales.

## User preferences

- Keep campaign messages in Replit environment variables (`MESSAGE_ONE` and `MESSAGE_TWO`), not command-line arguments or source files.

## Gotchas

- El proceso del broadcaster es continuo y solo termina con Ctrl+C.
- `MESSAGING_API_BASE_URL` y `MESSAGING_API_TOKEN` deben apuntar a una API compatible que controles; no se deben inventar credenciales de terceros.
- En geohash, `TERRASSA_LATITUDE` y `TERRASSA_LONGITUDE` deben configurarse juntas. Las coordenadas de países se declaran como `PAIS:LATITUD,LONGITUD;...`.
- Los workflows de API y mockup pertenecen a sus artifacts; se reinician con sus nombres administrados, no creando workflows duplicados.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
