import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";

describe.sequential("database migrations", () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("boots when an older pipeline_runs table lacks config_snapshot", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "job-ops-migrate-"));
    const script = `
      import { join } from "node:path";
      import { pathToFileURL } from "node:url";
      import Database from "bun:sqlite";

      const dbPath = join(process.env.DATA_DIR, "jobs.db");
      const sqlite = new Database(dbPath);
      sqlite.exec(\`
        CREATE TABLE pipeline_runs (
          id TEXT PRIMARY KEY,
          started_at TEXT NOT NULL DEFAULT (datetime('now')),
          completed_at TEXT,
          status TEXT NOT NULL DEFAULT 'running',
          jobs_discovered INTEGER NOT NULL DEFAULT 0,
          jobs_processed INTEGER NOT NULL DEFAULT 0,
          error_message TEXT
        );
      \`);
      sqlite.close();

      await import(pathToFileURL(join(process.cwd(), "src/server/db/migrate.ts")).href);

      const migratedDb = new Database(dbPath, { readonly: true });
      const columns = migratedDb.prepare("PRAGMA table_info(pipeline_runs)").all();
      if (!columns.some((column) => column.name === "config_snapshot")) {
        throw new Error("config_snapshot column missing after migration");
      }
      migratedDb.close();
    `;

    execFileSync(
      process.execPath,
      ["-e", script],
      {
        env: {
          ...process.env,
          DATA_DIR: tempDir,
        },
        stdio: "pipe",
      },
    );
  });

  it("creates tenant foreign keys for tenant-scoped core tables", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "job-ops-migrate-"));
    const script = `
      import { join } from "node:path";
      import { pathToFileURL } from "node:url";
      import Database from "bun:sqlite";

      const dbPath = join(process.env.DATA_DIR, "jobs.db");
      await import(pathToFileURL(join(process.cwd(), "src/server/db/migrate.ts")).href);

      const migratedDb = new Database(dbPath, { readonly: true });

      function hasTenantCascade(tableName) {
        const fks = migratedDb.prepare(\`PRAGMA foreign_key_list(\${tableName})\`).all();
        return fks.some((fk) => fk.from === "tenant_id" && fk.table === "tenants" && String(fk.on_delete).toUpperCase() === "CASCADE");
      }

      const requiredTables = ["jobs", "pipeline_runs", "settings"];
      for (const tableName of requiredTables) {
        if (!hasTenantCascade(tableName)) {
          throw new Error(\`\${tableName} is missing tenant_id -> tenants(id) ON DELETE CASCADE\`);
        }
      }

      migratedDb.close();
    `;

    execFileSync(
      process.execPath,
      ["-e", script],
      {
        env: {
          ...process.env,
          DATA_DIR: tempDir,
        },
        stdio: "pipe",
      },
    );
  });

  it("marks only existing workspaces for legacy onboarding migration", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "job-ops-migrate-"));
    const script = `
      import { join } from "node:path";
      import { pathToFileURL } from "node:url";
      import Database from "bun:sqlite";

      const dbPath = join(process.env.DATA_DIR, "jobs.db");
      const sqlite = new Database(dbPath);
      sqlite.exec(\`
        CREATE TABLE settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO settings(key, value) VALUES ('llmProvider', 'openrouter');
      \`);
      sqlite.close();

      await import(pathToFileURL(join(process.cwd(), "src/server/db/migrate.ts")).href);

      const migratedDb = new Database(dbPath, { readonly: true });
      const pending = migratedDb.prepare(
        "SELECT value FROM settings WHERE key = 'onboardingLegacyMigrationPending'",
      ).get();
      if (pending?.value !== "1") {
        throw new Error("Existing workspace was not marked for onboarding migration");
      }
      migratedDb.close();
    `;

    execFileSync(
      process.execPath,
      ["-e", script],
      {
        env: { ...process.env, DATA_DIR: tempDir },
        stdio: "pipe",
      },
    );
  });

  it("creates hosted usage tables with user-scoped foreign keys and indexes", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "job-ops-migrate-"));
    const script = `
      import { join } from "node:path";
      import { pathToFileURL } from "node:url";
      import Database from "bun:sqlite";

      const dbPath = join(process.env.DATA_DIR, "jobs.db");
      await import(pathToFileURL(join(process.cwd(), "src/server/db/migrate.ts")).href);

      const migratedDb = new Database(dbPath, { readonly: true });

      function tableExists(tableName) {
        return Boolean(
          migratedDb
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
            .get(tableName),
        );
      }

      for (const tableName of ["account_subscriptions", "hosted_usage_counters", "hosted_usage_reservations"]) {
        if (!tableExists(tableName)) {
          throw new Error(\`\${tableName} was not created\`);
        }
        const fks = migratedDb.prepare(\`PRAGMA foreign_key_list(\${tableName})\`).all();
        const hasTenantCascade = fks.some((fk) => fk.from === "tenant_id" && fk.table === "tenants" && String(fk.on_delete).toUpperCase() === "CASCADE");
        const hasUserCascade = fks.some((fk) => fk.from === "user_id" && fk.table === "users" && String(fk.on_delete).toUpperCase() === "CASCADE");
        if (!hasTenantCascade || !hasUserCascade) {
          throw new Error(\`\${tableName} is missing hosted usage foreign keys\`);
        }
      }

      const counterIndexes = migratedDb.prepare("PRAGMA index_list(hosted_usage_counters)").all();
      const counterUnique = counterIndexes.find((index) => index.name === "idx_hosted_usage_counters_tenant_user_period_action_unique");
      if (!counterUnique || !counterUnique.unique) {
        throw new Error("hosted usage counter unique index missing");
      }

      const reservationIndexes = migratedDb.prepare("PRAGMA index_list(hosted_usage_reservations)").all();
      const reservationUnique = reservationIndexes.find((index) => index.name === "idx_hosted_usage_reservations_idempotency_unique");
      if (!reservationUnique || !reservationUnique.unique) {
        throw new Error("hosted usage reservation idempotency unique index missing");
      }

      migratedDb.close();
    `;

    execFileSync(
      process.execPath,
      ["-e", script],
      {
        env: {
          ...process.env,
          DATA_DIR: tempDir,
        },
        stdio: "pipe",
      },
    );
  });

  it("backfills legacy PDF rows as generated", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "job-ops-migrate-"));
    const script = `
      import { join } from "node:path";
      import { pathToFileURL } from "node:url";
      import Database from "bun:sqlite";

      const dbPath = join(process.env.DATA_DIR, "jobs.db");
      // Bun ignores the query on file:// URLs, so a plain path is needed to run the module again.
      const migrationPath = join(process.cwd(), "src/server/db/migrate.ts");
      await import(\`\${migrationPath}?run=initial\`);

      const sqlite = new Database(dbPath);
      sqlite.prepare("INSERT INTO jobs(id, title, employer, job_url, pdf_path, pdf_source) VALUES (?, ?, ?, ?, ?, NULL)").run(
        "legacy-pdf-job",
        "Legacy PDF Job",
        "Acme",
        "https://example.com/legacy-pdf-job",
        "data/pdfs/resume_legacy-pdf-job.pdf",
      );
      sqlite.close();

      await import(\`\${migrationPath}?run=backfill\`);

      const migratedDb = new Database(dbPath, { readonly: true });
      const row = migratedDb.prepare("SELECT pdf_source FROM jobs WHERE id = ?").get("legacy-pdf-job");
      if (row?.pdf_source !== "generated") {
        throw new Error(\`Expected legacy PDF source to be generated, got \${row?.pdf_source}\`);
      }
      migratedDb.close();
    `;

    execFileSync(
      process.execPath,
      ["-e", script],
      {
        env: {
          ...process.env,
          DATA_DIR: tempDir,
        },
        stdio: "pipe",
      },
    );
  });

  it("adds the tracer-link composite unique index to legacy tables", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "job-ops-migrate-"));
    const script = `
      import { join } from "node:path";
      import { pathToFileURL } from "node:url";
      import Database from "bun:sqlite";

      const dbPath = join(process.env.DATA_DIR, "jobs.db");
      const sqlite = new Database(dbPath);
      sqlite.exec(\`
        CREATE TABLE tracer_links (
          id TEXT PRIMARY KEY,
          token TEXT NOT NULL UNIQUE,
          job_id TEXT NOT NULL,
          source_path TEXT NOT NULL,
          source_label TEXT NOT NULL,
          destination_url TEXT NOT NULL,
          destination_url_hash TEXT NOT NULL,
          is_active INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE tracer_click_events (
          id TEXT PRIMARY KEY,
          tracer_link_id TEXT NOT NULL,
          clicked_at INTEGER NOT NULL,
          is_likely_bot INTEGER NOT NULL DEFAULT 0,
          unique_fingerprint_hash TEXT
        );

        INSERT INTO tracer_links(
          id, token, job_id, source_path, source_label, destination_url,
          destination_url_hash, created_at, updated_at
        )
        VALUES
          ('link-1', 'acme-aa', 'job-1', 'basics.url.href', 'Portfolio', 'https://example.com', 'hash-1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
          ('link-2', 'acme-bb', 'job-1', 'basics.url.href', 'Portfolio', 'https://example.com', 'hash-1', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');

        INSERT INTO tracer_click_events(id, tracer_link_id, clicked_at)
        VALUES ('click-1', 'link-2', 1);
      \`);
      sqlite.close();

      await import(pathToFileURL(join(process.cwd(), "src/server/db/migrate.ts")).href);

      const migratedDb = new Database(dbPath, { readonly: true });
      const indexes = migratedDb.prepare("PRAGMA index_list(tracer_links)").all();
      const uniqueIndex = indexes.find((index) => index.name === "idx_tracer_links_tenant_user_job_source_destination_unique");
      if (!uniqueIndex || !uniqueIndex.unique) {
        throw new Error("tracer_links composite unique index missing after migration");
      }

      const linkCount = migratedDb.prepare("SELECT count(*) AS count FROM tracer_links").get();
      if (linkCount.count !== 1) {
        throw new Error(\`Expected duplicate tracer links to be merged, got \${linkCount.count}\`);
      }

      const click = migratedDb.prepare("SELECT tracer_link_id FROM tracer_click_events WHERE id = ?").get("click-1");
      if (click?.tracer_link_id !== "link-1") {
        throw new Error(\`Expected duplicate click to be reassigned to link-1, got \${click?.tracer_link_id}\`);
      }

      migratedDb.close();
    `;

    execFileSync(
      process.execPath,
      ["-e", script],
      {
        env: {
          ...process.env,
          DATA_DIR: tempDir,
        },
        stdio: "pipe",
      },
    );
  });

  it("relaxes legacy NOT NULL password columns while preserving accounts", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "job-ops-migrate-"));
    const script = `
      import { join } from "node:path";
      import { pathToFileURL } from "node:url";
      import Database from "bun:sqlite";

      const dbPath = join(process.env.DATA_DIR, "jobs.db");
      const sqlite = new Database(dbPath);
      sqlite.exec(\`
        CREATE TABLE users (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL UNIQUE,
          display_name TEXT,
          password_hash TEXT NOT NULL,
          password_salt TEXT NOT NULL,
          is_system_admin INTEGER NOT NULL DEFAULT 0,
          is_disabled INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE tenants (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          slug TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE tenant_memberships (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          tenant_id TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'owner' CHECK(role IN ('owner', 'member')),
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
          UNIQUE(user_id, tenant_id)
        );

        INSERT INTO tenants(id, name, slug) VALUES ('tenant_default', 'JobOps', 'default');
        INSERT INTO users(id, username, display_name, password_hash, password_salt, is_system_admin)
        VALUES ('user-legacy', 'legacy', 'Legacy Owner', 'legacy-hash', 'legacy-salt', 1);
        INSERT INTO tenant_memberships(id, user_id, tenant_id, role)
        VALUES ('membership-legacy', 'user-legacy', 'tenant_default', 'owner');
      \`);
      sqlite.close();

      // Bun ignores the query on file:// URLs, so a plain path is needed to run the module again.
      const migrationPath = join(process.cwd(), "src/server/db/migrate.ts");
      await import(\`\${migrationPath}?run=initial\`);
      await import(\`\${migrationPath}?run=rerun\`);

      const migratedDb = new Database(dbPath);
      const columns = migratedDb.prepare("PRAGMA table_info(users)").all();
      for (const columnName of ["password_hash", "password_salt"]) {
        const column = columns.find((entry) => entry.name === columnName);
        if (!column || column.notnull !== 0) {
          throw new Error(\`\${columnName} is still NOT NULL after migration\`);
        }
      }

      const user = migratedDb.prepare("SELECT username, password_hash, is_system_admin FROM users WHERE id = ?").get("user-legacy");
      if (user?.password_hash !== "legacy-hash" || user.is_system_admin !== 1) {
        throw new Error("Legacy user did not survive the rebuild");
      }

      const membership = migratedDb.prepare("SELECT tenant_id FROM tenant_memberships WHERE user_id = ?").get("user-legacy");
      if (membership?.tenant_id !== "tenant_default") {
        throw new Error("Legacy tenant membership did not survive the rebuild");
      }

      const userCount = migratedDb.prepare("SELECT count(*) AS count FROM users").get();
      if (userCount.count !== 1) {
        throw new Error(\`Expected a single user after the rebuild, got \${userCount.count}\`);
      }

      migratedDb.prepare("INSERT INTO users(id, username) VALUES (?, ?)").run("user-sso", "sso");

      let duplicateMessage = null;
      try {
        migratedDb.prepare("INSERT INTO users(id, username) VALUES (?, ?)").run("user-duplicate", "legacy");
      } catch (error) {
        duplicateMessage = error.message;
      }
      if (!duplicateMessage?.includes("UNIQUE constraint failed: users.username")) {
        throw new Error(\`Expected a username uniqueness failure, got \${duplicateMessage}\`);
      }

      migratedDb.close();
    `;

    execFileSync(
      process.execPath,
      ["-e", script],
      {
        env: {
          ...process.env,
          DATA_DIR: tempDir,
          BASIC_AUTH_USER: "",
          BASIC_AUTH_PASSWORD: "",
        },
        stdio: "pipe",
      },
    );
  });

  it("creates sso_identities with a unique provider subject", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "job-ops-migrate-"));
    const script = `
      import { join } from "node:path";
      import { pathToFileURL } from "node:url";
      import Database from "bun:sqlite";

      const dbPath = join(process.env.DATA_DIR, "jobs.db");
      await import(pathToFileURL(join(process.cwd(), "src/server/db/migrate.ts")).href);

      const migratedDb = new Database(dbPath);

      const fks = migratedDb.prepare("PRAGMA foreign_key_list(sso_identities)").all();
      const hasTenantCascade = fks.some((fk) => fk.from === "tenant_id" && fk.table === "tenants" && String(fk.on_delete).toUpperCase() === "CASCADE");
      const hasUserCascade = fks.some((fk) => fk.from === "user_id" && fk.table === "users" && String(fk.on_delete).toUpperCase() === "CASCADE");
      if (!hasTenantCascade || !hasUserCascade) {
        throw new Error("sso_identities is missing its foreign keys");
      }

      const indexes = migratedDb.prepare("PRAGMA index_list(sso_identities)").all();
      if (!indexes.some((index) => index.name === "idx_sso_identities_user_id")) {
        throw new Error("sso_identities user index missing");
      }

      migratedDb.prepare("INSERT INTO users(id, username) VALUES (?, ?)").run("user-1", "alice");
      migratedDb.prepare("INSERT INTO sso_identities(id, user_id, provider, issuer, subject) VALUES (?, ?, ?, ?, ?)").run(
        "identity-1",
        "user-1",
        "oidc",
        "https://id.example.com",
        "subject-1",
      );

      let duplicateFailed = false;
      try {
        migratedDb.prepare("INSERT INTO sso_identities(id, user_id, provider, issuer, subject) VALUES (?, ?, ?, ?, ?)").run(
          "identity-2",
          "user-1",
          "oidc",
          "https://id.example.com",
          "subject-1",
        );
      } catch {
        duplicateFailed = true;
      }
      if (!duplicateFailed) {
        throw new Error("sso_identities allowed a duplicate provider subject");
      }

      let unknownProviderFailed = false;
      try {
        migratedDb.prepare("INSERT INTO sso_identities(id, user_id, provider, issuer, subject) VALUES (?, ?, ?, ?, ?)").run(
          "identity-3",
          "user-1",
          "linkedin",
          "https://id.example.com",
          "subject-2",
        );
      } catch {
        unknownProviderFailed = true;
      }
      if (!unknownProviderFailed) {
        throw new Error("sso_identities accepted an unknown provider");
      }

      const stored = migratedDb.prepare("SELECT tenant_id FROM sso_identities WHERE id = ?").get("identity-1");
      if (stored?.tenant_id !== "tenant_default") {
        throw new Error(\`Expected the default tenant, got \${stored?.tenant_id}\`);
      }

      migratedDb.close();
    `;

    execFileSync(
      process.execPath,
      ["-e", script],
      {
        env: {
          ...process.env,
          DATA_DIR: tempDir,
        },
        stdio: "pipe",
      },
    );
  });

  it("creates the role_cvs table with private scoping and per-scope unique names", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "job-ops-migrate-"));
    const script = `
      import { join } from "node:path";
      import { pathToFileURL } from "node:url";
      import Database from "bun:sqlite";

      const dbPath = join(process.env.DATA_DIR, "jobs.db");
      await import(pathToFileURL(join(process.cwd(), "src/server/db/migrate.ts")).href);
      const migratedDb = new Database(dbPath);

      const columns = migratedDb.prepare("PRAGMA table_info(role_cvs)").all().map((column) => column.name);
      for (const required of [
        "id", "tenant_id", "user_id", "name", "role_description",
        "tailored_headline", "tailored_summary", "tailored_skills", "selected_project_ids",
        "master_resume_revision", "generated_at",
        "pdf_path", "pdf_fingerprint", "pdf_generated_at", "pdf_regenerating_since",
        "created_at", "updated_at",
      ]) {
        if (!columns.includes(required)) {
          throw new Error(\`role_cvs.\${required} missing\`);
        }
      }

      const fks = migratedDb.prepare("PRAGMA foreign_key_list(role_cvs)").all();
      if (!fks.some((fk) => fk.from === "tenant_id" && fk.table === "tenants" && String(fk.on_delete).toUpperCase() === "CASCADE")) {
        throw new Error("role_cvs is missing the tenant foreign key");
      }

      migratedDb.prepare("INSERT INTO tenants(id, name, slug) VALUES (?, ?, ?)").run("tenant_other", "Other", "other");
      const insert = migratedDb.prepare("INSERT INTO role_cvs(id, tenant_id, user_id, name) VALUES (?, ?, NULL, ?)");
      insert.run("cv-1", "tenant_default", "Backend Engineer");
      insert.run("cv-2", "tenant_other", "Backend Engineer");

      let duplicateFailed = false;
      try {
        insert.run("cv-3", "tenant_default", "backend engineer");
      } catch {
        duplicateFailed = true;
      }
      if (!duplicateFailed) {
        throw new Error("role_cvs allowed a duplicate name in the same scope");
      }
      migratedDb.close();
    `;

    execFileSync(
      process.execPath,
      ["-e", script],
      {
        env: {
          ...process.env,
          DATA_DIR: tempDir,
        },
        stdio: "pipe",
      },
    );

    // Re-running migrations on an already-migrated database must succeed.
    execFileSync(
      process.execPath,
      [
        "-e",
        `import { join } from "node:path"; import { pathToFileURL } from "node:url"; await import(pathToFileURL(join(process.cwd(), "src/server/db/migrate.ts")).href);`,
      ],
      {
        env: {
          ...process.env,
          DATA_DIR: tempDir,
        },
        stdio: "pipe",
      },
    );
  });

  it("adds the job Role CV columns and keeps them across reboots", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "job-ops-migrate-"));
    const runMigrations = `import { join } from "node:path"; import { pathToFileURL } from "node:url"; await import(pathToFileURL(join(process.cwd(), "src/server/db/migrate.ts")).href);`;
    const exec = (script: string) =>
      execFileSync(
        process.execPath,
        ["-e", script],
        { env: { ...process.env, DATA_DIR: tempDir ?? "" }, stdio: "pipe" },
      );

    exec(`
      ${runMigrations}
      import Database from "bun:sqlite";
      const db = new Database(join(process.env.DATA_DIR, "jobs.db"));
      const columns = db.prepare("PRAGMA table_info(jobs)").all().map((column) => column.name);
      for (const required of ["role_cv_id", "role_cv_match_source"]) {
        if (!columns.includes(required)) throw new Error(\`jobs.\${required} missing\`);
      }
      db.prepare(
        "INSERT INTO jobs (id, title, employer, job_url, role_cv_id, role_cv_match_source) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("job-1", "Engineer", "Acme", "https://example.com/job-1", "cv-1", "manual");
      db.close();
    `);

    // The jobs table is rebuilt on every boot; the reference must survive it.
    exec(`
      ${runMigrations}
      import Database from "bun:sqlite";
      const db = new Database(join(process.env.DATA_DIR, "jobs.db"), { readonly: true });
      const row = db.prepare("SELECT role_cv_id, role_cv_match_source FROM jobs WHERE id = ?").get("job-1");
      if (row?.role_cv_id !== "cv-1" || row?.role_cv_match_source !== "manual") {
        throw new Error(\`Role CV reference lost on reboot: \${JSON.stringify(row)}\`);
      }
      db.close();
    `);
  });

  it("creates access_tokens with owner foreign keys and a unique prefix", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "job-ops-migrate-"));
    const script = `
      import { join } from "node:path";
      import { pathToFileURL } from "node:url";
      import Database from "bun:sqlite";

      const dbPath = join(process.env.DATA_DIR, "jobs.db");
      // The database was already migrated once: a second boot must not fail.
      await import(pathToFileURL(join(process.cwd(), "src/server/db/migrate.ts")).href);

      const migratedDb = new Database(dbPath);
      migratedDb.run("PRAGMA foreign_keys = ON");

      const fks = migratedDb.prepare("PRAGMA foreign_key_list(access_tokens)").all();
      const cascades = (from, table) => fks.some((fk) => fk.from === from && fk.table === table && String(fk.on_delete).toUpperCase() === "CASCADE");
      if (!cascades("tenant_id", "tenants") || !cascades("user_id", "users")) {
        throw new Error("access_tokens is missing its foreign keys");
      }

      const indexes = migratedDb.prepare("PRAGMA index_list(access_tokens)").all();
      if (!indexes.some((index) => index.name === "idx_access_tokens_tenant_user")) {
        throw new Error("access_tokens tenant/user index missing");
      }

      migratedDb.prepare("INSERT INTO users(id, username) VALUES (?, ?)").run("user-1", "alice");
      const insert = migratedDb.prepare("INSERT INTO access_tokens(id, tenant_id, user_id, name, token_prefix, token_hash, scope) VALUES (?, ?, ?, ?, ?, ?, ?)");
      insert.run("token-1", "tenant_default", "user-1", "agent", "abcdef012345", "hash-1", "read");

      const expectFailure = (label, fn) => {
        let failed = false;
        try { fn(); } catch { failed = true; }
        if (!failed) throw new Error(label);
      };
      expectFailure("duplicate prefix accepted", () =>
        insert.run("token-2", "tenant_default", "user-1", "agent", "abcdef012345", "hash-2", "read"));
      expectFailure("unknown scope accepted", () =>
        insert.run("token-3", "tenant_default", "user-1", "agent", "abcdef099999", "hash-3", "admin"));

      migratedDb.prepare("DELETE FROM users WHERE id = ?").run("user-1");
      const remaining = migratedDb.prepare("SELECT count(*) AS count FROM access_tokens").get();
      if (remaining.count !== 0) {
        throw new Error("access tokens survived their user");
      }

      migratedDb.close();
    `;
    const migrateOnly = `
      import { join } from "node:path";
      import { pathToFileURL } from "node:url";
      await import(pathToFileURL(join(process.cwd(), "src/server/db/migrate.ts")).href);
    `;

    for (const source of [migrateOnly, script]) {
      execFileSync(
        process.execPath,
        ["-e", source],
        {
          env: {
            ...process.env,
            DATA_DIR: tempDir,
          },
          stdio: "pipe",
        },
      );
    }
  });

  it("keeps the run trigger across reboots and creates the schedule state table", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "job-ops-migrate-"));
    const runMigrations = `import { join } from "node:path"; import { pathToFileURL } from "node:url"; await import(pathToFileURL(join(process.cwd(), "src/server/db/migrate.ts")).href);`;
    const exec = (script: string) =>
      execFileSync(
        process.execPath,
        ["-e", script],
        { env: { ...process.env, DATA_DIR: tempDir ?? "" }, stdio: "pipe" },
      );

    // An install from before scheduled runs: pipeline_runs has no trigger.
    exec(`
      import { join } from "node:path";
      import Database from "bun:sqlite";
      const db = new Database(join(process.env.DATA_DIR, "jobs.db"));
      db.exec(\`
        CREATE TABLE pipeline_runs (
          id TEXT PRIMARY KEY,
          started_at TEXT NOT NULL DEFAULT (datetime('now')),
          completed_at TEXT,
          status TEXT NOT NULL DEFAULT 'running',
          jobs_discovered INTEGER NOT NULL DEFAULT 0,
          jobs_processed INTEGER NOT NULL DEFAULT 0,
          error_message TEXT,
          config_snapshot TEXT
        );
        INSERT INTO pipeline_runs (id, status) VALUES ('old-run', 'completed');
      \`);
      db.close();
    `);

    exec(`
      ${runMigrations}
      import Database from "bun:sqlite";
      const db = new Database(join(process.env.DATA_DIR, "jobs.db"));
      const old = db.prepare("SELECT run_trigger FROM pipeline_runs WHERE id = ?").get("old-run");
      if (!old || old.run_trigger !== null) throw new Error(\`old run changed: \${JSON.stringify(old)}\`);
      db.prepare("INSERT INTO pipeline_runs (id, status, run_trigger) VALUES (?, ?, ?)").run("scheduled-run", "completed", "schedule");
      db.close();
    `);

    // pipeline_runs is rebuilt on every boot; the trigger must survive it.
    exec(`
      ${runMigrations}
      import Database from "bun:sqlite";
      const db = new Database(join(process.env.DATA_DIR, "jobs.db"));
      db.run("PRAGMA foreign_keys = ON");
      const row = db.prepare("SELECT run_trigger FROM pipeline_runs WHERE id = ?").get("scheduled-run");
      if (row?.run_trigger !== "schedule") {
        throw new Error(\`run trigger lost on reboot: \${JSON.stringify(row)}\`);
      }

      const stateColumns = db.prepare("PRAGMA table_info(pipeline_schedule_state)").all().map((column) => column.name);
      for (const required of ["last_fired_occurrence", "last_fired_local_date", "settings_saved_at", "reported_invalid_time_zone"]) {
        if (!stateColumns.includes(required)) throw new Error(\`pipeline_schedule_state.\${required} missing\`);
      }

      const fks = db.prepare("PRAGMA foreign_key_list(pipeline_schedule_state)").all();
      const hasFk = (from, table, onDelete) => fks.some((fk) => fk.from === from && fk.table === table && String(fk.on_delete).toUpperCase() === onDelete);
      if (!hasFk("tenant_id", "tenants", "CASCADE") || !hasFk("owner_user_id", "users", "SET NULL")) {
        throw new Error("pipeline_schedule_state is missing its foreign keys");
      }

      db.prepare("INSERT INTO users(id, username) VALUES (?, ?)").run("owner-1", "owner");
      db.prepare("INSERT INTO pipeline_schedule_state(tenant_id, owner_user_id, last_fired_occurrence, last_outcome) VALUES (?, ?, ?, ?)")
        .run("tenant_default", "owner-1", "2026-11-17T01:00:00.000Z", "started");
      let rejected = false;
      try {
        db.prepare("UPDATE pipeline_schedule_state SET last_outcome = ? WHERE tenant_id = ?").run("exploded", "tenant_default");
      } catch { rejected = true; }
      if (!rejected) throw new Error("unknown schedule outcome accepted");

      db.prepare("DELETE FROM users WHERE id = ?").run("owner-1");
      const state = db.prepare("SELECT owner_user_id, last_fired_occurrence FROM pipeline_schedule_state WHERE tenant_id = ?").get("tenant_default");
      if (state?.owner_user_id !== null || state?.last_fired_occurrence !== "2026-11-17T01:00:00.000Z") {
        throw new Error(\`schedule state wrong after owner deletion: \${JSON.stringify(state)}\`);
      }
      db.close();
    `);
  });

  it("enforces private unique indexes when user_id is null", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "job-ops-migrate-"));
    const script = `
      import { join } from "node:path";
      import { pathToFileURL } from "node:url";
      import Database from "bun:sqlite";

      const dbPath = join(process.env.DATA_DIR, "jobs.db");
      await import(pathToFileURL(join(process.cwd(), "src/server/db/migrate.ts")).href);

      const migratedDb = new Database(dbPath);
      migratedDb.prepare("INSERT INTO jobs(id, tenant_id, user_id, title, employer, job_url) VALUES (?, ?, NULL, ?, ?, ?)").run(
        "job-null-owner-1",
        "tenant_default",
        "Role",
        "Acme",
        "https://example.com/null-owner",
      );

      let duplicateFailed = false;
      try {
        migratedDb.prepare("INSERT INTO jobs(id, tenant_id, user_id, title, employer, job_url) VALUES (?, ?, NULL, ?, ?, ?)").run(
          "job-null-owner-2",
          "tenant_default",
          "Role",
          "Acme",
          "https://example.com/null-owner",
        );
      } catch {
        duplicateFailed = true;
      }

      if (!duplicateFailed) {
        throw new Error("jobs unique index allowed duplicate NULL user_id rows");
      }

      migratedDb.close();
    `;

    execFileSync(
      process.execPath,
      ["-e", script],
      {
        env: {
          ...process.env,
          DATA_DIR: tempDir,
        },
        stdio: "pipe",
      },
    );
  });
});
