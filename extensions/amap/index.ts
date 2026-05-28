import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { jsonResult, readNumberParam, readStringParam } from "openclaw/plugin-sdk/channel-actions";
import { definePluginEntry, type AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { coerceSecretRef, normalizeSecretInputString } from "openclaw/plugin-sdk/secret-input";
import { Type } from "typebox";

const DEFAULT_AMAP_BASE_URL = "https://restapi.amap.com";
const DEFAULT_CITY = "上海";
const DEFAULT_WEATHER_CITY = "上海";
const DEFAULT_RADIUS_M = 5000;
const DEFAULT_LIMIT = 10;
const DEFAULT_WEATHER_CACHE_TTL_MINUTES = 240;
const DEFAULT_WEATHER_MONTHLY_QUOTA = 5000;
const DEFAULT_WEATHER_QUOTA_WARN_RATIO = 0.8;

type AmapWebServiceConfig = {
  apiKey?: unknown;
  defaultCity?: string;
  defaultOriginAddress?: string;
  defaultWeatherCity?: string;
  baseUrl?: string;
  stateDir?: string;
  weatherCacheTtlMinutes?: number;
  weatherMonthlyQuota?: number;
  weatherQuotaWarnRatio?: number;
};

type LngLat = {
  lng: string;
  lat: string;
};

type GeocodeResult = {
  formattedAddress?: string;
  location?: string;
  level?: string;
  province?: string;
  city?: string;
  district?: string;
  adcode?: string;
};

type AmapJson = Record<string, unknown>;

type WeatherUsage = {
  provider: "amap";
  month: string;
  calls: number;
  monthlyQuota: number;
  warnAt: number;
  checkedAt?: string;
  updatedAt?: string;
  lastCall?: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveAmapConfig(config: unknown): AmapWebServiceConfig {
  if (!isRecord(config)) {
    return {};
  }
  const plugins = isRecord(config.plugins) ? config.plugins : undefined;
  const entries = isRecord(plugins?.entries) ? plugins.entries : undefined;
  const amap = isRecord(entries?.amap) ? entries.amap : undefined;
  const pluginConfig = isRecord(amap?.config) ? amap.config : undefined;
  return isRecord(pluginConfig?.webService)
    ? (pluginConfig.webService as AmapWebServiceConfig)
    : {};
}

function resolveAmapApiKey(config: AmapWebServiceConfig): string | undefined {
  const literal = normalizeSecretInputString(config.apiKey);
  if (literal) {
    return literal;
  }
  const ref = coerceSecretRef(config.apiKey);
  if (ref?.source === "env") {
    return normalizeSecretInputString(process.env[ref.id]);
  }
  return (
    normalizeSecretInputString(process.env.AMAP_WEB_SERVICE_KEY) ??
    normalizeSecretInputString(process.env.AMAP_API_KEY)
  );
}

function resolveAmapBaseUrl(config: AmapWebServiceConfig): string {
  return normalizeSecretInputString(config.baseUrl)?.replace(/\/+$/u, "") || DEFAULT_AMAP_BASE_URL;
}

function resolveDefaultCity(config: AmapWebServiceConfig): string {
  return normalizeSecretInputString(config.defaultCity) ?? DEFAULT_CITY;
}

function resolveDefaultOriginAddress(config: AmapWebServiceConfig): string | undefined {
  return normalizeSecretInputString(config.defaultOriginAddress);
}

function resolveDefaultWeatherCity(config: AmapWebServiceConfig): string {
  return (
    normalizeSecretInputString(config.defaultWeatherCity) ??
    normalizeSecretInputString(config.defaultCity) ??
    DEFAULT_WEATHER_CITY
  );
}

function resolveAmapStateDir(config: AmapWebServiceConfig): string {
  const configured = normalizeSecretInputString(config.stateDir);
  if (configured) {
    return configured;
  }
  const envStateDir = normalizeSecretInputString(process.env.OPENCLAW_STATE_DIR);
  if (envStateDir) {
    return path.join(envStateDir, "amap");
  }
  return path.join(os.homedir(), ".openclaw", "amap");
}

function readPositiveInteger(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.trunc(value));
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.trunc(parsed));
    }
  }
  return fallback;
}

function resolveWeatherCacheTtlMinutes(config: AmapWebServiceConfig): number {
  return readPositiveInteger(config.weatherCacheTtlMinutes, DEFAULT_WEATHER_CACHE_TTL_MINUTES);
}

