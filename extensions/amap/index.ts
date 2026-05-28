import { jsonResult, readNumberParam, readStringParam } from "openclaw/plugin-sdk/channel-actions";
import { definePluginEntry, type AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { coerceSecretRef, normalizeSecretInputString } from "openclaw/plugin-sdk/secret-input";
import { Type } from "typebox";

const DEFAULT_AMAP_BASE_URL = "https://restapi.amap.com";
const DEFAULT_CITY = "上海";
const DEFAULT_RADIUS_M = 5000;
const DEFAULT_LIMIT = 10;

type AmapWebServiceConfig = {
  apiKey?: unknown;
  defaultCity?: string;
  defaultOriginAddress?: string;
  baseUrl?: string;
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

export default definePluginEntry({
  id: "amap",
  name: "AMap Web Service Plugin",
  description: "AMap geocoding, nearby search, and route planning tools.",
  register(api) {
    const config = resolveAmapConfig(api.config);
    api.registerTool(createGeocodeTool(config));
    api.registerTool(createSearchAroundTool(config));
    api.registerTool(createRouteTool(config));
  },
});
