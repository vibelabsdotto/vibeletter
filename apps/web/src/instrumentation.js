import { getConfigProblems } from "./lib/config.js";

// Build-time page collection does not provision users or require runtime secrets.
export function register() {
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const problems = getConfigProblems();
  if (problems.length) throw new Error(`VibeLetter can't start. ${problems.join(" ")}`);
}
