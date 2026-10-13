import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import { getConfigProblems, getOperatorEmail, MIN_ADMIN_PASSWORD_LENGTH } from "../lib/config.js";

// This local operator command never enables an HTTP signup endpoint.
async function provision(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--password-stdin")) {
    throw new Error("Use --password-stdin or VIBELETTER_OPERATOR_PASSWORD. Passwords must never be passed as arguments.");
  }
  const envFile = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..", ".env");
  try { process.loadEnvFile(envFile); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Could not load the project environment."); }
  const problems = getConfigProblems();
  if (problems.length) throw new Error(problems.join(" "));
  let password = process.env.VIBELETTER_OPERATOR_PASSWORD;
  delete process.env.VIBELETTER_OPERATOR_PASSWORD;
  if (args.includes("--password-stdin")) {
    if (password || process.stdin.isTTY) throw new Error("Pipe a password on stdin, without also setting VIBELETTER_OPERATOR_PASSWORD.");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > 1024) throw new Error("Password input is too long.");
      chunks.push(bytes);
    }
    password = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
  }
  if (!password || password.length < MIN_ADMIN_PASSWORD_LENGTH || password.length > 128 || /[\r\n\0]/.test(password)) {
    throw new Error(`Provide a ${MIN_ADMIN_PASSWORD_LENGTH}-128 character password via VIBELETTER_OPERATOR_PASSWORD or --password-stdin.`);
  }
  const { db, connectDb, sqlite } = await import("../db/index.js");
  const { user, account } = await import("../db/auth-schema.js");
  try {
    await connectDb();
    const email = getOperatorEmail();
    const passwordHash = await hashPassword(password);
    password = undefined;
    const id = db.transaction((tx) => {
      let operator = tx.select().from(user).where(eq(user.email, email)).get();
      if (operator && tx.select({ id: account.id }).from(account).where(and(
        eq(account.userId, operator.id), eq(account.providerId, "credential"),
      )).get()) {
        throw new Error("Operator credentials already exist. Provisioning never silently resets a password.");
      }
      const now = new Date();
      if (!operator) {
        const id = randomUUID();
        tx.insert(user).values({ id, name: "Operator", email, emailVerified: true, image: null, createdAt: now, updatedAt: now }).run();
        operator = tx.select().from(user).where(eq(user.id, id)).get();
      }
      if (!operator) throw new Error("Could not read back the provisioned operator.");
      tx.insert(account).values({
        id: randomUUID(), userId: operator.id, accountId: operator.id, providerId: "credential",
        password: passwordHash, accessToken: null, refreshToken: null, idToken: null,
        accessTokenExpiresAt: null, refreshTokenExpiresAt: null, scope: null, createdAt: now, updatedAt: now,
      }).run();
      const saved = tx.select({ id: account.id, password: account.password }).from(account).where(and(
        eq(account.userId, operator.id), eq(account.providerId, "credential"),
      )).get();
      if (!saved || saved.password !== passwordHash) throw new Error("Could not verify persisted operator credentials.");
      return operator.id;
    }, { behavior: "immediate" });
    console.log(`Operator provisioned: ${email} (${id}). Public signup remains disabled.`);
  } finally {
    sqlite.close();
  }
}

provision().catch((error: unknown) => {
  // Never print a dependency's payload, stack, arguments or database values.
  const message = error instanceof Error && /^(Use |Could not |Provide |Pipe |Password input |Operator credentials |SESSION_SECRET |BETTER_AUTH_SECRET |ADMIN_EMAIL |APP_URL |BETTER_AUTH_URL )/.test(error.message)
    ? error.message : "Operator provisioning failed. Check the configuration and apply database migrations first.";
  console.error(message);
  process.exitCode = 1;
});