function resolveWeatherMonthlyQuota(config: AmapWebServiceConfig): number {
  return readPositiveInteger(config.weatherMonthlyQuota, DEFAULT_WEATHER_MONTHLY_QUOTA);
}

function resolveWeatherQuotaWarnRatio(config: AmapWebServiceConfig): number {
  const value = config.weatherQuotaWarnRatio;
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.min(1, value));
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.min(1, parsed));
    }
  }
  return DEFAULT_WEATHER_QUOTA_WARN_RATIO;
}

function requireApiKey(config: AmapWebServiceConfig): string {
  const apiKey = resolveAmapApiKey(config);
  if (!apiKey) {
    throw new Error(
      "AMap Web Service API key is not configured. Set plugins.entries.amap.config.webService.apiKey or AMAP_WEB_SERVICE_KEY.",
    );
  }
  return apiKey;
}

function normalizeLngLat(value: string): string | undefined {
  const match = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/u.exec(value);
  if (!match) {
    return undefined;
  }
  const lng = Number(match[1]);
  const lat = Number(match[2]);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
    return undefined;
  }
  if (lng < -180 || lng > 180 || lat < -90 || lat > 90) {
    return undefined;
  }
  return `${lng.toFixed(6)},${lat.toFixed(6)}`;
}

function buildAmapUrl(params: {
  config: AmapWebServiceConfig;
  path: string;
  query: Record<string, string | number | undefined>;
}): URL {
  const url = new URL(`${resolveAmapBaseUrl(params.config)}${params.path}`);
  url.searchParams.set("key", requireApiKey(params.config));
  url.searchParams.set("output", "json");
  for (const [key, value] of Object.entries(params.query)) {
    if (value === undefined || value === "") {
      continue;
    }
    url.searchParams.set(key, String(value));
  }
  return url;
}

function sanitizeUrl(url: URL): string {
  const copy = new URL(url.toString());
  copy.searchParams.set("key", "REDACTED");
  return copy.toString();
}

function responseErrorMessage(payload: AmapJson): string | undefined {
  if (payload.status === "0") {
    return String(payload.info ?? payload.infocode ?? "AMap request failed");
  }
  const errcode = payload.errcode;
  if (
    (typeof errcode === "number" && errcode !== 0) ||
    (typeof errcode === "string" && errcode !== "0")
  ) {
    return String(payload.errmsg ?? payload.errdetail ?? errcode);
  }
  return undefined;
}

async function fetchAmapJson(params: {
  config: AmapWebServiceConfig;
  path: string;
  query: Record<string, string | number | undefined>;
  signal?: AbortSignal;
}): Promise<{ payload: AmapJson; requestUrl: string }> {
  const url = buildAmapUrl(params);
  const response = await fetch(url, { signal: params.signal });
  let payload: AmapJson;
  try {
    payload = (await response.json()) as AmapJson;
  } catch (cause) {
    throw new Error(`AMap returned malformed JSON for ${params.path}`, { cause });
  }
  if (!response.ok) {
    throw new Error(`AMap HTTP ${response.status}: ${String(payload.info ?? response.statusText)}`);
  }
  const error = responseErrorMessage(payload);
  if (error) {
    throw new Error(`AMap ${params.path} failed: ${error}`);
  }
  return { payload, requestUrl: sanitizeUrl(url) };
}

function firstString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (Array.isArray(value)) {
    return firstString(value[0]);
  }
  return undefined;
}

function normalizeGeocode(raw: unknown): GeocodeResult | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  return {
    formattedAddress: firstString(raw.formatted_address),
    location: firstString(raw.location),
    level: firstString(raw.level),
    province: firstString(raw.province),
    city: firstString(raw.city),
    district: firstString(raw.district),
    adcode: firstString(raw.adcode),
  };
}

async function geocodeAddress(params: {
  config: AmapWebServiceConfig;
  address: string;
  city?: string;
  signal?: AbortSignal;
}): Promise<{ result: GeocodeResult; requestUrl: string }> {
  const { payload, requestUrl } = await fetchAmapJson({
    config: params.config,
    path: "/v3/geocode/geo",
    query: {
      address: params.address,
      city: params.city ?? resolveDefaultCity(params.config),
    },
    signal: params.signal,
  });
  const geocodes = Array.isArray(payload.geocodes) ? payload.geocodes : [];
  const first = normalizeGeocode(geocodes[0]);
  if (!first?.location) {
    throw new Error(`AMap geocode returned no coordinates for address: ${params.address}`);
  }
  return { result: first, requestUrl };
}

