import { operatorHandler } from "@/server/operator-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = operatorHandler;
export const POST = operatorHandler;
export const PATCH = operatorHandler;
export const DELETE = operatorHandler;
