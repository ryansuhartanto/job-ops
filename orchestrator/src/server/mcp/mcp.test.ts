import Database from "bun:sqlite";
import type { Server } from "node:http";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServer, stopServer } from "../api/routes/test-utils";

const AUTH_ENV = {
  BASIC_AUTH_USER: "admin",
  BASIC_AUTH_PASSWORD: "secret",
  JWT_SECRET: "an-explicit-jwt-secret-with-at-least-32-chars",
  JOBOPS_TEST_AUTH_BYPASS: "0",
};

// The read tools from ticket 03. Write tools are covered in their own tests.
const EXPECTED_TOOLS = [
  "list_jobs",
  "get_job",
  "get_job_counts",
  "get_pipeline_status",
  "get_profile",
  "get_app_status",
];

type ToolCallResult = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent: Record<string, any>;
};

function jsonHeaders(token?: string): Record<string, string> {
  return {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function rpc(
  baseUrl: string,
  token: string | undefined,
  method: string,
  params?: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
) {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { ...jsonHeaders(token), ...extraHeaders },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function callTool(
  baseUrl: string,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolCallResult> {
  const { status, body } = await rpc(baseUrl, token, "tools/call", {
    name,
    arguments: args,
  });
  expect(status).toBe(200);
  expect(body.error).toBeUndefined();
  const result = body.result as ToolCallResult;
  // Every result carries the same JSON as text and as structured content.
  expect(JSON.parse(result.content[0]?.text ?? "null")).toEqual(
    result.structuredContent,
  );
  return result;
}

async function login(baseUrl: string, username: string, password: string) {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  expect(res.status).toBe(200);
  return (await res.json()).data.token as string;
}

async function createAccessToken(
  baseUrl: string,
  session: string,
  scope: "read" | "write",
) {
  const res = await fetch(`${baseUrl}/api/auth/tokens`, {
    method: "POST",
    headers: jsonHeaders(session),
    body: JSON.stringify({ name: `${scope} agent`, scope }),
  });
  expect(res.status).toBe(201);
  const body = await res.json();
  return {
    id: body.data.token.id as string,
    secret: body.data.secret as string,
  };
}

async function importJob(
  baseUrl: string,
  session: string,
  job: { title: string; employer: string; location?: string; slug: string },
  patch: Record<string, unknown> = {},
) {
  const res = await fetch(`${baseUrl}/api/manual-jobs/import`, {
    method: "POST",
    headers: jsonHeaders(session),
    body: JSON.stringify({
      job: {
        title: job.title,
        employer: job.employer,
        location: job.location,
        jobUrl: `https://example.com/jobs/${job.slug}`,
        jobDescription: `${job.title} at ${job.employer}. ${"Details. ".repeat(100)}`,
      },
    }),
  });
  expect(res.status).toBe(200);
  const id = (await res.json()).data.id as string;

  // Manual import answers with status "processing" and finishes scoring in
  // the background. Wait for that to settle so the patch below wins.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const current = await fetch(`${baseUrl}/api/jobs/${id}`, {
      headers: jsonHeaders(session),
    }).then((response) => response.json());
    if (current.data.status !== "processing") break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const patchRes = await fetch(`${baseUrl}/api/jobs/${id}`, {
    method: "PATCH",
    headers: jsonHeaders(session),
    body: JSON.stringify({ status: "discovered", ...patch }),
  });
  expect(patchRes.status).toBe(200);
  return id;
}

function rawRequest(
  baseUrl: string,
  input: { method: string; headers: Record<string, string>; body?: string },
): Promise<{ status: number; body: string }> {
  const url = new URL(`${baseUrl}/mcp`);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: input.method,
        headers: input.headers,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    if (input.body) req.write(input.body);
    req.end();
  });
}

