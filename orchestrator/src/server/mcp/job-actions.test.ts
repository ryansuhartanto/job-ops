import Database from "bun:sqlite";
import {
  createServer,
  type Server as HttpServer,
  type Server,
} from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startServer, stopServer } from "../api/routes/test-utils";

const PUBLIC_TEST_IP = "93.184.215.14";
const jobSite = vi.hoisted(() => ({ port: 0 }));

// The posting fetch keeps all its checks; only DNS and the socket are
// replaced, so "jobs.example.test" (a public address) is served by a local
// test server and nothing leaves the machine.
vi.mock("@server/infra/public-http", async () => {
  const { request } = await import("node:http");
  const deps: import("@server/infra/public-http").PublicHttpDeps = {
    resolve: async (hostname) => {
      if (hostname === "jobs.example.test") {
        return [{ address: PUBLIC_TEST_IP, family: 4 }];
      }
      throw new Error(`ENOTFOUND ${hostname}`);
    },
    transport: ({ url, headers, signal }) =>
      new Promise((resolve, reject) => {
        const req = request(
          {
            host: "127.0.0.1",
            port: jobSite.port,
            path: `${url.pathname}${url.search}`,
            headers: { ...headers, Host: url.host },
            signal,
          },
          resolve,
        );
        req.on("error", reject);
        req.end();
      }),
  };
  return {
    // Loaded per call: startServer resets the module registry, and the real
    // module must share the app's AppError class.
    fetchPublicUrl: async (
      url: string,
      options: import("@server/infra/public-http").PublicHttpOptions,
    ) => {
      const actual = await vi.importActual<
        typeof import("@server/infra/public-http")
      >("@server/infra/public-http");
      return actual.fetchPublicUrl(url, options, deps);
    },
  };
});

const AUTH_ENV = {
  BASIC_AUTH_USER: "admin",
  BASIC_AUTH_PASSWORD: "secret",
  JWT_SECRET: "an-explicit-jwt-secret-with-at-least-32-chars",
  JOBOPS_TEST_AUTH_BYPASS: "0",
};

const READ_TOOLS = ["list_job_notes", "get_job_timeline", "get_job_pdf_link"];
const WRITE_TOOLS = [
  "rescore_job",
  "tailor_job",
  "generate_job_pdf",
  "process_job",
  "skip_job",
  "update_job",
  "delete_job",
  "bulk_job_action",
  "add_job_note",
  "update_job_note",
  "delete_job_note",
  "import_job",
  "mark_job_applied",
  "transition_job_stage",
  "set_job_outcome",
  "check_job_sponsor",
];
const DESTRUCTIVE_TOOLS = ["delete_job", "delete_job_note"];

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
  token: string,
  method: string,
  params?: Record<string, unknown>,
) {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: jsonHeaders(token),
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
  expect(JSON.parse(result.content[0]?.text ?? "null")).toEqual(
    result.structuredContent,
  );
  return result;
}

/** Calls a tool that must succeed and returns its structured content. */
async function callOk(
  baseUrl: string,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, any>> {
  const result = await callTool(baseUrl, token, name, args);
  expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(
    true,
  );
  return result.structuredContent;
}

/** Calls a tool that must fail and returns its error. */
async function callError(
  baseUrl: string,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ code: string; message: string; details?: any }> {
  const result = await callTool(baseUrl, token, name, args);
  expect(result.isError).toBe(true);
  return result.structuredContent.error;
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
): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/tokens`, {
    method: "POST",
    headers: jsonHeaders(session),
    body: JSON.stringify({ name: `${scope} agent`, scope }),
  });
  expect(res.status).toBe(201);
  return (await res.json()).data.secret as string;
}

/** Creates a discovered job through the REST import (no tailoring). */
async function createJob(
  baseUrl: string,
  session: string,
  job: { title: string; employer: string; slug: string },
): Promise<string> {
  const res = await fetch(`${baseUrl}/api/manual-jobs/import`, {
    method: "POST",
    headers: jsonHeaders(session),
    body: JSON.stringify({
      skipTailoring: true,
      job: {
        title: job.title,
        employer: job.employer,
        jobUrl: `https://example.com/jobs/${job.slug}`,
        jobDescription: `${job.title} at ${job.employer}. Go, Kubernetes.`,
      },
    }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.data.status).toBe("discovered");
  return body.data.id as string;
}