function parseLocation(location: string): LngLat {
  const normalized = normalizeLngLat(location);
  if (!normalized) {
    throw new Error(`Invalid longitude,latitude coordinate: ${location}`);
  }
  const [lng, lat] = normalized.split(",");
  return { lng, lat };
}

function locationString(location: LngLat): string {
  return `${location.lng},${location.lat}`;
}

function isHomeAlias(value: string): boolean {
  return /^(?:home|家|我家|我们家|家里)$/iu.test(value.trim());
}

async function resolvePlaceToLocation(params: {
  config: AmapWebServiceConfig;
  value: string | undefined;
  city?: string;
  signal?: AbortSignal;
}): Promise<{
  location: string;
  source: "coordinate" | "defaultOriginAddress" | "geocode";
  geocode?: GeocodeResult;
}> {
  const raw = params.value?.trim();
  const defaultOriginAddress = resolveDefaultOriginAddress(params.config);
  const value = !raw || isHomeAlias(raw) ? defaultOriginAddress : raw;
  if (!value) {
    throw new Error("origin/address required; no defaultOriginAddress is configured.");
  }
  const coordinate = normalizeLngLat(value);
  if (coordinate) {
    return { location: coordinate, source: "coordinate" };
  }
  const geocode = await geocodeAddress({
    config: params.config,
    address: value,
    city: params.city,
    signal: params.signal,
  });
  return {
    location: geocode.result.location!,
    source: value === defaultOriginAddress ? "defaultOriginAddress" : "geocode",
    geocode: geocode.result,
  };
}

function readIntegerParam(
  params: Record<string, unknown>,
  key: string,
  fallback: number,
  options?: { min?: number; max?: number },
): number {
  const value = readNumberParam(params, key, { integer: true }) ?? fallback;
  return Math.max(options?.min ?? value, Math.min(options?.max ?? value, value));
}

function normalizePoi(raw: unknown) {
  if (!isRecord(raw)) {
    return undefined;
  }
  return {
    id: firstString(raw.id),
    name: firstString(raw.name),
    type: firstString(raw.type),
    address: firstString(raw.address),
    location: firstString(raw.location),
    distanceMeters: firstString(raw.distance),
    tel: firstString(raw.tel),
    pname: firstString(raw.pname),
    cityname: firstString(raw.cityname),
    adname: firstString(raw.adname),
  };
}

function normalizePath(raw: unknown) {
  if (!isRecord(raw)) {
    return undefined;
  }
  const steps = Array.isArray(raw.steps)
    ? raw.steps
        .slice(0, 12)
        .map((step) =>
          isRecord(step)
            ? {
                instruction: firstString(step.instruction),
                road: firstString(step.road),
                distanceMeters: firstString(step.distance),
                durationSeconds: firstString(step.duration),
              }
            : undefined,
        )
        .filter(Boolean)
    : [];
  return {
    distanceMeters: firstString(raw.distance),
    durationSeconds: firstString(raw.duration),
    strategy: firstString(raw.strategy),
    tolls: firstString(raw.tolls),
    restriction: firstString(raw.restriction),
    steps,
  };
}

function weatherRangeText(low: unknown, high: unknown): string {
  const lowText = firstString(low);
  const highText = firstString(high);
  if (lowText && highText) {
    return `${lowText}-${highText}°C`;
  }
  if (highText) {
    return `${highText}°C`;
  }
  return lowText ? `${lowText}°C` : "";
}

function weatherCastLabel(cast: Record<string, unknown>): string {
  const dayWeather = firstString(cast.dayweather);
  const nightWeather = firstString(cast.nightweather);
  if (dayWeather && nightWeather && dayWeather !== nightWeather) {
    return `${dayWeather}转${nightWeather}`;
  }
  return dayWeather ?? nightWeather ?? "天气";
}

function normalizeWeatherCast(raw: unknown) {
  if (!isRecord(raw)) {
    return undefined;
  }
  const label = weatherCastLabel(raw);
  const tempText = weatherRangeText(raw.nighttemp, raw.daytemp);
  return {
    date: firstString(raw.date),
    weatherText: `${label} ${tempText}`.trim(),
    dayweather: firstString(raw.dayweather),
    nightweather: firstString(raw.nightweather),
    daytemp: firstString(raw.daytemp),
    nighttemp: firstString(raw.nighttemp),
    daywind: firstString(raw.daywind),
    nightwind: firstString(raw.nightwind),
    daypower: firstString(raw.daypower),
    nightpower: firstString(raw.nightpower),
  };
}

