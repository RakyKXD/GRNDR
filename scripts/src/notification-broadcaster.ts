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
 * - MAX_RECIPIENTS_PER_RUN is required to be finite and positive.
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
  dryRun: boolean;
  maxRecipients: number;
  stateFile: string;
  auditFile: string;
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

function parseArguments(): LocationFilter | undefined {
  const args = new Map<string, string>();
  for (const argument of process.argv.slice(2)) {
    if (argument === "--") continue;
    if (argument === "--help") {
      printHelp();
      process.exit(0);
    }
    const match = /^--([^=]+)=(.*)$/.exec(argument);
    if (!match) throw new Error(`Argumento no reconocido: ${argument}`);
    args.set(match[1], match[2]);
  }

  const scope = (args.get("scope") ?? process.env.SEARCH_SCOPE ?? "city") as SearchScope;
  if (scope !== "city" && scope !== "country") {
    throw new Error("scope debe ser city o country.");
  }

  const country = args.get("country") ?? process.env.SEARCH_COUNTRY;
  if (!country) throw new Error("Indica --country=... o SEARCH_COUNTRY.");

  const city = args.get("city") ?? process.env.SEARCH_CITY;
  if (scope === "city" && !city) {
    throw new Error("El alcance city requiere --city=... o SEARCH_CITY.");
  }

  const latitude = parseOptionalArgumentNumber(args, "latitude");
  const longitude = parseOptionalArgumentNumber(args, "longitude");
  const radiusKm = parseOptionalArgumentNumber(args, "radius-km");

  return {
    scope,
    country,
    city,
    latitude,
    longitude,
    radiusKm,
  };
}

function parseOptionalArgumentNumber(
  args: Map<string, string>,
  name: string,
): number | undefined {
  const value = args.get(name);
  if (value === undefined) return optionalNumberEnv(name.replaceAll("-", "_").toUpperCase());
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`--${name} debe ser numérico.`);
  return parsed;
}

function printHelp(): void {
  process.stdout.write(`
Uso:
  pnpm --filter @workspace/scripts run notify -- --scope=city --city=Terrassa --country=ES
  pnpm --filter @workspace/scripts run notify -- --scope=country --country=ES

Argumentos:
  --scope=city|country     Alcance de búsqueda (por defecto: SEARCH_SCOPE).
  --city=...               Ciudad cuando el alcance es city.
  --country=...            País requerido.
  --latitude=...            Coordenada opcional.
  --longitude=...           Coordenada opcional.
  --radius-km=...           Radio opcional.
  --help                   Mostrar esta ayuda.
`);
}

function loadConfig(): { api: ApiConfig; campaign: CampaignConfig } {
  const baseUrl = requiredEnv("MESSAGING_API_BASE_URL").replace(/\/+$/, "");
  const firstMessage = requiredEnv("MESSAGE_ONE");
  const secondMessage = requiredEnv("MESSAGE_TWO");

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
      dryRun: booleanEnv("DRY_RUN", true),
      maxRecipients: integerEnv("MAX_RECIPIENTS_PER_RUN", 25, 1),
      stateFile: resolve(process.env.STATE_FILE?.trim() || ".data/notification-state.json"),
      auditFile: resolve(process.env.AUDIT_FILE?.trim() || ".data/notification-audit.jsonl"),
    },
  };
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

async function run(): Promise<void> {
  const location = parseArguments();
  if (!location) throw new Error("No se ha indicado una ubicación.");
  const { api, campaign } = loadConfig();
  const state = await loadState(campaign.stateFile);
  const client = new ApiClient(api);

  console.log(`Buscando usuarios activos con consentimiento en ${location.scope}: ${location.city ?? location.country}`);
  const foundUsers = await client.searchUsers(location);
  const users = eligibleUsers(foundUsers, state).slice(0, campaign.maxRecipients);
  console.log(`Encontrados ${foundUsers.length}; elegibles para esta ejecución: ${users.length}.`);
  console.log(campaign.dryRun ? "DRY_RUN activo: no se harán peticiones de envío." : "Envío real activo.");

  for (const user of users) {
    const delivery = (state[user.id] ??= {});

    if (!delivery.firstSentAt) {
      await audit(campaign.auditFile, {
        event: campaign.dryRun ? "message_skipped_dry_run" : "message_pending",
        userId: user.id,
        messageNumber: 1,
        dryRun: campaign.dryRun,
      });
      if (!campaign.dryRun) {
        await client.sendMessage(user.id, campaign.messages[0]);
        delivery.firstSentAt = new Date().toISOString();
        await saveState(campaign.stateFile, state);
        await audit(campaign.auditFile, { event: "message_sent", userId: user.id, messageNumber: 1 });
      }
      await sleep(campaign.pauseMs);
    }

    if (!delivery.secondSentAt) {
      await audit(campaign.auditFile, {
        event: campaign.dryRun ? "message_skipped_dry_run" : "message_pending",
        userId: user.id,
        messageNumber: 2,
        dryRun: campaign.dryRun,
      });
      if (!campaign.dryRun) {
        await client.sendMessage(user.id, campaign.messages[1]);
        delivery.secondSentAt = new Date().toISOString();
        await saveState(campaign.stateFile, state);
        await audit(campaign.auditFile, { event: "message_sent", userId: user.id, messageNumber: 2 });
      }
      await sleep(campaign.pauseMs);
    }
  }
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exitCode = 1;
});