/**
 * Consent-based notification broadcaster for an API you control.
 *
 * The API contract is intentionally kept in one adapter (`ApiClient`) so that
 * endpoint paths and response field names can be changed without touching the
 * queue, deduplication, or campaign logic.
 *
 * Safety defaults:
 * - DRY_RUN=true unless explicitly disabled.
 * - Only users with an explicit consent field are eligible.
 * - A persistent state file prevents duplicate messages across executions.
 * - MAX_RECIPIENTS_PER_LOCATION is finite and positive.
 * - The process waits between locations and after every complete cycle.
 */

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { resolve } from "node:path";

type SearchScope = "city" | "country";

interface LocationFilter {
  scope: SearchScope;
  city?: string;
  country: string;
  latitude?: number;
  longitude?: number;
  radiusKm?: number;
}

interface User {
  id: string;
  city?: string;
  country?: string;
  status?: string;
  recentlyActive?: boolean;
  optedInToNotifications?: boolean;
}

interface DeliveryState {
  firstSentAt?: string;
  secondSentAt?: string;
}

type DeliveryStore = Record<string, DeliveryState>;

interface ApiConfig {
  baseUrl: string;
  token: string;
  searchPath: string;
  messagePath: string;
  requestTimeoutMs: number;
}

interface CampaignConfig {
  messages: [string, string];
  pauseMs: number;
  locationPauseMs: number;
  cyclePauseMs: number;
  dryRun: boolean;
  maxRecipientsPerLocation: number;
  stateFile: string;
  auditFile: string;
  terrassaCity: string;
  spainCountry: string;
  latamCountries: string[];
  terrassaLatitude?: number;
  terrassaLongitude?: number;
  terrassaRadiusKm?: number;
}

interface SearchResponse {
  users: User[];
  nextPage?: string;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Falta la variable de entorno requerida: ${name}`);
  }
  return value;
}

function integerEnv(name: string, fallback: number, minimum: number): number {
  const rawValue = process.env[name];
  if (!rawValue) return fallback;

  const value = Number(rawValue);
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} debe ser un entero >= ${minimum}.`);
  }
  return value;
}

function booleanEnv(name: string, fallback: boolean): boolean {
  const rawValue = process.env[name]?.trim().toLowerCase();
  if (!rawValue) return fallback;
  if (["true", "1", "yes", "si"].includes(rawValue)) return true;
  if (["false", "0", "no"].includes(rawValue)) return false;
  throw new Error(`${name} debe ser true o false.`);
}

function optionalNumberEnv(name: string): number | undefined {
  const rawValue = process.env[name]?.trim();
  if (!rawValue) return undefined;
  const value = Number(rawValue);
  if (!Number.isFinite(value)) throw new Error(`${name} debe ser numérico.`);
  return value;
}

function printHelp(): void {
  process.stdout.write(`
Uso:
  pnpm --filter @workspace/scripts run notify

El proceso ejecuta continuamente esta secuencia:
  1. Terrassa, España.
  2. Resto de España mediante la búsqueda por country=ES.
  3. Cada país de LATAM_COUNTRIES, en orden.
  4. Espera CYCLE_PAUSE_MS y vuelve al paso 1.

Opciones:
  --help                   Mostrar esta ayuda.
`);
}

function countryListEnv(name: string, fallback: string): string[] {
  const countries = (process.env[name] ?? fallback)
    .split(",")
    .map((country) => country.trim().toUpperCase())
    .filter(Boolean);
  if (countries.length === 0) throw new Error(`${name} debe contener al menos un país.`);
  return [...new Set(countries)];
}

function loadConfig(): { api: ApiConfig; campaign: CampaignConfig } {
  const baseUrl = requiredEnv("MESSAGING_API_BASE_URL").replace(/\/+$/, "");
  const firstMessage = requiredEnv("MESSAGE_ONE");
  const secondMessage = requiredEnv("MESSAGE_TWO");
  const maxRecipientsPerRun = integerEnv("MAX_RECIPIENTS_PER_RUN", 25, 1);

  return {
    api: {
      baseUrl,
      token: requiredEnv("MESSAGING_API_TOKEN"),
      searchPath: process.env.USER_SEARCH_PATH?.trim() || "/users/search",
      messagePath: process.env.SEND_MESSAGE_PATH?.trim() || "/messages",
      requestTimeoutMs: integerEnv("REQUEST_TIMEOUT_MS", 15_000, 1_000),
    },
    campaign: {
      messages: [firstMessage, secondMessage],
      pauseMs: integerEnv("PAUSE_MS", 2_000, 0),
      locationPauseMs: integerEnv("LOCATION_PAUSE_MS", 10_000, 0),
      cyclePauseMs: integerEnv("CYCLE_PAUSE_MS", 3_600_000, 0),
      dryRun: booleanEnv("DRY_RUN", true),
      maxRecipientsPerLocation: integerEnv(
        "MAX_RECIPIENTS_PER_LOCATION",
        maxRecipientsPerRun,
        1,
      ),
      stateFile: resolve(process.env.STATE_FILE?.trim() || ".data/notification-state.json"),
      auditFile: resolve(process.env.AUDIT_FILE?.trim() || ".data/notification-audit.jsonl"),
      terrassaCity: process.env.TERRASSA_CITY?.trim() || "Terrassa",
      spainCountry: process.env.SPAIN_COUNTRY?.trim().toUpperCase() || "ES",
      latamCountries: countryListEnv(
        "LATAM_COUNTRIES",
        "MX,AR,CO,CL,PE,BR,UY,PY,BO,EC,VE,CR,PA,GT,SV,HN,NI,DO,CU,HT",
      ),
      terrassaLatitude: optionalNumberEnv("TERRASSA_LATITUDE"),
      terrassaLongitude: optionalNumberEnv("TERRASSA_LONGITUDE"),
      terrassaRadiusKm: optionalNumberEnv("TERRASSA_RADIUS_KM"),
    },
  };
}

