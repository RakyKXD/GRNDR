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
type SearchLocationMode = "geohash" | "legacy";

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
  locationMode: SearchLocationMode;
  geocodingUrl?: string;
  geocodingUserAgent: string;
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
  locationCoordinates: Record<string, { latitude: number; longitude: number }>;
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

function coordinateEnvPair(
  latitudeName: string,
  longitudeName: string,
): { latitude?: number; longitude?: number } {
  const latitude = optionalNumberEnv(latitudeName);
  const longitude = optionalNumberEnv(longitudeName);
  if ((latitude === undefined) !== (longitude === undefined)) {
    throw new Error(`${latitudeName} y ${longitudeName} deben configurarse juntos.`);
  }
  return { latitude, longitude };
}

function validateCoordinates(latitude: number, longitude: number, label: string): void {
  if (latitude < -90 || latitude > 90) {
    throw new Error(`${label}: la latitud debe estar entre -90 y 90.`);
  }
  if (longitude < -180 || longitude > 180) {
    throw new Error(`${label}: la longitud debe estar entre -180 y 180.`);
  }
}

function parseLocationCoordinates(value: string): Record<string, { latitude: number; longitude: number }> {
  const coordinates: Record<string, { latitude: number; longitude: number }> = {};
  for (const item of value.split(";").map((part) => part.trim()).filter(Boolean)) {
    const separator = item.indexOf(":");
    if (separator <= 0) {
      throw new Error(
        "LOCATION_COORDINATES debe usar el formato PAIS:LATITUD,LONGITUD;PAIS:LATITUD,LONGITUD.",
      );
    }
    const country = item.slice(0, separator).trim().toUpperCase();
    const [latitudeText, longitudeText] = item.slice(separator + 1).split(",").map((part) => part.trim());
    const latitude = Number(latitudeText);
    const longitude = Number(longitudeText);
    if (!country || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw new Error(`Coordenadas inválidas en LOCATION_COORDINATES: ${item}`);
    }
    validateCoordinates(latitude, longitude, `LOCATION_COORDINATES para ${country}`);
    coordinates[country] = { latitude, longitude };
  }
  return coordinates;
}

function geohashEncode(latitude: number, longitude: number, precision = 12): string {
  validateCoordinates(latitude, longitude, "Geohash");
  const alphabet = "0123456789bcdefghjkmnpqrstuvwxyz";
  let minLatitude = -90;
  let maxLatitude = 90;
  let minLongitude = -180;
  let maxLongitude = 180;
  let evenBit = true;
  let bits = 0;
  let bitCount = 0;
  let geohash = "";

  while (geohash.length < precision) {
    const value = evenBit ? longitude : latitude;
    const min = evenBit ? minLongitude : minLatitude;
    const max = evenBit ? maxLongitude : maxLatitude;
    bits = bits * 2 + (value >= (min + max) / 2 ? 1 : 0);
    if (evenBit) {
      if (value >= (minLongitude + maxLongitude) / 2) minLongitude = (minLongitude + maxLongitude) / 2;
      else maxLongitude = (minLongitude + maxLongitude) / 2;
    } else {
      if (value >= (minLatitude + maxLatitude) / 2) minLatitude = (minLatitude + maxLatitude) / 2;
      else maxLatitude = (minLatitude + maxLatitude) / 2;
    }
    evenBit = !evenBit;
    bitCount += 1;
    if (bitCount === 5) {
      geohash += alphabet[bits];
      bits = 0;
      bitCount = 0;
    }
  }
  return geohash;
}

function locationModeEnv(): SearchLocationMode {
  const value = process.env.SEARCH_LOCATION_MODE?.trim().toLowerCase() || "geohash";
  if (value !== "geohash" && value !== "legacy") {
    throw new Error("SEARCH_LOCATION_MODE debe ser geohash o legacy.");
  }
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
   --scope=city             Buscar solo la ubicación de ciudad configurada.
   --scope=country          Buscar solo las ubicaciones de país configuradas.

Ubicación:
  SEARCH_LOCATION_MODE=geohash usa el formato de Grindr: geohash de 12 caracteres.
  Para Terrassa configura TERRASSA_LATITUDE y TERRASSA_LONGITUDE, o GEOCODING_URL.
  Para ubicaciones de país usa LOCATION_COORDINATES=ES:41.39,2.17;MX:19.43,-99.13.
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
  const terrassaCoordinates = coordinateEnvPair("TERRASSA_LATITUDE", "TERRASSA_LONGITUDE");
  const locationCoordinates = process.env.LOCATION_COORDINATES?.trim()
    ? parseLocationCoordinates(process.env.LOCATION_COORDINATES)
    : {};

  return {
    api: {
      baseUrl,
      token: requiredEnv("MESSAGING_API_TOKEN"),
      searchPath: process.env.USER_SEARCH_PATH?.trim() || "/v4/discover",
      messagePath: process.env.SEND_MESSAGE_PATH?.trim() || "/messages",
      requestTimeoutMs: integerEnv("REQUEST_TIMEOUT_MS", 15_000, 1_000),
      locationMode: locationModeEnv(),
      geocodingUrl: process.env.GEOCODING_URL?.trim() || undefined,
      geocodingUserAgent: process.env.GEOCODING_USER_AGENT?.trim() || "consent-notification-broadcaster/1.0",
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
      terrassaLatitude: terrassaCoordinates.latitude,
      terrassaLongitude: terrassaCoordinates.longitude,
      terrassaRadiusKm: optionalNumberEnv("TERRASSA_RADIUS_KM"),
      locationCoordinates,
    },
  };
}