describe.sequential("MCP endpoint", () => {
  let server: Server;
  let baseUrl: string;
  let closeDb: () => void;
  let tempDir: string;

  afterEach(async () => {
    await stopServer({ server, closeDb, tempDir });
  });

  describe("with real authentication", () => {
    let adminSession: string;

    beforeEach(async () => {
      ({ server, baseUrl, closeDb, tempDir } = await startServer({
        env: AUTH_ENV,
      }));
      adminSession = await login(baseUrl, "admin", "secret");
    });

    it("requires authentication for every HTTP method", async () => {
      for (const method of ["POST", "GET", "DELETE", "PUT", "PATCH"]) {
        const res = await fetch(`${baseUrl}/mcp`, {
          method,
          headers: jsonHeaders(),
          body:
            method === "GET"
              ? undefined
              : JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
        });
        expect(res.status, method).toBe(401);
      }
      for (const path of ["/MCP", "/mcp/"]) {
        const res = await fetch(`${baseUrl}${path}`, {
          headers: jsonHeaders(),
        });
        expect(res.status, path).toBe(401);
      }
      const garbage = await fetch(`${baseUrl}/mcp`, {
        headers: jsonHeaders("jo_pat_000000000000_not-a-real-token"),
      });
      expect(garbage.status).toBe(401);
    });

    it("rejects revoked and expired tokens on POST and GET", async () => {
      const revoked = await createAccessToken(baseUrl, adminSession, "write");
      const expired = await createAccessToken(baseUrl, adminSession, "write");

      // Valid before: GET is authenticated, then refused as unsupported.
      const before = await fetch(`${baseUrl}/mcp`, {
        headers: jsonHeaders(revoked.secret),
      });
      expect(before.status).toBe(405);

      await fetch(`${baseUrl}/api/auth/tokens/${revoked.id}`, {
        method: "DELETE",
        headers: jsonHeaders(adminSession),
      });
      const db = new Database(join(tempDir, "jobs.db"));
      try {
        db.prepare("UPDATE access_tokens SET expires_at = ? WHERE id = ?").run(
          "2000-01-01T00:00:00.000Z",
          expired.id,
        );
      } finally {
        db.close();
      }

      for (const secret of [revoked.secret, expired.secret]) {
        expect((await rpc(baseUrl, secret, "tools/list")).status).toBe(401);
        const getRes = await fetch(`${baseUrl}/mcp`, {
          headers: jsonHeaders(secret),
        });
        expect(getRes.status).toBe(401);
      }
    });

    it("initializes and lists the read tools with annotations", async () => {
      const { secret } = await createAccessToken(baseUrl, adminSession, "read");

      const init = await rpc(baseUrl, secret, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      });
      expect(init.status).toBe(200);
      expect(init.body.result.serverInfo.name).toBe("jobops");
      expect(init.body.result.capabilities.tools).toBeDefined();
      expect(init.body.result.instructions).toContain("list_jobs");

      const list = await rpc(baseUrl, secret, "tools/list");
      expect(list.status).toBe(200);
      const tools = list.body.result.tools as Array<{
        name: string;
        inputSchema: { type: string; properties?: Record<string, unknown> };
        annotations: Record<string, unknown>;
      }>;
      expect(tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(EXPECTED_TOOLS),
      );
      for (const tool of tools) {
        expect(tool.inputSchema.type).toBe("object");
        if (EXPECTED_TOOLS.includes(tool.name)) {
          expect(tool.annotations.readOnlyHint).toBe(true);
        }
      }
      const listJobs = tools.find((tool) => tool.name === "list_jobs");
      expect(Object.keys(listJobs?.inputSchema.properties ?? {})).toEqual(
        expect.arrayContaining([
          "statuses",
          "query",
          "minScore",
          "maxScore",
          "sources",
          "employer",
          "postedSince",
          "discoveredSince",
          "hasPdf",
          "targetCompany",
          "sort",
          "limit",
          "offset",
        ]),
      );
    });

    it("lists, filters, sorts and paginates jobs", async () => {
      const backendId = await importJob(
        baseUrl,
        adminSession,
        {
          title: "Backend Engineer",
          employer: "Gojek",
          location: "Jakarta",
          slug: "backend",
        },
        { suitabilityScore: 85 },
      );
      const mobileId = await importJob(
        baseUrl,
        adminSession,
        {
          title: "Mobile Engineer",
          employer: "Grab",
          location: "Jakarta",
          slug: "mobile",
        },
        { suitabilityScore: 60, status: "skipped" },
      );
      const dataId = await importJob(baseUrl, adminSession, {
        title: "Data Analyst 100%_match",
        employer: "Tokopedia",
        location: "Remote",
        slug: "data",
      });
      const { secret } = await createAccessToken(baseUrl, adminSession, "read");

      const all = await callTool(baseUrl, secret, "list_jobs", {
        sort: "score_desc",
      });
      expect(all.structuredContent.total).toBe(3);
      expect(
        all.structuredContent.jobs.map((job: { id: string }) => job.id),
      ).toEqual([backendId, mobileId, dataId]);
      const summary = all.structuredContent.jobs[0];
      expect(summary).toMatchObject({
        id: backendId,
        title: "Backend Engineer",
        employer: "Gojek",
        score: 85,
        hasPdf: false,
      });
      expect(summary).not.toHaveProperty("jobDescription");

      const page = await callTool(baseUrl, secret, "list_jobs", {
        sort: "score_desc",
        limit: 1,
        offset: 1,
      });
      expect(page.structuredContent).toMatchObject({
        total: 3,
        limit: 1,
        offset: 1,
        hasMore: true,
        nextOffset: 2,
      });
      expect(page.structuredContent.jobs[0].id).toBe(mobileId);

      const jakarta = await callTool(baseUrl, secret, "list_jobs", {
        query: "engineer jakarta",
        statuses: ["discovered"],
      });
      expect(
        jakarta.structuredContent.jobs.map((job: { id: string }) => job.id),
      ).toEqual([backendId]);

      const scored = await callTool(baseUrl, secret, "list_jobs", {
        minScore: 50,
        maxScore: 70,
      });
      expect(
        scored.structuredContent.jobs.map((job: { id: string }) => job.id),
      ).toEqual([mobileId]);

      // LIKE wildcards in the query are matched literally.
      const literal = await callTool(baseUrl, secret, "list_jobs", {
        query: "100%_",
      });
      expect(
        literal.structuredContent.jobs.map((job: { id: string }) => job.id),
      ).toEqual([dataId]);

      const byEmployer = await callTool(baseUrl, secret, "list_jobs", {
        employer: "toko",
        sources: ["manual"],
        hasPdf: false,
        discoveredSince: "2000-01-01",
      });
      expect(
        byEmployer.structuredContent.jobs.map((job: { id: string }) => job.id),
      ).toEqual([dataId]);

      const future = await callTool(baseUrl, secret, "list_jobs", {
        discoveredSince: "2999-01-01",
      });
      expect(future.structuredContent.total).toBe(0);

      const invalid = await callTool(baseUrl, secret, "list_jobs", {
        limit: 1000,
      });
      expect(invalid.isError).toBe(true);
      expect(invalid.structuredContent.error.code).toBe("INVALID_REQUEST");
      expect(invalid.structuredContent.error.message).toContain("limit");
    });

    it("flags target companies and filters by them with exact totals and pages", async () => {
      const gotoId = await importJob(
        baseUrl,
        adminSession,
        {
          title: "Backend Intern",
          employer: "PT GoTo Gojek Tokopedia Tbk",
          slug: "goto",
        },
        { suitabilityScore: 90 },
      );
      const grabId = await importJob(
        baseUrl,
        adminSession,
        { title: "Mobile Intern", employer: "GrabTaxi Holdings", slug: "grab" },
        { suitabilityScore: 80 },
      );
      const grabangoId = await importJob(
        baseUrl,
        adminSession,
        { title: "Retail Intern", employer: "Grabango", slug: "grabango" },
        { suitabilityScore: 70 },
      );
      const acmeId = await importJob(
        baseUrl,
        adminSession,
        { title: "Data Intern", employer: "Acme", slug: "acme" },
        { suitabilityScore: 60 },
      );
      const { secret } = await createAccessToken(baseUrl, adminSession, "read");
      const ids = (result: ToolCallResult) =>
        result.structuredContent.jobs.map((job: { id: string }) => job.id);
      const setTargets = async (targetCompanies: string[] | null) => {
        const res = await fetch(`${baseUrl}/api/settings`, {
          method: "PATCH",
          headers: jsonHeaders(adminSession),
          body: JSON.stringify({ targetCompanies }),
        });
        expect(res.status).toBe(200);
      };

      // No setting: every flag is false and the true filter matches nothing.
      const unset = await callTool(baseUrl, secret, "list_jobs", {});
      expect(
        unset.structuredContent.jobs.every(
          (job: { isTargetCompany: boolean }) => job.isTargetCompany === false,
        ),
      ).toBe(true);
      const noneYet = await callTool(baseUrl, secret, "list_jobs", {
        targetCompany: true,
      });
      expect(noneYet.structuredContent).toMatchObject({
        jobs: [],
        total: 0,
        hasMore: false,
      });

      await setTargets(["GoTo | Gojek", "Grab"]);

      const all = await callTool(baseUrl, secret, "list_jobs", {
        sort: "score_desc",
      });
      expect(
        Object.fromEntries(
          all.structuredContent.jobs.map(
            (job: { id: string; isTargetCompany: boolean }) => [
              job.id,
              job.isTargetCompany,
            ],
          ),
        ),
      ).toEqual({
        [gotoId]: true,
        [grabId]: true,
        [grabangoId]: false,
        [acmeId]: false,
      });

      const firstPage = await callTool(baseUrl, secret, "list_jobs", {
        targetCompany: true,
        sort: "score_desc",
        limit: 1,
      });
      expect(ids(firstPage)).toEqual([gotoId]);
      expect(firstPage.structuredContent).toMatchObject({
        total: 2,
        hasMore: true,
        nextOffset: 1,
      });
      const secondPage = await callTool(baseUrl, secret, "list_jobs", {
        targetCompany: true,
        sort: "score_desc",
        limit: 1,
        offset: 1,
      });
      expect(ids(secondPage)).toEqual([grabId]);
      expect(secondPage.structuredContent).toMatchObject({
        total: 2,
        hasMore: false,
        nextOffset: null,
      });

      const others = await callTool(baseUrl, secret, "list_jobs", {
        targetCompany: false,
        sort: "score_desc",
      });
      expect(ids(others)).toEqual([grabangoId, acmeId]);
      expect(others.structuredContent.total).toBe(2);

      const combined = await callTool(baseUrl, secret, "list_jobs", {
        targetCompany: true,
        minScore: 85,
      });
      expect(ids(combined)).toEqual([gotoId]);
      expect(combined.structuredContent.total).toBe(1);

      const detail = await callTool(baseUrl, secret, "get_job", {
        jobId: grabId,
        includeDescription: false,
      });
      expect(detail.structuredContent.job.isTargetCompany).toBe(true);

      // The flag is computed: clearing the setting takes effect at once.
      await setTargets(null);
      const cleared = await callTool(baseUrl, secret, "list_jobs", {
        targetCompany: false,
      });
      expect(cleared.structuredContent.total).toBe(4);
      const clearedDetail = await callTool(baseUrl, secret, "get_job", {
        jobId: grabId,
        includeDescription: false,
      });
      expect(clearedDetail.structuredContent.job.isTargetCompany).toBe(false);
    });

    it("keeps each user's target companies to themselves", async () => {
      const createUserRes = await fetch(`${baseUrl}/api/workspaces/users`, {
        method: "POST",
        headers: jsonHeaders(adminSession),
        body: JSON.stringify({
          username: "adam",
          displayName: "Adam",
          password: "adam-secret",
        }),
      });
      expect(createUserRes.status).toBe(201);
      const adamSession = await login(baseUrl, "adam", "adam-secret");

      const adminJobId = await importJob(baseUrl, adminSession, {
        title: "Platform Intern",
        employer: "Xendit",
        slug: "xendit-admin",
      });
      const adamJobId = await importJob(baseUrl, adamSession, {
        title: "Platform Intern",
        employer: "Xendit",
        slug: "xendit-adam",
      });

      // Adam is not an admin: target companies are allowed like search settings.
      const adamSettings = await fetch(`${baseUrl}/api/settings`, {
        method: "PATCH",
        headers: jsonHeaders(adamSession),
        body: JSON.stringify({ targetCompanies: ["Xendit"] }),
      });
      expect(adamSettings.status).toBe(200);

      const adamToken = await createAccessToken(baseUrl, adamSession, "read");
      const adminToken = await createAccessToken(baseUrl, adminSession, "read");

      const adamList = await callTool(baseUrl, adamToken.secret, "list_jobs", {
        targetCompany: true,
      });
      expect(
        adamList.structuredContent.jobs.map((job: { id: string }) => job.id),
      ).toEqual([adamJobId]);

      const adminList = await callTool(baseUrl, adminToken.secret, "list_jobs");
      expect(adminList.structuredContent.jobs).toEqual([
        expect.objectContaining({ id: adminJobId, isTargetCompany: false }),
      ]);
    });

    it("returns job details, counts, pipeline, profile and app status", async () => {
      const jobId = await importJob(
        baseUrl,
        adminSession,
        { title: "Platform Engineer", employer: "Shopee", slug: "platform" },
        { suitabilityScore: 77, suitabilityReason: "Strong Go match" },
      );
      const { secret } = await createAccessToken(baseUrl, adminSession, "read");

      const full = await callTool(baseUrl, secret, "get_job", { jobId });
      expect(full.structuredContent.job).toMatchObject({
        id: jobId,
        title: "Platform Engineer",
        suitabilityScore: 77,
        suitabilityReason: "Strong Go match",
        pdfFreshness: "missing",
      });
      const descriptionLength = full.structuredContent.descriptionLength;
      expect(full.structuredContent.job.jobDescription).toHaveLength(
        descriptionLength,
      );
      expect(full.structuredContent.descriptionTruncated).toBe(false);

      const truncated = await callTool(baseUrl, secret, "get_job", {
        jobId,
        descriptionMaxChars: 200,
      });
      expect(truncated.structuredContent.job.jobDescription).toHaveLength(200);
      expect(truncated.structuredContent.descriptionTruncated).toBe(true);
      expect(truncated.structuredContent.descriptionLength).toBe(
        descriptionLength,
      );

      const missing = await callTool(baseUrl, secret, "get_job", {
        jobId: "does-not-exist",
      });
      expect(missing.isError).toBe(true);
      expect(missing.structuredContent.error).toEqual({
        code: "NOT_FOUND",
        message: "Job not found",
      });

      const counts = await callTool(baseUrl, secret, "get_job_counts");
      expect(counts.structuredContent.total).toBe(1);
      expect(counts.structuredContent.byStatus.discovered).toBe(1);

      const pipeline = await callTool(baseUrl, secret, "get_pipeline_status");
      expect(pipeline.structuredContent).toMatchObject({
        isRunning: false,
        lastRun: null,
        recentRuns: [],
      });
      expect(pipeline.structuredContent.progress.step).toBe("idle");

      const profile = await callTool(baseUrl, secret, "get_profile");
      expect(profile.structuredContent).toMatchObject({
        configured: false,
        source: null,
      });

      const status = await callTool(baseUrl, secret, "get_app_status");
      expect(status.structuredContent).toMatchObject({
        app: { name: "JobOps", mode: "local", demoMode: false },
        caller: {
          username: "admin",
          authMethod: "access_token",
          scope: "read",
        },
        profile: { configured: false },
        pipeline: { isRunning: false },
        mcpUrl: `${baseUrl}/mcp`,
      });
    });

    it("never returns another user's jobs", async () => {
      const createUserRes = await fetch(`${baseUrl}/api/workspaces/users`, {
        method: "POST",
        headers: jsonHeaders(adminSession),
        body: JSON.stringify({
          username: "adam",
          displayName: "Adam",
          password: "adam-secret",
        }),
      });
      expect(createUserRes.status).toBe(201);
      const adamSession = await login(baseUrl, "adam", "adam-secret");

      const adminJobId = await importJob(baseUrl, adminSession, {
        title: "Admin Only Role",
        employer: "Acme",
        slug: "shared",
      });
      const adamJobId = await importJob(baseUrl, adamSession, {
        title: "Adam Only Role",
        employer: "Acme",
        slug: "shared",
      });
      const adminToken = await createAccessToken(baseUrl, adminSession, "read");
      const adamToken = await createAccessToken(baseUrl, adamSession, "read");

      const adamList = await callTool(baseUrl, adamToken.secret, "list_jobs", {
        query: "role",
      });
      expect(
        adamList.structuredContent.jobs.map((job: { id: string }) => job.id),
      ).toEqual([adamJobId]);
      expect(adamList.structuredContent.total).toBe(1);

      const crossRead = await callTool(baseUrl, adamToken.secret, "get_job", {
        jobId: adminJobId,
      });
      expect(crossRead.isError).toBe(true);
      expect(crossRead.structuredContent.error.code).toBe("NOT_FOUND");

      const adamCounts = await callTool(
        baseUrl,
        adamToken.secret,
        "get_job_counts",
      );
      expect(adamCounts.structuredContent.total).toBe(1);

      const adminList = await callTool(baseUrl, adminToken.secret, "list_jobs");
      expect(
        adminList.structuredContent.jobs.map((job: { id: string }) => job.id),
      ).toEqual([adminJobId]);

      const adamStatus = await callTool(
        baseUrl,
        adamToken.secret,
        "get_app_status",
      );
      expect(adamStatus.structuredContent.caller.username).toBe("adam");
    });

    it("rejects unknown tools as a protocol error", async () => {
      const { secret } = await createAccessToken(
        baseUrl,
        adminSession,
        "write",
      );
      const { status, body } = await rpc(baseUrl, secret, "tools/call", {
        name: "delete_everything",
        arguments: {},
      });
      expect(status).toBe(200);
      expect(body.error.message).toContain("Unknown tool");
    });
  });

  describe("host and origin validation", () => {
    beforeEach(async () => {
      ({ server, baseUrl, closeDb, tempDir } = await startServer({
        env: { JOBOPS_PUBLIC_BASE_URL: "https://jobs.example.com" },
      }));
    });

    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });

    it("accepts the public host and loopback", async () => {
      const viaLoopback = await rpc(baseUrl, undefined, "tools/list");
      expect(viaLoopback.status).toBe(200);

      const viaPublicHost = await rawRequest(baseUrl, {
        method: "POST",
        headers: { ...jsonHeaders(), Host: "jobs.example.com" },
        body,
      });
      expect(viaPublicHost.status).toBe(200);

      const withPublicOrigin = await rpc(
        baseUrl,
        undefined,
        "tools/list",
        {},
        {
          Origin: "https://jobs.example.com",
        },
      );
      expect(withPublicOrigin.status).toBe(200);
    });

    it("rejects other hosts and cross-site origins", async () => {
      const rebinding = await rawRequest(baseUrl, {
        method: "POST",
        headers: { ...jsonHeaders(), Host: "evil.example" },
        body,
      });
      expect(rebinding.status).toBe(403);

      const crossSite = await rpc(
        baseUrl,
        undefined,
        "tools/list",
        {},
        {
          Origin: "https://evil.example",
        },
      );
      expect(crossSite.status).toBe(403);
    });
  });

  describe("in demo mode", () => {
    beforeEach(async () => {
      ({ server, baseUrl, closeDb, tempDir } = await startServer({
        env: { DEMO_MODE: "true" },
      }));
    });

    it("is disabled", async () => {
      const res = await rpc(baseUrl, undefined, "tools/list");
      expect(res.status).toBe(503);
      expect(res.body.error.message).toContain("demo");
    });
  });
});
