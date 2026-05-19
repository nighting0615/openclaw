import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildQaTarget,
  createQaBusThread,
  deleteQaBusMessage,
  editQaBusMessage,
  getQaBusState,
  parseQaTarget,
  pollQaBus,
  reactToQaBusMessage,
  readQaBusMessage,
  sendQaBusMessage,
} from "./bus-client.js";

async function startJsonServer(
  handler: (req: { url?: string | undefined }) => { statusCode?: number; body: string },
) {
  const server = createServer((req, res) => {
    const response = handler({ url: req.url });
    res.writeHead(response.statusCode ?? 200, {
      "content-type": "application/json; charset=utf-8",
    });
    res.end(response.body);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server failed to bind");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async stop() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function startJsonBodyServer(
  handler: (req: { method?: string | undefined; url?: string | undefined; body: unknown }) => {
    statusCode?: number;
    body: string;
  },
) {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "invalid json" }));
        return;
      }
      const response = handler({ method: req.method, url: req.url, body });
      res.writeHead(response.statusCode ?? 200, {
        "content-type": "application/json; charset=utf-8",
      });
      res.end(response.body);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server failed to bind");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async stop() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

describe("qa-bus client", () => {
  const stops: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(stops.splice(0).map((stop) => stop()));
  });

  it("roundtrips explicit group targets", () => {
    expect(parseQaTarget("group:ops-room")).toEqual({
      chatType: "group",
      conversationId: "ops-room",
    });
    expect(
      buildQaTarget({
        chatType: "group",
        conversationId: "ops-room",
      }),
    ).toBe("group:ops-room");
  });

  it("rejects empty prefixed targets", () => {
    expect(() => parseQaTarget("channel:")).toThrow(/invalid qa-channel target/);
    expect(() => parseQaTarget("group:")).toThrow(/invalid qa-channel target/);
    expect(() => parseQaTarget("dm:")).toThrow(/invalid qa-channel target/);
    expect(() => parseQaTarget("channel:   ")).toThrow(/invalid qa-channel target/);
    expect(parseQaTarget("dm: alice ")).toEqual({
      chatType: "direct",
      conversationId: "alice",
    });
  });

  it("does not include baseUrl in action request bodies", async () => {
    const requests: Array<{ url?: string | undefined; body: unknown }> = [];
    const server = await startJsonBodyServer((req) => {
      requests.push({ url: req.url, body: req.body });
      if (req.url === "/v1/actions/thread-create") {
        return { body: JSON.stringify({ thread: { id: "thread-a" } }) };
      }
      return { body: JSON.stringify({ message: { id: "message-a" } }) };
    });
    stops.push(server.stop);

    await sendQaBusMessage({
      baseUrl: server.baseUrl,
      accountId: "acct-a",
      to: "dm:alice",
      text: "hi",
      senderId: "bot",
    });
    await createQaBusThread({
      baseUrl: server.baseUrl,
      accountId: "acct-a",
      conversationId: "room-a",
      title: "Thread A",
      createdBy: "bot",
    });
    await reactToQaBusMessage({
      baseUrl: server.baseUrl,
      accountId: "acct-a",
      messageId: "message-a",
      emoji: "+1",
      senderId: "bot",
    });
    await editQaBusMessage({
      baseUrl: server.baseUrl,
      accountId: "acct-a",
      messageId: "message-a",
      text: "updated",
    });
    await deleteQaBusMessage({
      baseUrl: server.baseUrl,
      accountId: "acct-a",
      messageId: "message-a",
    });
    await readQaBusMessage({
      baseUrl: server.baseUrl,
      accountId: "acct-a",
      messageId: "message-a",
    });

    expect(requests).toEqual([
      {
        url: "/v1/outbound/message",
        body: {
          accountId: "acct-a",
          to: "dm:alice",
          text: "hi",
          senderId: "bot",
        },
      },
      {
        url: "/v1/actions/thread-create",
        body: {
          accountId: "acct-a",
          conversationId: "room-a",
          title: "Thread A",
          createdBy: "bot",
        },
      },
      {
        url: "/v1/actions/react",
        body: {
          accountId: "acct-a",
          messageId: "message-a",
          emoji: "+1",
          senderId: "bot",
        },
      },
      {
        url: "/v1/actions/edit",
        body: {
          accountId: "acct-a",
          messageId: "message-a",
          text: "updated",
        },
      },
      {
        url: "/v1/actions/delete",
        body: {
          accountId: "acct-a",
          messageId: "message-a",
        },
      },
      {
        url: "/v1/actions/read",
        body: {
          accountId: "acct-a",
          messageId: "message-a",
        },
      },
    ]);
  });

  it("rejects malformed JSON responses instead of throwing from the stream callback", async () => {
    const server = await startJsonServer(() => ({
      body: '{"cursor":1,"events":[',
    }));
    stops.push(server.stop);

    await expect(
      pollQaBus({
        baseUrl: server.baseUrl,
        accountId: "acct-a",
        cursor: 0,
        timeoutMs: 0,
      }),
    ).rejects.toThrow(SyntaxError);
  });

  it("rejects immediately when a poll request is aborted", async () => {
    const server = createServer((_req, _res) => {
      // Keep the request open so the client abort path owns the outcome.
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test server failed to bind");
    }

    stops.push(async () => {
      server.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    });

    const abort = new AbortController();
    const request = pollQaBus({
      baseUrl: `http://127.0.0.1:${address.port}`,
      accountId: "acct-a",
      cursor: 0,
      timeoutMs: 30_000,
      signal: abort.signal,
    });
    abort.abort();

    try {
      await withTimeout(request, 500, "poll abort did not settle");
      throw new Error("expected poll abort to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).name).toBe("AbortError");
    }
  });

  it("preserves baseUrl path prefixes when composing bus URLs", async () => {
    const server = await startJsonServer((req) => ({
      statusCode: req.url === "/qa-bus/v1/state" ? 200 : 404,
      body:
        req.url === "/qa-bus/v1/state"
          ? JSON.stringify({
              cursor: 1,
              conversations: [],
              threads: [],
              messages: [],
              events: [],
            })
          : JSON.stringify({ error: `unexpected path: ${req.url}` }),
    }));
    stops.push(server.stop);

    await expect(getQaBusState(`${server.baseUrl}/qa-bus`)).resolves.toEqual({
      cursor: 1,
      conversations: [],
      threads: [],
      messages: [],
      events: [],
    });
  });
});