function weatherStatePath(config: AmapWebServiceConfig, filename: string): string {
  return path.join(resolveAmapStateDir(config), "weather", filename);
}

async function readJsonFile(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, "utf-8")) as unknown;
  } catch {
    return undefined;
  }
}

async function writeJsonFile(filePath: string, payload: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

function weatherCacheKey(city: string, extensions: string): string {
  return `${city.trim()}::${extensions.trim() || "all"}`;
}

function currentMonth(now: Date): string {
  return now.toISOString().slice(0, 7);
}

async function loadWeatherUsage(config: AmapWebServiceConfig, now: Date): Promise<WeatherUsage> {
  const month = currentMonth(now);
  const quota = resolveWeatherMonthlyQuota(config);
  const warnAt = Math.trunc(quota * resolveWeatherQuotaWarnRatio(config));
  const raw = await readJsonFile(weatherStatePath(config, "usage.json"));
  const calls =
    isRecord(raw) && raw.month === month && typeof raw.calls === "number" ? raw.calls : 0;
  return {
    provider: "amap",
    month,
    calls: Number.isFinite(calls) && calls > 0 ? Math.trunc(calls) : 0,
    monthlyQuota: quota,
    warnAt,
    checkedAt: now.toISOString(),
  };
}

function publicWeatherUsage(usage: WeatherUsage) {
  return {
    month: usage.month,
    calls: usage.calls,
    monthlyQuota: usage.monthlyQuota,
    warnAt: usage.warnAt,
    warning: usage.warnAt > 0 && usage.calls >= usage.warnAt,
  };
}

async function writeWeatherUsage(config: AmapWebServiceConfig, usage: WeatherUsage): Promise<void> {
  await writeJsonFile(weatherStatePath(config, "usage.json"), usage);
}

async function recordWeatherCall(params: {
  config: AmapWebServiceConfig;
  usage: WeatherUsage;
  city: string;
  extensions: string;
  now: Date;
}): Promise<WeatherUsage> {
  const usage = {
    ...params.usage,
    calls: params.usage.calls + 1,
    updatedAt: params.now.toISOString(),
    lastCall: {
      provider: "amap",
      city: params.city,
      extensions: params.extensions,
      source: "amap_weather",
    },
  };
  await writeWeatherUsage(params.config, usage);
  return usage;
}

function quotaExceeded(usage: WeatherUsage): boolean {
  return usage.monthlyQuota > 0 && usage.calls >= usage.monthlyQuota;
}

function weatherTextForToday(entry: Record<string, unknown>, now: Date): string | undefined {
  const today = now.toISOString().slice(0, 10);
  const forecastDays = Array.isArray(entry.forecastDays) ? entry.forecastDays : [];
  for (const day of forecastDays) {
    if (isRecord(day) && day.date === today && typeof day.weatherText === "string") {
      return day.weatherText;
    }
  }
  return undefined;
}

async function loadWeatherCache(params: {
  config: AmapWebServiceConfig;
  city: string;
  extensions: string;
  now: Date;
  requireFresh: boolean;
}): Promise<Record<string, unknown> | undefined> {
  const raw = await readJsonFile(weatherStatePath(params.config, "cache.json"));
  const key = weatherCacheKey(params.city, params.extensions);
  const entry =
    isRecord(raw) && isRecord(raw.entries) && isRecord(raw.entries[key])
      ? raw.entries[key]
      : undefined;
  if (!entry) {
    return undefined;
  }
  const entryCity =
    firstString(entry.queryCity) ?? firstString(entry.adcode) ?? firstString(entry.city);
  if (
    entry.provider !== "amap" ||
    entryCity !== params.city ||
    entry.extensions !== params.extensions
  ) {
    return undefined;
  }
  if (!params.requireFresh) {
    return entry;
  }
  const fetchedAt = typeof entry.fetchedAt === "string" ? Date.parse(entry.fetchedAt) : Number.NaN;
  if (!Number.isFinite(fetchedAt)) {
    return undefined;
  }
  const ttlMs = resolveWeatherCacheTtlMinutes(params.config) * 60 * 1000;
  if (ttlMs <= 0 || params.now.getTime() - fetchedAt > ttlMs) {
    return undefined;
  }
  return weatherTextForToday(entry, params.now) ? entry : undefined;
}

async function writeWeatherCache(params: {
  config: AmapWebServiceConfig;
  city: string;
  extensions: string;
  entry: Record<string, unknown>;
}): Promise<void> {
  const filePath = weatherStatePath(params.config, "cache.json");
  const raw = await readJsonFile(filePath);
  const entries = isRecord(raw) && isRecord(raw.entries) ? raw.entries : {};
  await writeJsonFile(filePath, {
    provider: "amap",
    updatedAt: new Date().toISOString(),
    entries: {
      ...entries,
      [weatherCacheKey(params.city, params.extensions)]: params.entry,
    },
  });
}

const GeocodeSchema = Type.Object(
  {
    address: Type.String({ description: "Structured address or place name to geocode." }),
    city: Type.Optional(Type.String({ description: "City hint, e.g. 上海." })),
  },
  { additionalProperties: false },
);

const SearchAroundSchema = Type.Object(
  {
    keywords: Type.String({ description: "POI keywords, e.g. 骑行道, 绿道, 前滩友城公园." }),
    address: Type.Optional(
      Type.String({
        description:
          "Center address. Omit or use 家/home to search around configured defaultOriginAddress.",
      }),
    ),
    location: Type.Optional(
      Type.String({ description: "Center coordinate in longitude,latitude format." }),
    ),
    city: Type.Optional(Type.String({ description: "City hint, e.g. 上海." })),
    radius: Type.Optional(
      Type.Number({ description: "Search radius in meters, default 5000.", minimum: 1 }),
    ),
    limit: Type.Optional(
      Type.Number({ description: "Max returned POIs, default 10.", minimum: 1, maximum: 25 }),
    ),
    types: Type.Optional(Type.String({ description: "Optional AMap POI type filter." })),
  },
  { additionalProperties: false },
);

const RouteSchema = Type.Object(
  {
    origin: Type.Optional(
      Type.String({
        description:
          "Origin address or longitude,latitude. Omit or use 家/home to use configured defaultOriginAddress.",
      }),
    ),
    destination: Type.String({
      description: "Destination address/place name or longitude,latitude.",
    }),
    city: Type.Optional(Type.String({ description: "City hint for geocoding, e.g. 上海." })),
    mode: Type.Optional(
      Type.Union([Type.Literal("driving"), Type.Literal("walking"), Type.Literal("bicycling")]),
    ),
    strategy: Type.Optional(
      Type.Number({
        description: "Driving strategy. For AMap v3 driving only; omit unless needed.",
      }),
    ),
  },
  { additionalProperties: false },
);

const WeatherSchema = Type.Object(
  {
    city: Type.Optional(
      Type.String({
        description:
          "AMap weather city/adcode. Omit to use configured defaultWeatherCity/defaultCity.",
      }),
    ),
    extensions: Type.Optional(
      Type.Union([Type.Literal("all"), Type.Literal("base")], {
        description: "all returns forecast weather; base returns live weather. Default all.",
      }),
    ),
  },
  { additionalProperties: false },
);

function createGeocodeTool(config: AmapWebServiceConfig): AnyAgentTool {
  return {
    name: "amap_geocode",
    label: "AMap Geocode",
    description:
      "Convert a Chinese address or place name into AMap longitude,latitude coordinates. Use before answering precise location questions.",
    parameters: GeocodeSchema,
    execute: async (_toolCallId, rawParams, signal) => {
      const params = rawParams as Record<string, unknown>;
      const address = readStringParam(params, "address", { required: true });
      const city = readStringParam(params, "city") ?? resolveDefaultCity(config);
      const geocode = await geocodeAddress({ config, address, city, signal });
      return jsonResult({
        source: "amap",
        tool: "amap_geocode",
        requestUrl: geocode.requestUrl,
        address,
        city,
        result: geocode.result,
      });
    },
  };
}

function createSearchAroundTool(config: AmapWebServiceConfig): AnyAgentTool {
  return {
    name: "amap_search_around",
    label: "AMap Nearby Search",
    description:
      "Search POIs around a coordinate/address, defaulting to configured home address. Use for 家附近/周边/附近地点 queries.",
    parameters: SearchAroundSchema,
    execute: async (_toolCallId, rawParams, signal) => {
      const params = rawParams as Record<string, unknown>;
      const keywords = readStringParam(params, "keywords", { required: true });
      const city = readStringParam(params, "city") ?? resolveDefaultCity(config);
      const radius = readIntegerParam(params, "radius", DEFAULT_RADIUS_M, {
        min: 1,
        max: 50_000,
      });
      const limit = readIntegerParam(params, "limit", DEFAULT_LIMIT, { min: 1, max: 25 });
      const locationParam = readStringParam(params, "location");
      const address = readStringParam(params, "address");
      const center = locationParam
        ? { location: locationString(parseLocation(locationParam)), source: "coordinate" as const }
        : await resolvePlaceToLocation({ config, value: address, city, signal });
      const { payload, requestUrl } = await fetchAmapJson({
        config,
        path: "/v3/place/around",
        query: {
          keywords,
          location: center.location,
          city,
          radius,
          types: readStringParam(params, "types"),
          offset: limit,
          page: 1,
          sortrule: "distance",
          extensions: "base",
        },
        signal,
      });
      const pois = (Array.isArray(payload.pois) ? payload.pois : [])
        .map(normalizePoi)
        .filter(Boolean)
        .slice(0, limit);
      return jsonResult({
        source: "amap",
        tool: "amap_search_around",
        requestUrl,
        query: { keywords, city, radius, limit },
        center,
        count: pois.length,
        pois,
      });
    },
  };
}

function routePathForMode(mode: string): string {
  switch (mode) {
    case "walking":
      return "/v3/direction/walking";
    case "bicycling":
      return "/v4/direction/bicycling";
    case "driving":
    default:
      return "/v3/direction/driving";
  }
}

function extractRoutePaths(payload: AmapJson, mode: string): unknown[] {
  if (mode === "bicycling" && isRecord(payload.data) && Array.isArray(payload.data.paths)) {
    return payload.data.paths;
  }
  if (isRecord(payload.route) && Array.isArray(payload.route.paths)) {
    return payload.route.paths;
  }
  return [];
}

function createRouteTool(config: AmapWebServiceConfig): AnyAgentTool {
  return {
    name: "amap_route",
    label: "AMap Route",
    description:
      "Plan driving, walking, or bicycling routes with AMap. Use for distance, duration, route, navigation, or 起止点 questions.",
    parameters: RouteSchema,
    execute: async (_toolCallId, rawParams, signal) => {
      const params = rawParams as Record<string, unknown>;
      const city = readStringParam(params, "city") ?? resolveDefaultCity(config);
      const mode = readStringParam(params, "mode") ?? "driving";
      if (!["driving", "walking", "bicycling"].includes(mode)) {
        throw new Error(`Unsupported route mode: ${mode}`);
      }
      const origin = await resolvePlaceToLocation({
        config,
        value: readStringParam(params, "origin"),
        city,
        signal,
      });
      const destination = await resolvePlaceToLocation({
        config,
        value: readStringParam(params, "destination", { required: true }),
        city,
        signal,
      });
      const { payload, requestUrl } = await fetchAmapJson({
        config,
        path: routePathForMode(mode),
        query: {
          origin: origin.location,
          destination: destination.location,
          strategy:
            mode === "driving" ? readNumberParam(params, "strategy", { integer: true }) : undefined,
        },
        signal,
      });
      const paths = extractRoutePaths(payload, mode).map(normalizePath).filter(Boolean);
      if (paths.length === 0) {
        throw new Error(`AMap route returned no paths for ${mode}.`);
      }
      return jsonResult({
        source: "amap",
        tool: "amap_route",
        requestUrl,
        mode,
        city,
        origin,
        destination,
        route: {
          distanceMeters: paths[0]?.distanceMeters,
          durationSeconds: paths[0]?.durationSeconds,
          paths,
        },
      });
    },
  };
}

function normalizeWeatherPayload(params: {
  city: string;
  extensions: string;
  requestUrl: string;
  payload: AmapJson;
  fetchedAt: string;
}) {
  if (params.extensions === "base") {
    const lives = Array.isArray(params.payload.lives) ? params.payload.lives : [];
    const live = isRecord(lives[0]) ? lives[0] : undefined;
    if (!live) {
      throw new Error("AMap weather returned no live weather.");
    }
    const weather = firstString(live.weather) ?? "天气";
    const temperature = firstString(live.temperature);
    const weatherText = `${weather}${temperature ? ` ${temperature}°C` : ""}`.trim();
    return {
      provider: "amap",
      city: firstString(live.city) ?? params.city,
      adcode: firstString(live.adcode) ?? params.city,
      province: firstString(live.province),
      reporttime: firstString(live.reporttime),
      extensions: params.extensions,
      requestUrl: params.requestUrl,
      fetchedAt: params.fetchedAt,
      weatherText,
      live: {
        weather,
        temperature,
        winddirection: firstString(live.winddirection),
        windpower: firstString(live.windpower),
        humidity: firstString(live.humidity),
      },
    };
  }

  const forecasts = Array.isArray(params.payload.forecasts) ? params.payload.forecasts : [];
  const forecast = isRecord(forecasts[0]) ? forecasts[0] : {};
  const casts = Array.isArray(forecast.casts) ? forecast.casts : [];
  const forecastDays = casts.map(normalizeWeatherCast).filter(Boolean).slice(0, 4);
  if (forecastDays.length === 0) {
    throw new Error("AMap weather returned no forecast days.");
  }
  return {
    provider: "amap",
    city: firstString(forecast.city) ?? params.city,
    adcode: firstString(forecast.adcode) ?? params.city,
    province: firstString(forecast.province),
    reporttime: firstString(forecast.reporttime),
    extensions: params.extensions,
    requestUrl: params.requestUrl,
    fetchedAt: params.fetchedAt,
    weatherText: forecastDays[0]?.weatherText,
    forecastDays,
  };
}

function createWeatherTool(config: AmapWebServiceConfig): AnyAgentTool {
  return {
    name: "amap_weather",
    label: "AMap Weather",
    description:
      "Query AMap weather by city/adcode with built-in TTL cache and monthly quota guard. Use for current or forecast weather answers that need a real source.",
    parameters: WeatherSchema,
    execute: async (_toolCallId, rawParams, signal) => {
      const params = rawParams as Record<string, unknown>;
      const city = readStringParam(params, "city") ?? resolveDefaultWeatherCity(config);
      const extensions = readStringParam(params, "extensions") ?? "all";
      if (!["all", "base"].includes(extensions)) {
        throw new Error(`Unsupported weather extensions: ${extensions}`);
      }
      const now = new Date();
      const freshCache = await loadWeatherCache({
        config,
        city,
        extensions,
        now,
        requireFresh: true,
      });
      let usage = await loadWeatherUsage(config, now);
      await writeWeatherUsage(config, usage);
      if (freshCache) {
        return jsonResult({
          source: "amap",
          tool: "amap_weather",
          cacheHit: true,
          query: { city, extensions },
          usage: publicWeatherUsage(usage),
          result: freshCache,
        });
      }

      if (quotaExceeded(usage)) {
        const staleCache = await loadWeatherCache({
          config,
          city,
          extensions,
          now,
          requireFresh: false,
        });
        if (staleCache) {
          return jsonResult({
            source: "amap",
            tool: "amap_weather",
            cacheHit: true,
            stale: true,
            quotaBlocked: true,
            query: { city, extensions },
            usage: publicWeatherUsage(usage),
            result: staleCache,
          });
        }
        throw new Error(
          "AMap weather monthly quota guard blocked this request and no cache is available.",
        );
      }

      usage = await recordWeatherCall({ config, usage, city, extensions, now });
      const { payload, requestUrl } = await fetchAmapJson({
        config,
        path: "/v3/weather/weatherInfo",
        query: { city, extensions },
        signal,
      });
      const result = normalizeWeatherPayload({
        city,
        extensions,
        requestUrl,
        payload,
        fetchedAt: now.toISOString(),
      });
      const cacheEntry = { ...result, queryCity: city };
      await writeWeatherCache({ config, city, extensions, entry: cacheEntry });
      return jsonResult({
        source: "amap",
        tool: "amap_weather",
        cacheHit: false,
        query: { city, extensions },
        usage: publicWeatherUsage(usage),
        result: cacheEntry,
      });
    },
  };
}

export default definePluginEntry({
  id: "amap",
  name: "AMap Web Service Plugin",
  description: "AMap geocoding, nearby search, route planning, and weather tools.",
  register(api) {
    const config = resolveAmapConfig(api.config);
    api.registerTool(createGeocodeTool(config));
    api.registerTool(createSearchAroundTool(config));
    api.registerTool(createRouteTool(config));
    api.registerTool(createWeatherTool(config));
  },
});
