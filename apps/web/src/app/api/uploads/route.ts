import { OperatorError, requireOperator } from "@/lib/operator-api";
import {
	assertImageStorageConfigured,
	imageExtension,
	ImageStorageError,
	MAX_UPLOAD_BYTES,
	putImage,
	readImageBytes,
	validateImage,
} from "@/lib/blob";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function discardBody(request: Request): void {
	if (request.body && !request.body.locked) void request.body.cancel().catch(() => {});
}

function filename(value: string | null): string {
	return (value || "image").slice(0, 256).replace(/\.[^.]+$/, "").normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "image";
}

export async function POST(request: Request): Promise<Response> {
	try {
		// Use the shared scope and canonical-origin gate, including behind TLS termination.
		await requireOperator(request, "uploads:write");
		assertImageStorageConfigured();
		const contentType = request.headers.get("content-type") || "";
		const extension = imageExtension(contentType);
		const length = request.headers.get("content-length");
		if (length !== null) {
			if (!/^\d+$/.test(length)) throw new ImageStorageError("Invalid Content-Length", 400);
			if (Number(length) > MAX_UPLOAD_BYTES) throw new ImageStorageError("Images must be under 4 MB", 413);
		}
		if (request.headers.get("content-encoding") && request.headers.get("content-encoding") !== "identity") throw new ImageStorageError("Encoded image uploads are not supported", 415);
		const bytes = await readImageBytes(request.body, request.signal);
		const type = validateImage(bytes, contentType);
		const url = await putImage(`images/${filename(request.headers.get("x-file-name"))}.${extension}`, bytes, type);
		return Response.json({ url }, { headers: { "Cache-Control": "no-store" } });
	} catch (error: unknown) {
		discardBody(request);
		if (error instanceof OperatorError) return Response.json({ error: error.message, code: error.code }, { status: error.status, headers: { "Cache-Control": "no-store" } });
		if (error instanceof ImageStorageError) return Response.json({ error: error.message }, { status: error.status, headers: { "Cache-Control": "no-store" } });
		// Do not log SDK request objects or configuration, which may include credentials.
		console.error("[uploads] Image upload failed");
		return Response.json({ error: "Upload failed, try again" }, { status: 502, headers: { "Cache-Control": "no-store" } });
	}
}