/** Sets raw job columns, for states the API cannot reach directly. */
function setJobColumns(
  tempDir: string,
  jobId: string,
  columns: Record<string, string | number>,
) {
  const db = new Database(join(tempDir, "jobs.db"));
  try {
    const assignments = Object.keys(columns)
      .map((column) => `${column} = ?`)
      .join(", ");
    db.prepare(`UPDATE jobs SET ${assignments} WHERE id = ?`).run(
      ...Object.values(columns),
      jobId,
    );
  } finally {
    db.close();
  }
}

async function waitFor(check: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Condition not met in time");
}

describe.sequential("MCP job action tools", () => {
  let server: Server;
  let baseUrl: string;
  let closeDb: () => void;
  let tempDir: string;
  let session: string;
  let writeToken: string;
  let readToken: string;

  beforeEach(async () => {
    ({ server, baseUrl, closeDb, tempDir } = await startServer({
      env: AUTH_ENV,
    }));
    session = await login(baseUrl, "admin", "secret");
    writeToken = await createAccessToken(baseUrl, session, "write");
    readToken = await createAccessToken(baseUrl, session, "read");
  });

  afterEach(async () => {
    await stopServer({ server, closeDb, tempDir });
  });

  it("lists the job tools with read-only and destructive annotations", async () => {
    const list = await rpc(baseUrl, readToken, "tools/list");
    expect(list.status).toBe(200);
    const tools = list.body.result.tools as Array<{
      name: string;
      inputSchema: { type: string; properties?: Record<string, unknown> };
      annotations: Record<string, unknown>;
    }>;
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    for (const name of READ_TOOLS) {
      expect(byName.get(name)?.annotations.readOnlyHint, name).toBe(true);
    }
    for (const name of WRITE_TOOLS) {
      const tool = byName.get(name);
      expect(tool?.inputSchema.type, name).toBe("object");
      expect(tool?.annotations.readOnlyHint, name).toBe(false);
      expect(tool?.annotations.destructiveHint, name).toBe(
        DESTRUCTIVE_TOOLS.includes(name),
      );
    }
    expect(byName.get("tailor_job")?.annotations.openWorldHint).toBe(true);
    expect(
      Object.keys(byName.get("update_job")?.inputSchema.properties ?? {}),
    ).toEqual(
      expect.arrayContaining([
        "jobId",
        "jobDescription",
        "status",
        "tailoredSummary",
        "tailoredSkills",
        "selectedProjectIds",
        "tracerLinksEnabled",
      ]),
    );
  });

  it("refuses every write tool for a read-scope token and other users' jobs", async () => {
    const jobId = await createJob(baseUrl, session, {
      title: "Backend Engineer",
      employer: "Gojek",
      slug: "scope",
    });

    for (const name of WRITE_TOOLS) {
      const error = await callError(baseUrl, readToken, name, { jobId });
      expect(error.code, name).toBe("FORBIDDEN");
      expect(error.message, name).toContain("write scope");
    }
    const unchanged = await callOk(baseUrl, readToken, "get_job", { jobId });
    expect(unchanged.job.status).toBe("discovered");

    // Read tools stay available to a read-scope token.
    await callOk(baseUrl, readToken, "list_job_notes", { jobId });
    await callOk(baseUrl, readToken, "get_job_timeline", { jobId });
    await callOk(baseUrl, readToken, "get_job_pdf_link", { jobId });

    const createUserRes = await fetch(`${baseUrl}/api/workspaces/users`, {
      method: "POST",
      headers: jsonHeaders(session),
      body: JSON.stringify({
        username: "adam",
        displayName: "Adam",
        password: "adam-secret",
      }),
    });
    expect(createUserRes.status).toBe(201);
    const adamSession = await login(baseUrl, "adam", "adam-secret");
    const adamToken = await createAccessToken(baseUrl, adamSession, "write");
    const adminNote = await callOk(baseUrl, writeToken, "add_job_note", {
      jobId,
      title: "Private",
      content: "Admin only",
    });
    const noteId = adminNote.note.id as string;
    const adamJobId = await createJob(baseUrl, adamSession, {
      title: "Adam Role",
      employer: "Acme",
      slug: "adam-own",
    });

    for (const [name, args] of [
      ["skip_job", { jobId }],
      ["delete_job", { jobId }],
      ["update_job", { jobId, tailoredSummary: "Overwritten" }],
      ["add_job_note", { jobId, title: "Hi", content: "Mine now" }],
      ["update_job_note", { jobId, noteId, title: "Mine now" }],
      ["delete_job_note", { jobId, noteId }],
      // Someone else's note through one's own job is not found either.
      ["update_job_note", { jobId: adamJobId, noteId, title: "Mine now" }],
      ["delete_job_note", { jobId: adamJobId, noteId }],
      ["mark_job_applied", { jobId }],
      ["transition_job_stage", { jobId, toStage: "offer" }],
      ["get_job_pdf_link", { jobId }],
    ] as const) {
      const error = await callError(baseUrl, adamToken, name, args);
      expect(error.code, name).toBe("NOT_FOUND");
    }
    const stillThere = await callOk(baseUrl, writeToken, "get_job", { jobId });
    expect(stillThere.job.status).toBe("discovered");
    expect(stillThere.job.tailoredSummary ?? null).toBeNull();
    const adminNotes = await callOk(baseUrl, writeToken, "list_job_notes", {
      jobId,
    });
    expect(adminNotes.notes).toMatchObject([
      { id: noteId, title: "Private", content: "Admin only" },
    ]);
    const timeline = await callOk(baseUrl, writeToken, "get_job_timeline", {
      jobId,
    });
    expect(timeline.events).toEqual([]);
  });

  it("rescores, tailors, renders and processes jobs", async () => {
    const pipeline = await import("@server/pipeline/index");
    const { scoreJobSuitability } = await import("@server/services/scorer");
    const jobsRepo = await import("@server/repositories/jobs");
    const jobId = await createJob(baseUrl, session, {
      title: "Platform Engineer",
      employer: "Traveloka",
      slug: "tailor",
    });

    vi.mocked(scoreJobSuitability).mockResolvedValue({
      score: 91,
      reason: "Strong Go and Kubernetes match",
      jobBrief: null,
    });
    const rescored = await callOk(baseUrl, writeToken, "rescore_job", {
      jobId,
    });
    expect(rescored).toMatchObject({
      score: 91,
      reason: "Strong Go and Kubernetes match",
      job: { id: jobId, score: 91, status: "discovered" },
    });
    expect(
      (await callError(baseUrl, writeToken, "rescore_job", { jobId: "nope" }))
        .code,
    ).toBe("NOT_FOUND");

    vi.mocked(pipeline.summarizeJob).mockImplementation(async (id) => {
      await jobsRepo.updateJob(id, {
        tailoredHeadline: "Platform engineer for travel at scale",
        tailoredSummary: "Builds Go services on Kubernetes.",
        tailoredSkills: JSON.stringify([
          { name: "Backend", keywords: ["Go", "gRPC"] },
        ]),
        selectedProjectIds: "proj-1,proj-2",
      });
      return { success: true };
    });
    const tailored = await callOk(baseUrl, writeToken, "tailor_job", {
      jobId,
      fields: ["summary", "headline"],
      force: true,
    });
    expect(vi.mocked(pipeline.summarizeJob)).toHaveBeenCalledWith(jobId, {
      force: true,
      fields: ["summary", "headline"],
    });
    expect(tailored.tailoring).toEqual({
      headline: "Platform engineer for travel at scale",
      summary: "Builds Go services on Kubernetes.",
      skills: [{ name: "Backend", keywords: ["Go", "gRPC"] }],
      selectedProjectIds: ["proj-1", "proj-2"],
    });
    expect(tailored.job).toMatchObject({ id: jobId, pdfFreshness: "missing" });

    vi.mocked(pipeline.summarizeJob).mockResolvedValueOnce({
      success: false,
      error: "LLM is not configured",
    });
    const tailorFailure = await callError(baseUrl, writeToken, "tailor_job", {
      jobId,
    });
    expect(tailorFailure).toEqual({
      code: "INVALID_REQUEST",
      message: "LLM is not configured",
    });

    const rendered = await callOk(baseUrl, writeToken, "generate_job_pdf", {
      jobId,
    });
    expect(vi.mocked(pipeline.generateFinalPdf)).toHaveBeenCalledWith(jobId, {
      requestOrigin: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
      analyticsOrigin: "generate_pdf",
    });
    expect(rendered.job.id).toBe(jobId);
    expect(rendered.pdfUrl).toBe(`${baseUrl}/api/jobs/${jobId}/pdf`);

    vi.mocked(pipeline.generateFinalPdf).mockResolvedValueOnce({
      success: false,
      error: "PDF generation failed: renderer unavailable",
      errorCode: "UPSTREAM_ERROR",
    });
    expect(
      await callError(baseUrl, writeToken, "generate_job_pdf", { jobId }),
    ).toEqual({
      code: "UPSTREAM_ERROR",
      message: "PDF generation failed: renderer unavailable",
    });

    // Busy jobs are refused with a conflict instead of racing the running work.
    setJobColumns(tempDir, jobId, { pdf_regenerating: 1 });
    const regenerating = await callError(
      baseUrl,
      writeToken,
      "generate_job_pdf",
      { jobId },
    );
    expect(regenerating.code).toBe("CONFLICT");
    expect(regenerating.message).toContain("being generated");
    setJobColumns(tempDir, jobId, {
      pdf_regenerating: 0,
      status: "processing",
    });
    for (const name of ["tailor_job", "process_job", "rescore_job"]) {
      const busy = await callError(baseUrl, writeToken, name, { jobId });
      expect(busy.code, name).toBe("CONFLICT");
      expect(busy.message, name).toContain("being processed");
    }
    setJobColumns(tempDir, jobId, { status: "discovered" });

    // A failed pipeline step reaches the agent with its real message.
    vi.mocked(pipeline.processJob).mockResolvedValueOnce({
      success: false,
      error: "LLM is not configured. Set a model in Settings.",
    });
    expect(
      await callError(baseUrl, writeToken, "process_job", { jobId }),
    ).toEqual({
      code: "UPSTREAM_ERROR",
      message: "LLM is not configured. Set a model in Settings.",
    });
    vi.mocked(pipeline.processJob).mockResolvedValueOnce({
      success: false,
      error: "PDF regeneration is already in progress for this job.",
      errorCode: "CONFLICT",
    });
    expect(
      (await callError(baseUrl, writeToken, "process_job", { jobId })).code,
    ).toBe("CONFLICT");
    // Long upstream text is cut before it reaches the agent.
    vi.mocked(pipeline.generateFinalPdf).mockResolvedValueOnce({
      success: false,
      error: `Renderer said: ${"x".repeat(5000)}`,
      errorCode: "UPSTREAM_ERROR",
    });
    const longError = await callError(baseUrl, writeToken, "generate_job_pdf", {
      jobId,
    });
    expect(longError.message).toHaveLength(500);
    expect(longError.message.startsWith("Renderer said: xxx")).toBe(true);
    expect(longError.message.endsWith("…")).toBe(true);

    vi.mocked(pipeline.processJob).mockClear();
    const processed = await callOk(baseUrl, writeToken, "process_job", {
      jobId,
    });
    expect(vi.mocked(pipeline.processJob)).toHaveBeenCalledWith(jobId, {
      force: false,
      requestOrigin: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
      analyticsOrigin: "move_to_ready",
    });
    expect(processed.job.id).toBe(jobId);

    setJobColumns(tempDir, jobId, { status: "skipped" });
    const wrongState = await callError(baseUrl, writeToken, "process_job", {
      jobId,
    });
    expect(wrongState.code).toBe("INVALID_REQUEST");
    expect(wrongState.message).toContain('from status "skipped"');
  });

  it("skips, edits, deletes and bulk-acts on jobs", async () => {
    const { scoreJobSuitability } = await import("@server/services/scorer");
    const first = await createJob(baseUrl, session, {
      title: "Backend Engineer",
      employer: "Gojek",
      slug: "first",
    });
    const second = await createJob(baseUrl, session, {
      title: "SRE",
      employer: "Shopee",
      slug: "second",
    });
    const third = await createJob(baseUrl, session, {
      title: "Data Engineer",
      employer: "Grab",
      slug: "third",
    });

    const skipped = await callOk(baseUrl, writeToken, "skip_job", {
      jobId: first,
    });
    expect(skipped.job).toMatchObject({ id: first, status: "skipped" });
    const skipAgain = await callError(baseUrl, writeToken, "skip_job", {
      jobId: first,
    });
    expect(skipAgain.code).toBe("INVALID_REQUEST");
    expect(skipAgain.message).toContain("not skippable");

    const updated = await callOk(baseUrl, writeToken, "update_job", {
      jobId: second,
      tailoredHeadline: "Reliability engineer",
      tailoredSkills: [{ name: "Ops", keywords: ["Kubernetes", "Terraform"] }],
      selectedProjectIds: ["proj-a", "proj-b"],
      jobDescription: "Updated description",
      status: "ready",
    });
    expect(updated.job).toMatchObject({ id: second, status: "ready" });
    expect(updated.updatedFields).toEqual(
      expect.arrayContaining([
        "tailoredHeadline",
        "tailoredSkills",
        "selectedProjectIds",
        "jobDescription",
        "status",
      ]),
    );
    const detail = await callOk(baseUrl, readToken, "get_job", {
      jobId: second,
    });
    expect(detail.job).toMatchObject({
      tailoredHeadline: "Reliability engineer",
      tailoredSkills: JSON.stringify([
        { name: "Ops", keywords: ["Kubernetes", "Terraform"] },
      ]),
      selectedProjectIds: "proj-a,proj-b",
      jobDescription: "Updated description",
    });

    const emptyUpdate = await callError(baseUrl, writeToken, "update_job", {
      jobId: second,
    });
    expect(emptyUpdate.code).toBe("INVALID_REQUEST");
    const invalidUrl = await callError(baseUrl, writeToken, "update_job", {
      jobId: second,
      jobUrl: "not a url",
    });
    expect(invalidUrl.code).toBe("INVALID_REQUEST");
    expect(
      (
        await callError(baseUrl, writeToken, "update_job", {
          jobId: "missing",
          tailoredSummary: "x",
        })
      ).code,
    ).toBe("NOT_FOUND");
    const urlTaken = await callError(baseUrl, writeToken, "update_job", {
      jobId: second,
      jobUrl: "https://example.com/jobs/first",
    });
    expect(urlTaken).toEqual({
      code: "CONFLICT",
      message: "Another job already uses that job URL",
    });
    // Tracer links need a public URL; a loopback instance is refused.
    const tracer = await callError(baseUrl, writeToken, "update_job", {
      jobId: second,
      tracerLinksEnabled: true,
    });
    expect(tracer.code).toBe("CONFLICT");

    vi.mocked(scoreJobSuitability).mockResolvedValue({
      score: 64,
      reason: "Partial match",
      jobBrief: null,
    });
    const bulkSkip = await callOk(baseUrl, writeToken, "bulk_job_action", {
      action: "skip",
      jobIds: [third, first, "missing", third],
    });
    expect(bulkSkip).toMatchObject({
      action: "skip",
      requested: 3,
      succeeded: 1,
      failed: 2,
    });
    const byId = new Map(
      bulkSkip.results.map((result: { jobId: string }) => [
        result.jobId,
        result,
      ]),
    );
    expect(byId.get(third)).toMatchObject({
      ok: true,
      job: { id: third, status: "skipped" },
    });
    expect(byId.get(first)).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });
    expect(byId.get("missing")).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND", message: "Job not found" },
    });
    expect(byId.get(third)).not.toHaveProperty("job.jobDescription");

    const bulkRescore = await callOk(baseUrl, writeToken, "bulk_job_action", {
      action: "rescore",
      jobIds: [second],
    });
    expect(bulkRescore.results[0]).toMatchObject({
      ok: true,
      job: { id: second, score: 64 },
    });
    const tooMany = await callError(baseUrl, writeToken, "bulk_job_action", {
      action: "skip",
      jobIds: Array.from({ length: 101 }, (_, index) => `job-${index}`),
    });
    expect(tooMany.code).toBe("INVALID_REQUEST");

    setJobColumns(tempDir, second, { status: "processing" });
    const busyDelete = await callError(baseUrl, writeToken, "delete_job", {
      jobId: second,
    });
    expect(busyDelete.code).toBe("CONFLICT");
    setJobColumns(tempDir, second, { status: "ready" });

    expect(
      await callOk(baseUrl, writeToken, "delete_job", { jobId: second }),
    ).toEqual({ deleted: true, jobId: second });
    expect(
      (await callError(baseUrl, readToken, "get_job", { jobId: second })).code,
    ).toBe("NOT_FOUND");
    expect(
      (await callError(baseUrl, writeToken, "delete_job", { jobId: second }))
        .code,
    ).toBe("NOT_FOUND");
  });

  it("manages job notes", async () => {
    const jobId = await createJob(baseUrl, session, {
      title: "Backend Engineer",
      employer: "Tokopedia",
      slug: "notes",
    });

    const added = await callOk(baseUrl, writeToken, "add_job_note", {
      jobId,
      title: "Recruiter",
      content: "Rina from talent team",
    });
    expect(added.note).toMatchObject({
      jobId,
      title: "Recruiter",
      content: "Rina from talent team",
    });
    const noteId = added.note.id as string;
    await callOk(baseUrl, writeToken, "add_job_note", {
      jobId,
      title: "Prep",
      content: "System design: payments",
    });

    const listed = await callOk(baseUrl, readToken, "list_job_notes", {
      jobId,
      limit: 1,
    });
    expect(listed).toMatchObject({ total: 2, hasMore: true, nextOffset: 1 });
    expect(listed.notes).toHaveLength(1);

    const edited = await callOk(baseUrl, writeToken, "update_job_note", {
      jobId,
      noteId,
      content: "Rina, prefers WhatsApp",
    });
    expect(edited.note).toMatchObject({
      id: noteId,
      title: "Recruiter",
      content: "Rina, prefers WhatsApp",
    });

    const tooLong = await callError(baseUrl, writeToken, "add_job_note", {
      jobId,
      title: "x".repeat(121),
      content: "body",
    });
    expect(tooLong.code).toBe("INVALID_REQUEST");
    expect(tooLong.message).toContain("title");
    expect(
      (
        await callError(baseUrl, writeToken, "update_job_note", {
          jobId,
          noteId: "missing",
          title: "New",
        })
      ).code,
    ).toBe("NOT_FOUND");
    expect(
      (
        await callError(baseUrl, writeToken, "add_job_note", {
          jobId: "missing",
          title: "New",
          content: "Body",
        })
      ).code,
    ).toBe("NOT_FOUND");

    expect(
      await callOk(baseUrl, writeToken, "delete_job_note", { jobId, noteId }),
    ).toEqual({ deleted: true, jobId, noteId });
    expect(
      (
        await callError(baseUrl, writeToken, "delete_job_note", {
          jobId,
          noteId,
        })
      ).code,
    ).toBe("NOT_FOUND");
    const remaining = await callOk(baseUrl, readToken, "list_job_notes", {
      jobId,
    });
    expect(remaining.total).toBe(1);

    const longContent = "Interview prep. ".repeat(100);
    const long = await callOk(baseUrl, writeToken, "add_job_note", {
      jobId,
      title: "Long",
      content: longContent,
    });
    const previews = await callOk(baseUrl, readToken, "list_job_notes", {
      jobId,
    });
    const preview = previews.notes.find(
      (note: { id: string }) => note.id === long.note.id,
    );
    expect(preview).toMatchObject({
      contentLength: longContent.trim().length,
      contentTruncated: true,
    });
    expect(preview.content).toHaveLength(500);
    const shortPreview = previews.notes.find(
      (note: { id: string }) => note.id !== long.note.id,
    );
    expect(shortPreview.contentTruncated).toBe(false);
    const full = await callOk(baseUrl, readToken, "list_job_notes", {
      jobId,
      fullContent: true,
    });
    expect(
      full.notes.find((note: { id: string }) => note.id === long.note.id)
        .content,
    ).toBe(longContent.trim());
  });

  it("imports jobs from a fetched URL or pasted text", async () => {
    const { inferManualJobDetails } = await import(
      "@server/services/manualJob"
    );
    const pipeline = await import("@server/pipeline/index");
    const { scoreJobSuitability } = await import("@server/services/scorer");
    vi.mocked(inferManualJobDetails).mockResolvedValue({
      job: {
        title: "Platform Engineer",
        employer: "Traveloka",
        location: "Jakarta",
        jobUrl: "",
        applicationLink: "not a link",
      },
      warning: null,
    });

    // A local server stands in for jobs.example.test (see the mock above).
    const siteServer: HttpServer = createServer((req, res) => {
      if (req.url === "/moved") {
        res.writeHead(302, { Location: "http://192.168.1.20/admin" });
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        "<html><head><title>Platform Engineer - Traveloka</title></head><body><nav>Menu</nav><main>Build Go services for flights.</main></body></html>",
      );
    });
    await new Promise<void>((resolve) =>
      siteServer.listen(0, "127.0.0.1", resolve),
    );
    const address = siteServer.address();
    jobSite.port = typeof address === "object" && address ? address.port : 0;
    const postingUrl = "http://jobs.example.test/careers/42";

    try {
      vi.mocked(pipeline.processJob).mockClear();
      const fromUrl = await callOk(baseUrl, writeToken, "import_job", {
        url: postingUrl,
        process: false,
      });
      expect(fromUrl.job).toMatchObject({
        title: "Platform Engineer",
        employer: "Traveloka",
        location: "Jakarta",
        status: "discovered",
        source: "manual",
        jobUrl: postingUrl,
      });
      expect(fromUrl.next).toContain("rescore_job");
      expect(vi.mocked(pipeline.processJob)).not.toHaveBeenCalled();
      const inferredFrom = vi.mocked(inferManualJobDetails).mock.calls[0]?.[0];
      expect(inferredFrom).toContain(
        "Page Title: Platform Engineer - Traveloka",
      );
      expect(inferredFrom).toContain("Build Go services for flights.");
      expect(inferredFrom).not.toContain("Menu");

      // The server's own network is off limits, directly or by redirect.
      for (const url of [
        `http://127.0.0.1:${jobSite.port}/careers/42`,
        "http://[::1]/careers/42",
        "http://169.254.169.254/latest/meta-data/",
        "http://jobs.example.test/moved",
      ]) {
        const refused = await callError(baseUrl, writeToken, "import_job", {
          url,
        });
        expect(refused.code, url).toBe("UNPROCESSABLE_ENTITY");
        expect(refused.message, url).toContain("private");
      }
      const scheme = await callError(baseUrl, writeToken, "import_job", {
        url: "ftp://jobs.example.test/posting",
      });
      expect(scheme.code).toBe("UNPROCESSABLE_ENTITY");
    } finally {
      await new Promise<void>((resolve) => siteServer.close(() => resolve()));
    }

    const noUrl = await callError(baseUrl, writeToken, "import_job", {
      description: "Senior Backend Engineer at Xendit. Remote.",
    });
    expect(noUrl.code).toBe("INVALID_REQUEST");
    expect(noUrl.details.missing).toEqual(["jobUrl"]);

    vi.mocked(scoreJobSuitability).mockResolvedValue({
      score: 82,
      reason: "Good fit",
      jobBrief: null,
    });
    const processed = await callOk(baseUrl, writeToken, "import_job", {
      description: "Senior Backend Engineer at Xendit. Remote.",
      jobUrl: "https://example.com/jobs/xendit-backend",
      title: "Senior Backend Engineer",
      employer: "Xendit",
      process: true,
    });
    expect(processed.job).toMatchObject({
      title: "Senior Backend Engineer",
      employer: "Xendit",
      status: "processing",
    });
    expect(vi.mocked(pipeline.processJob)).toHaveBeenCalledWith(
      processed.job.id,
      { analyticsOrigin: "manual_job_create" },
    );
    await waitFor(async () => {
      const current = await callOk(baseUrl, readToken, "get_job", {
        jobId: processed.job.id,
        includeDescription: false,
      });
      return current.job.status === "ready";
    });

    const blocked = await callError(baseUrl, writeToken, "import_job", {
      url: "https://www.linkedin.com/jobs/view/123",
    });
    expect(blocked.code).toBe("UNPROCESSABLE_ENTITY");
    expect(blocked.message).toContain("LinkedIn");
    expect((await callError(baseUrl, writeToken, "import_job", {})).code).toBe(
      "INVALID_REQUEST",
    );
  });

  it("tracks applications through stages, outcomes and the timeline", async () => {
    const jobId = await createJob(baseUrl, session, {
      title: "Backend Engineer",
      employer: "Bukalapak",
      slug: "apply",
    });

    const applied = await callOk(baseUrl, writeToken, "mark_job_applied", {
      jobId,
    });
    expect(applied.job).toMatchObject({ id: jobId, status: "applied" });
    expect(applied.job.appliedAt).toEqual(expect.any(String));
    const again = await callError(baseUrl, writeToken, "mark_job_applied", {
      jobId,
    });
    expect(again.code).toBe("CONFLICT");
    expect(
      (await callError(baseUrl, writeToken, "mark_job_applied", { jobId: "x" }))
        .code,
    ).toBe("NOT_FOUND");

    const screen = await callOk(baseUrl, writeToken, "transition_job_stage", {
      jobId,
      toStage: "recruiter_screen",
      occurredAt: "2099-01-05T09:00:00Z",
      eventLabel: "Call with Rina",
    });
    expect(screen.event).toMatchObject({
      fromStage: "applied",
      toStage: "recruiter_screen",
      title: "Call with Rina",
      occurredAt: Math.floor(Date.parse("2099-01-05T09:00:00Z") / 1000),
    });
    expect(screen.job.status).toBe("in_progress");

    await callOk(baseUrl, writeToken, "transition_job_stage", {
      jobId,
      toStage: "no_change",
      eventType: "note",
      note: "Asked about salary band",
    });
    const badStage = await callError(
      baseUrl,
      writeToken,
      "transition_job_stage",
      { jobId, toStage: "hired" },
    );
    expect(badStage.code).toBe("INVALID_REQUEST");
    expect(
      (
        await callError(baseUrl, writeToken, "transition_job_stage", {
          jobId: "missing",
          toStage: "offer",
        })
      ).code,
    ).toBe("NOT_FOUND");

    const rejected = await callOk(baseUrl, writeToken, "set_job_outcome", {
      jobId,
      outcome: "rejected",
    });
    expect(rejected.job.outcome).toBe("rejected");
    expect(rejected.closedAt).toEqual(expect.any(Number));
    const reopened = await callOk(baseUrl, writeToken, "set_job_outcome", {
      jobId,
      outcome: null,
    });
    expect(reopened.job.outcome).toBeNull();
    expect(reopened.closedAt).toBeNull();
    expect(
      (
        await callError(baseUrl, writeToken, "set_job_outcome", {
          jobId: "missing",
          outcome: "ghosted",
        })
      ).code,
    ).toBe("NOT_FOUND");

    const timeline = await callOk(baseUrl, readToken, "get_job_timeline", {
      jobId,
    });
    expect(
      timeline.events.map((event: { toStage: string }) => event.toStage).sort(),
    ).toEqual(["applied", "recruiter_screen", "recruiter_screen"]);
    expect(
      timeline.events.some(
        (event: { metadata: { note?: string } | null }) =>
          event.metadata?.note === "Asked about salary band",
      ),
    ).toBe(true);
    expect(timeline).toMatchObject({
      total: 3,
      hasMore: false,
      tasks: [],
      tasksTotal: 0,
      tasksTruncated: false,
    });
    const firstEvent = await callOk(baseUrl, readToken, "get_job_timeline", {
      jobId,
      limit: 1,
    });
    expect(firstEvent.events).toHaveLength(1);
    expect(firstEvent).toMatchObject({
      total: 3,
      hasMore: true,
      nextOffset: 1,
    });
    expect(timeline.job).toMatchObject({ id: jobId, status: "in_progress" });
    expect(
      (await callError(baseUrl, readToken, "get_job_timeline", { jobId: "x" }))
        .code,
    ).toBe("NOT_FOUND");
  });

  it("checks sponsors and links PDFs that work with the token", async () => {
    const { searchSponsors } = await import(
      "@server/services/visa-sponsors/index"
    );
    const jobId = await createJob(baseUrl, session, {
      title: "Backend Engineer",
      employer: "Gojek",
      slug: "pdf",
    });

    vi.mocked(searchSponsors).mockResolvedValue([
      { sponsor: { organisationName: "Gojek Ltd" }, score: 92 },
    ] as never);
    const sponsor = await callOk(baseUrl, writeToken, "check_job_sponsor", {
      jobId,
    });
    expect(sponsor).toMatchObject({
      sponsorMatchScore: 92,
      sponsorMatchNames: ["Gojek Ltd"],
      matchResults: [{ name: "Gojek Ltd", score: 92 }],
      job: { id: jobId, sponsorMatchScore: 92 },
    });
    expect(
      (
        await callError(baseUrl, writeToken, "check_job_sponsor", {
          jobId: "x",
        })
      ).code,
    ).toBe("NOT_FOUND");

    const before = await callOk(baseUrl, readToken, "get_job_pdf_link", {
      jobId,
    });
    expect(before).toMatchObject({
      hasPdf: false,
      url: null,
      pdfFreshness: "missing",
    });

    const upload = await fetch(`${baseUrl}/api/jobs/${jobId}/pdf`, {
      method: "POST",
      headers: jsonHeaders(session),
      body: JSON.stringify({
        fileName: "resume.pdf",
        mediaType: "application/pdf",
        dataBase64: Buffer.from("%PDF-1.7\nAgent resume\n").toString("base64"),
      }),
    });
    expect(upload.status).toBe(201);

    const link = await callOk(baseUrl, readToken, "get_job_pdf_link", {
      jobId,
    });
    expect(link).toMatchObject({
      hasPdf: true,
      url: `${baseUrl}/api/jobs/${jobId}/pdf`,
      pdfFreshness: "uploaded",
      pdfSource: "uploaded",
      pdfRegenerating: false,
    });

    const download = await fetch(link.url, {
      headers: { Authorization: `Bearer ${readToken}` },
    });
    expect(download.status).toBe(200);
    expect(await download.text()).toContain("Agent resume");
    expect((await fetch(link.url)).status).toBe(401);
    // A read-scope token may only read through the REST API.
    const readTokenWrite = await fetch(link.url, {
      method: "POST",
      headers: jsonHeaders(readToken),
      body: JSON.stringify({}),
    });
    expect(readTokenWrite.status).toBe(403);
  });
});