function buildLocationSequence(campaign: CampaignConfig): LocationFilter[] {
  const terrassa: LocationFilter = {
    scope: "city",
    city: campaign.terrassaCity,
    country: campaign.spainCountry,
    latitude: campaign.terrassaLatitude,
    longitude: campaign.terrassaLongitude,
    radiusKm: campaign.terrassaRadiusKm,
  };
  const spain: LocationFilter = {
    scope: "country",
    country: campaign.spainCountry,
  };
  const latam = campaign.latamCountries.map((country): LocationFilter => ({
    scope: "country",
    country,
  }));
  return [terrassa, spain, ...latam];
}

function buildSearchUrl(api: ApiConfig, location: LocationFilter): URL {
  const url = new URL(api.searchPath, `${api.baseUrl}/`);
  url.searchParams.set("status", "active");
  url.searchParams.set("scope", location.scope);
  url.searchParams.set("country", location.country);
  if (location.scope === "city" && location.city) url.searchParams.set("city", location.city);
  if (location.latitude !== undefined) url.searchParams.set("latitude", String(location.latitude));
  if (location.longitude !== undefined) url.searchParams.set("longitude", String(location.longitude));
  if (location.radiusKm !== undefined) url.searchParams.set("radius_km", String(location.radiusKm));
  return url;
}

function asUser(value: unknown): User | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  const id = candidate.id ?? candidate.user_id;
  if (typeof id !== "string" && typeof id !== "number") return undefined;

  return {
    id: String(id),
    city: typeof candidate.city === "string" ? candidate.city : undefined,
    country: typeof candidate.country === "string" ? candidate.country : undefined,
    status: typeof candidate.status === "string" ? candidate.status : undefined,
    recentlyActive:
      typeof candidate.recently_active === "boolean"
        ? candidate.recently_active
        : typeof candidate.recentlyActive === "boolean"
          ? candidate.recentlyActive
          : undefined,
    optedInToNotifications:
      candidate.opted_in_to_notifications === true ||
      candidate.optedInToNotifications === true ||
      candidate.notification_consent === true,
  };
}

function parseSearchResponse(payload: unknown): SearchResponse {
  const values =
    Array.isArray(payload)
      ? payload
      : payload && typeof payload === "object"
        ? ((payload as Record<string, unknown>).users ??
          (payload as Record<string, unknown>).data ??
          [])
        : [];

  if (!Array.isArray(values)) throw new Error("La respuesta de búsqueda no contiene una lista.");
  const users = values.map(asUser).filter((user): user is User => user !== undefined);
  const nextPage =
    payload && typeof payload === "object" && typeof (payload as Record<string, unknown>).next_page === "string"
      ? String((payload as Record<string, unknown>).next_page)
      : undefined;
  return { users, nextPage };
}

class ApiClient {
  public constructor(private readonly config: ApiConfig) {}

  public async searchUsers(location: LocationFilter): Promise<User[]> {
    const users: User[] = [];
    let url = buildSearchUrl(this.config, location);

    do {
      const response = await this.request(url, { method: "GET" });
      const page = parseSearchResponse(response);
      users.push(...page.users);
      if (!page.nextPage) break;
      url = new URL(page.nextPage, `${this.config.baseUrl}/`);
    } while (true);

    return users;
  }

  public async sendMessage(userId: string, message: string): Promise<void> {
    await this.request(new URL(this.config.messagePath, `${this.config.baseUrl}/`), {
      method: "POST",
      body: JSON.stringify({ user_id: userId, message }),
    });
  }

