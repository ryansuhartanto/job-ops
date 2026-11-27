import { createHash } from "node:crypto";
import type { Server } from "node:http";
import { join } from "node:path";
import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServer, stopServer } from "./test-utils";

const AUTH_ENV = {
  BASIC_AUTH_USER: "admin",
  BASIC_AUTH_PASSWORD: "secret",
  JWT_SECRET: "an-explicit-jwt-secret-with-at-least-32-chars",
  JOBOPS_TEST_AUTH_BYPASS: "0",
};

const TOKEN_PATTERN = /^jo_pat_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/;

async function login(baseUrl: string, username: string, password: string) {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  expect(res.status).toBe(200);
  return (await res.json()).data.token as string;
}

function authHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

async function createToken(
  baseUrl: string,
  sessionToken: string,
  body: Record<string, unknown>,
) {
  const res = await fetch(`${baseUrl}/api/auth/tokens`, {
    method: "POST",
    headers: authHeaders(sessionToken),
    body: JSON.stringify(body),
  });
  const json = await res.json();
  expect(res.status).toBe(201);
  return json.data as {
    token: { id: string; prefix: string; scope: string; expiresAt: string };
    secret: string;
    mcpUrl: string | null;
  };
}

describe.sequential("Access token routes", () => {
  let server: Server;
  let baseUrl: string;
  let closeDb: () => void;
  let tempDir: string;

  function openDb() {
    return new Database(join(tempDir, "jobs.db"));
  }

  beforeEach(async () => {
    ({ server, baseUrl, closeDb, tempDir } = await startServer({
      env: AUTH_ENV,
    }));
  });

  afterEach(async () => {
    await stopServer({ server, closeDb, tempDir });
  });

  it("returns the secret once and stores only its SHA-256 hash", async () => {
    const session = await login(baseUrl, "admin", "secret");
    const created = await createToken(baseUrl, session, {
      name: "Claude Code",
      scope: "write",
    });

    expect(created.secret).toMatch(TOKEN_PATTERN);
    expect(created.secret.startsWith(created.token.prefix)).toBe(true);
    expect(created.token).toMatchObject({
      name: "Claude Code",
      scope: "write",
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
    });
    expect(created.mcpUrl).toBe(`${baseUrl}/mcp`);

    const listRes = await fetch(`${baseUrl}/api/auth/tokens`, {
      headers: authHeaders(session),
    });
    const list = await listRes.json();
    expect(listRes.status).toBe(200);
    expect(list.data.tokens).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(created.secret);
    expect(list.data.mcpUrl).toBe(`${baseUrl}/mcp`);

    const db = openDb();
    try {
      const row = db
        .prepare("SELECT token_hash, token_prefix FROM access_tokens")
        .get() as { token_hash: string; token_prefix: string };
      expect(row.token_hash).toBe(
        createHash("sha256").update(created.secret).digest("hex"),
      );
      const everything = JSON.stringify(
        db.prepare("SELECT * FROM access_tokens").all(),
      );
      // The random part after `jo_pat_<prefix>_` must never be stored.
      expect(everything).not.toContain(
        created.secret.slice(created.token.prefix.length + 1),
      );
    } finally {
      db.close();
    }
  });

  it("authenticates API requests and records last use", async () => {
    const session = await login(baseUrl, "admin", "secret");
    const { secret } = await createToken(baseUrl, session, {
      name: "agent",
      scope: "read",
    });

    const meRes = await fetch(`${baseUrl}/api/auth/me`, {
      headers: authHeaders(secret),
    });
    expect(meRes.status).toBe(200);
    expect((await meRes.json()).data.user.username).toBe("admin");

    const list = await fetch(`${baseUrl}/api/auth/tokens`, {
      headers: authHeaders(session),
    }).then((res) => res.json());
    expect(list.data.tokens[0].lastUsedAt).toEqual(expect.any(String));
  });

  it("does not let an access token manage access tokens", async () => {
    const session = await login(baseUrl, "admin", "secret");
    const { secret, token } = await createToken(baseUrl, session, {
      name: "agent",
      scope: "write",
    });

    for (const [method, path, body] of [
      ["GET", "/api/auth/tokens", undefined],
      ["POST", "/api/auth/tokens", { name: "escalate", scope: "write" }],
      ["DELETE", `/api/auth/tokens/${token.id}`, undefined],
    ] as const) {
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: authHeaders(secret),
        body: body ? JSON.stringify(body) : undefined,
      });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect((await res.json()).error.code).toBe("FORBIDDEN");
    }
  });

  it("limits tokens on the REST API to PDF downloads", async () => {
    const session = await login(baseUrl, "admin", "secret");
    const { secret } = await createToken(baseUrl, session, {
      name: "agent",
      scope: "write",
    });

    // Everything an agent does goes through MCP tools. Over REST even a
    // write token is refused, so it cannot step around the tools' rules.
    for (const [method, path, body] of [
      ["GET", "/api/jobs", undefined],
      ["GET", "/api/settings", undefined],
      ["PATCH", "/api/settings", { llmBaseUrl: "https://example.com/v1" }],
      ["PATCH", "/api/settings", { telegramChatId: "12345" }],
      [
        "POST",
        "/api/settings/llm-models",
        { provider: "openai_compatible", baseUrl: "https://example.com" },
      ],
      ["GET", "/api/profile", undefined],
      ["GET", "/api/onboarding/status", undefined],
      [
        "POST",
        "/api/manual-jobs/import",
        {
          job: {
            title: "Role",
            employer: "Acme",
            jobUrl: "https://example.com/role",
            jobDescription: "Role description",
          },
        },
      ],
      ["POST", "/api/pipeline/run", {}],
      ["POST", "/api/settings/telegram/test", {}],
      ["DELETE", "/api/jobs/some-id", undefined],
      ["POST", "/api/jobs/some-id/pdf", undefined],
      ["GET", "/API/Settings", undefined],
    ] as const) {
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: authHeaders(secret),
        body: body ? JSON.stringify(body) : undefined,
      });
      expect(res.status, `${method} ${path}`).toBe(403);
      const payload = await res.json();
      expect(payload.error.code).toBe("FORBIDDEN");
      expect(payload.error.message).toContain("only download PDFs");
    }

    // PDF downloads get past the guard (the job does not exist here).
    for (const path of ["/api/jobs/missing/pdf", "/api/role-cvs/missing/pdf"]) {
      const res = await fetch(`${baseUrl}${path}`, {
        headers: authHeaders(secret),
      });
      expect(res.status, path).not.toBe(403);
      expect(res.status, path).not.toBe(401);
    }

    // The same settings change is still allowed from a signed-in session.
    const viaSession = await fetch(`${baseUrl}/api/settings`, {
      headers: authHeaders(session),
    });
    expect(viaSession.status).toBe(200);
  });

  it("keeps account and instance administration away from tokens", async () => {
    const session = await login(baseUrl, "admin", "secret");
    const { secret } = await createToken(baseUrl, session, {
      name: "agent",
      scope: "write",
    });

    for (const [method, path] of [
      ["POST", "/api/workspaces/me/password"],
      ["POST", "/api/workspaces/users"],
      ["GET", "/api/workspaces/users"],
      ["DELETE", "/api/database"],
      ["GET", "/api/backups"],
      ["DELETE", "/api/backups/backup.db"],
      ["GET", "/api/auth/sso/identities"],
      ["POST", "/api/settings/codex-auth"],
      ["DELETE", "/API/Database"],
    ] as const) {
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: authHeaders(secret),
        body: method === "POST" ? JSON.stringify({}) : undefined,
      });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect((await res.json()).error.code).toBe("FORBIDDEN");
    }
  });

  it("requires authentication whatever the letter case of the API path", async () => {
    await login(baseUrl, "admin", "secret");

    for (const [method, path] of [
      ["GET", "/API/jobs"],
      ["GET", "/Api/Settings"],
      ["GET", "/API/profile"],
      ["DELETE", "/API/database"],
      ["POST", "/API/manual-jobs/import"],
    ] as const) {
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: method === "POST" ? JSON.stringify({}) : undefined,
      });
      expect(res.status, `${method} ${path}`).toBe(401);
    }

    const publicStatus = await fetch(`${baseUrl}/API/app/status`);
    expect(publicStatus.status).toBe(200);
  });

  it("rejects revoked, expired and tampered tokens", async () => {
    const session = await login(baseUrl, "admin", "secret");
    const revoked = await createToken(baseUrl, session, {
      name: "revoked",
      scope: "write",
    });
    const expiring = await createToken(baseUrl, session, {
      name: "expiring",
      scope: "write",
      expiresInDays: 1,
    });
    expect(Date.parse(expiring.token.expiresAt)).toBeGreaterThan(Date.now());

    const revokeRes = await fetch(
      `${baseUrl}/api/auth/tokens/${revoked.token.id}`,
      { method: "DELETE", headers: authHeaders(session) },
    );
    expect(revokeRes.status).toBe(200);
    expect((await revokeRes.json()).data.revokedAt).toEqual(expect.any(String));

    const db = openDb();
    try {
      db.prepare("UPDATE access_tokens SET expires_at = ? WHERE id = ?").run(
        new Date(Date.now() - 1000).toISOString(),
        expiring.token.id,
      );
    } finally {
      db.close();
    }

    const tampered = `${expiring.secret.slice(0, -1)}${
      expiring.secret.endsWith("A") ? "B" : "A"
    }`;
    for (const secret of [revoked.secret, expiring.secret, tampered]) {
      const res = await fetch(`${baseUrl}/api/jobs`, {
        headers: authHeaders(secret),
      });
      expect(res.status).toBe(401);
    }
  });

  it("scopes tokens to their owner and rejects tokens of disabled users", async () => {
    const adminSession = await login(baseUrl, "admin", "secret");
    const createUserRes = await fetch(`${baseUrl}/api/workspaces/users`, {
      method: "POST",
      headers: authHeaders(adminSession),
      body: JSON.stringify({
        username: "adam",
        displayName: "Adam",
        password: "adam-secret",
      }),
    });
    expect(createUserRes.status).toBe(201);
    const adamId = (await createUserRes.json()).data.user.id as string;
    const adamSession = await login(baseUrl, "adam", "adam-secret");

    const adminToken = await createToken(baseUrl, adminSession, {
      name: "admin agent",
      scope: "write",
    });
    const adamToken = await createToken(baseUrl, adamSession, {
      name: "adam agent",
      scope: "write",
    });

    const adamList = await fetch(`${baseUrl}/api/auth/tokens`, {
      headers: authHeaders(adamSession),
    }).then((res) => res.json());
    expect(adamList.data.tokens.map((t: { id: string }) => t.id)).toEqual([
      adamToken.token.id,
    ]);

    const crossRevoke = await fetch(
      `${baseUrl}/api/auth/tokens/${adminToken.token.id}`,
      { method: "DELETE", headers: authHeaders(adamSession) },
    );
    expect(crossRevoke.status).toBe(404);

    expect(
      (
        await fetch(`${baseUrl}/api/auth/me`, {
          headers: authHeaders(adamToken.secret),
        })
      ).status,
    ).toBe(200);

    const disableRes = await fetch(
      `${baseUrl}/api/workspaces/users/${adamId}/disabled`,
      {
        method: "PATCH",
        headers: authHeaders(adminSession),
        body: JSON.stringify({ isDisabled: true }),
      },
    );
    expect(disableRes.status).toBe(200);

    expect(
      (
        await fetch(`${baseUrl}/api/auth/me`, {
          headers: authHeaders(adamToken.secret),
        })
      ).status,
    ).toBe(401);
  });

  it("validates token input", async () => {
    const session = await login(baseUrl, "admin", "secret");
    for (const body of [
      { name: "", scope: "read" },
      { name: "agent", scope: "admin" },
      { name: "agent", scope: "read", expiresInDays: 0 },
      { name: "agent", scope: "read", expiresInDays: 1000 },
    ]) {
      const res = await fetch(`${baseUrl}/api/auth/tokens`, {
        method: "POST",
        headers: authHeaders(session),
        body: JSON.stringify(body),
      });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await res.json()).error.code).toBe("INVALID_REQUEST");
    }
  });

  it("requires authentication", async () => {
    const res = await fetch(`${baseUrl}/api/auth/tokens`);
    expect(res.status).toBe(401);
  });
});
