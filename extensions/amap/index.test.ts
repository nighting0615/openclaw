import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

function createAmapApi() {
  const tools: AnyAgentTool[] = [];
  const api = createTestPluginApi({
    id: "amap",
    name: "AMap",
    source: "test",
    config: {
      plugins: {
        entries: {
          amap: {
            config: {
              webService: {
                apiKey: "test-key",
                defaultCity: "上海",
                defaultOriginAddress: "上海市浦东新区东波路49弄",
              },
            },
          },
        },
      },
    },
    registerTool(tool) {
      tools.push(tool as AnyAgentTool);
    },
  });
  return { api, tools };
}

function toolByName(tools: AnyAgentTool[], name: string): AnyAgentTool {
  const tool = tools.find((entry) => entry.name === name);
  if (!tool) {
    throw new Error(`Expected tool ${name} to be registered`);
  }
  return tool;
}

function mockJsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("amap plugin", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers geocode, nearby search, and route tools", () => {
    const { api, tools } = createAmapApi();

    plugin.register(api);

    expect(tools.map((tool) => tool.name)).toEqual([
      "amap_geocode",
      "amap_search_around",
      "amap_route",
    ]);
  });

  it("geocodes addresses and redacts the configured API key in tool details", async () => {
    const { api, tools } = createAmapApi();
    plugin.register(api);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockJsonResponse({
        status: "1",
        geocodes: [
          {
            formatted_address: "上海市浦东新区测试地址",
            location: "121.500000,31.200000",
            level: "门牌号",
          },
        ],
      }),
    );

    const result = await toolByName(tools, "amap_geocode").execute?.("call-1", {
      address: "上海市浦东新区测试地址",
    });

    const details = result?.details as {
      requestUrl: string;
      result: { location: string; formattedAddress: string };
    };
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("key=test-key");
    expect(details.requestUrl).toContain("key=REDACTED");
    expect(details.requestUrl).not.toContain("test-key");
    expect(details.result).toMatchObject({
      formattedAddress: "上海市浦东新区测试地址",
      location: "121.500000,31.200000",
    });
  });

  it("routes from the configured default origin when origin is omitted", async () => {
    const { api, tools } = createAmapApi();
    plugin.register(api);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/v3/geocode/geo") {
        const address = url.searchParams.get("address");
        return mockJsonResponse({
          status: "1",
          geocodes: [
            {
              formatted_address: address,
              location:
                address === "前滩友城公园" ? "121.480000,31.160000" : "121.590000,31.290000",
              level: "兴趣点",
            },
          ],
        });
      }
      if (url.pathname === "/v3/direction/driving") {
        return mockJsonResponse({
          status: "1",
          route: {
            paths: [
              {
                distance: "18000",
                duration: "2100",
                strategy: "速度优先",
                steps: [{ instruction: "沿主路行驶", distance: "500", duration: "120" }],
              },
            ],
          },
        });
      }
      throw new Error(`Unexpected AMap test URL: ${url.pathname}`);
    });

    const result = await toolByName(tools, "amap_route").execute?.("call-1", {
      destination: "前滩友城公园",
      mode: "driving",
    });

    const details = result?.details as {
      origin: { source: string };
      destination: { geocode: { formattedAddress: string } };
      route: { distanceMeters: string; durationSeconds: string };
    };
    expect(details.origin.source).toBe("defaultOriginAddress");
    expect(details.destination.geocode.formattedAddress).toBe("前滩友城公园");
    expect(details.route).toMatchObject({
      distanceMeters: "18000",
      durationSeconds: "2100",
    });
  });

  it("normalizes numeric distance and duration from bicycling routes", async () => {
    const { api, tools } = createAmapApi();
    plugin.register(api);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/v3/geocode/geo") {
        return mockJsonResponse({
          status: "1",
          geocodes: [
            {
              formatted_address: url.searchParams.get("address"),
              location: "121.500000,31.200000",
              level: "兴趣点",
            },
          ],
        });
      }
      if (url.pathname === "/v4/direction/bicycling") {
        return mockJsonResponse({
          errcode: 0,
          errmsg: "OK",
          data: {
            paths: [
              {
                distance: 12593,
                duration: 3022,
                steps: [{ instruction: "沿骑行道骑行", distance: 500, duration: 120 }],
              },
            ],
          },
        });
      }
      throw new Error(`Unexpected AMap test URL: ${url.pathname}`);
    });

    const result = await toolByName(tools, "amap_route").execute?.("call-1", {
      destination: "前滩友城公园",
      mode: "bicycling",
    });

    const details = result?.details as {
      mode: string;
      route: {
        distanceMeters: string;
        durationSeconds: string;
        paths: Array<{ steps: Array<{ distanceMeters: string; durationSeconds: string }> }>;
      };
    };
    expect(details.mode).toBe("bicycling");
    expect(details.route.distanceMeters).toBe("12593");
    expect(details.route.durationSeconds).toBe("3022");
    expect(details.route.paths[0]?.steps[0]).toMatchObject({
      distanceMeters: "500",
      durationSeconds: "120",
    });
  });
});