  private async request(url: URL, init: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.token}`,
          ...init.headers,
        },
      });
      const body = await response.text();
      let payload: unknown = undefined;
      if (body) {
        try {
          payload = JSON.parse(body) as unknown;
        } catch {
          payload = body;
        }
      }
      if (!response.ok) {
        throw new Error(`API respondió ${response.status} ${response.statusText}: ${body.slice(0, 300)}`);
      }
      return payload;
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function loadState(path: string): Promise<DeliveryStore> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("El archivo de estado no tiene un objeto válido.");
    }
    return parsed as DeliveryStore;
  } catch (error) {
    if (isFileNotFound(error)) return {};
    throw error;
  }
}

function isFileNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

async function saveState(path: string, state: DeliveryStore): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function audit(path: string, event: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, "utf8");
}

async function sleep(milliseconds: number): Promise<void> {
  if (milliseconds > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function eligibleUsers(users: User[], state: DeliveryStore): User[] {
  const uniqueUsers = new Map<string, User>();
  for (const user of users) {
    if (user.status !== undefined && user.status !== "active") continue;
    if (user.optedInToNotifications !== true) continue;
    if (!uniqueUsers.has(user.id)) uniqueUsers.set(user.id, user);
  }

  return [...uniqueUsers.values()].filter((user) => {
    const delivery = state[user.id];
    return !delivery?.secondSentAt;
  });
}

function locationLabel(location: LocationFilter): string {
  return location.scope === "city"
    ? `${location.city ?? "ciudad desconocida"}, ${location.country}`
    : `país ${location.country}`;
}

function validateArguments(): void {
  const argumentsList = process.argv.slice(2).filter((argument) => argument !== "--");
  if (argumentsList.length === 0) return;
  if (argumentsList.length === 1 && argumentsList[0] === "--help") {
    printHelp();
    process.exit(0);
  }
  throw new Error("Este proceso continuo no acepta filtros por comando; usa las variables de entorno.");
}

async function processLocation(
  client: ApiClient,
  campaign: CampaignConfig,
  state: DeliveryStore,
  location: LocationFilter,
): Promise<void> {
  const label = locationLabel(location);
  console.log(`Buscando usuarios activos con consentimiento en ${label}.`);
  const foundUsers = await client.searchUsers(location);
  const users = eligibleUsers(foundUsers, state).slice(0, campaign.maxRecipientsPerLocation);
  console.log(`Encontrados ${foundUsers.length}; elegibles en ${label}: ${users.length}.`);

  for (const user of users) {
    const delivery = (state[user.id] ??= {});

    if (!delivery.firstSentAt) {
      await audit(campaign.auditFile, {
        event: campaign.dryRun ? "message_skipped_dry_run" : "message_pending",
        location: label,
        userId: user.id,
        messageNumber: 1,
        dryRun: campaign.dryRun,
      });
      if (!campaign.dryRun) {
        await client.sendMessage(user.id, campaign.messages[0]);
        delivery.firstSentAt = new Date().toISOString();
        await saveState(campaign.stateFile, state);
        await audit(campaign.auditFile, {
          event: "message_sent",
          location: label,
          userId: user.id,
          messageNumber: 1,
        });
      }
      await sleep(campaign.pauseMs);
    }

    if (!delivery.secondSentAt) {
      await audit(campaign.auditFile, {
        event: campaign.dryRun ? "message_skipped_dry_run" : "message_pending",
        location: label,
        userId: user.id,
        messageNumber: 2,
        dryRun: campaign.dryRun,
      });
      if (!campaign.dryRun) {
        await client.sendMessage(user.id, campaign.messages[1]);
        delivery.secondSentAt = new Date().toISOString();
        await saveState(campaign.stateFile, state);
        await audit(campaign.auditFile, {
          event: "message_sent",
          location: label,
          userId: user.id,
          messageNumber: 2,
        });
      }
      await sleep(campaign.pauseMs);
    }
  }
}

async function runCycle(
  client: ApiClient,
  campaign: CampaignConfig,
  state: DeliveryStore,
  cycleNumber: number,
): Promise<void> {
  const locations = buildLocationSequence(campaign);
  console.log(`Iniciando ciclo ${cycleNumber}: Terrassa -> España -> Latinoamérica.`);
  await audit(campaign.auditFile, {
    event: "cycle_started",
    cycleNumber,
    locations: locations.map(locationLabel),
    dryRun: campaign.dryRun,
  });

  for (let index = 0; index < locations.length; index += 1) {
    const location = locations[index];
    try {
      await processLocation(client, campaign, state, location);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error en ${locationLabel(location)}: ${message}`);
      await audit(campaign.auditFile, {
        event: "location_error",
        cycleNumber,
        location: locationLabel(location),
        error: message,
      });
    }
    if (index < locations.length - 1) await sleep(campaign.locationPauseMs);
  }

  await audit(campaign.auditFile, { event: "cycle_finished", cycleNumber });
  console.log(`Ciclo ${cycleNumber} terminado.`);
}

async function runForever(): Promise<void> {
  validateArguments();
  const { api, campaign } = loadConfig();
  const state = await loadState(campaign.stateFile);
  const client = new ApiClient(api);
  let cycleNumber = 1;

  console.log(
    campaign.dryRun
      ? "DRY_RUN activo: se buscarán usuarios, pero no se harán envíos."
      : "Envío real activo solo para usuarios con consentimiento explícito.",
  );
  console.log("El proceso continuará hasta recibir Ctrl+C.");

  while (true) {
    await runCycle(client, campaign, state, cycleNumber);
    cycleNumber += 1;
    console.log(`Esperando ${campaign.cyclePauseMs} ms antes del siguiente ciclo.`);
    await sleep(campaign.cyclePauseMs);
  }
}

runForever().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error de configuración o ejecución: ${message}`);
  process.exitCode = 1;
});