function buildLocationSequence(campaign: CampaignConfig, scope?: SearchScope): LocationFilter[] {
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
  const locations = [terrassa, spain, ...latam];
  return scope ? locations.filter((location) => location.scope === scope) : locations;
}

async function geocodeCity(
  api: ApiConfig,
  location: LocationFilter,
): Promise<{ latitude: number; longitude: number }> {
  if (location.latitude !== undefined && location.longitude !== undefined) {
    return { latitude: location.latitude, longitude: location.longitude };
  }
  if (!api.geocodingUrl || !location.city) {
    throw new Error(
      `Faltan coordenadas para ${locationLabel(location)}. Configura TERRASSA_LATITUDE/TERRASSA_LONGITUDE o GEOCODING_URL.`,
    );
  }

  const url = new URL(api.geocodingUrl);
  url.searchParams.set("q", `${location.city}, ${location.country}`);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");

  const response = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": api.geocodingUserAgent },
  });
  if (!response.ok) {
    throw new Error(`El servicio de geocodificación respondió ${response.status} ${response.statusText}.`);
  }
  const payload: unknown = await response.json();
  const candidate =
    Array.isArray(payload) ? payload[0] :
    payload && typeof payload === "object" && Array.isArray((payload as Record<string, unknown>).results)
      ? ((payload as Record<string, unknown>).results as unknown[])[0]
      : payload;
  if (!candidate || typeof candidate !== "object") {
    throw new Error(`No se encontraron coordenadas para ${locationLabel(location)}.`);
  }

  const values = candidate as Record<string, unknown>;
  const latitude = Number(values.lat ?? values.latitude);
  const longitude = Number(values.lon ?? values.lng ?? values.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new Error(`La geocodificación no devolvió coordenadas válidas para ${locationLabel(location)}.`);
  }
  validateCoordinates(latitude, longitude, `Geocodificación de ${locationLabel(location)}`);
  return { latitude, longitude };
}

async function resolveLocations(
  api: ApiConfig,
  campaign: CampaignConfig,
  scope?: SearchScope,
): Promise<LocationFilter[]> {
  const locations = buildLocationSequence(campaign, scope);
  if (api.locationMode !== "geohash") return locations;

  return Promise.all(
    locations.map(async (location) => {
      if (location.scope === "city") {
        const coordinates = await geocodeCity(api, location);
        return { ...location, ...coordinates };
      }
      const coordinates = campaign.locationCoordinates[location.country];
      if (!coordinates) return location;
      return { ...location, ...coordinates };
    }),
  );
}

function buildSearchUrl(api: ApiConfig, location: LocationFilter): URL {
  const url = new URL(api.searchPath, `${api.baseUrl}/`);
  if (api.locationMode === "geohash") {
    if (location.latitude === undefined || location.longitude === undefined) {
      throw new Error(
        `Faltan coordenadas para ${locationLabel(location)}. Configura LOCATION_COORDINATES o usa --scope=city con TERRASSA_LATITUDE/TERRASSA_LONGITUDE.`,
      );
    }
    url.searchParams.set("geohash", geohashEncode(location.latitude, location.longitude));
    return url;
  }

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

  public get apiConfig(): ApiConfig {
    return this.config;
  }

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

function validateArguments(): SearchScope | undefined {
  const argumentsList = process.argv.slice(2).filter((argument) => argument !== "--");
  if (argumentsList.length === 0) return undefined;
  if (argumentsList.length === 1 && argumentsList[0] === "--help") {
    printHelp();
    process.exit(0);
  }
  if (argumentsList.length === 1 && ["--scope=city", "--scope=country"].includes(argumentsList[0])) {
    return argumentsList[0].slice("--scope=".length) as SearchScope;
  }
  throw new Error("Argumento inválido. Usa --scope=city, --scope=country o --help.");
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
  scope?: SearchScope,
): Promise<void> {
  const locations = await resolveLocations(client.apiConfig, campaign, scope);
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
  const scope = validateArguments();
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
    await runCycle(client, campaign, state, cycleNumber, scope);
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