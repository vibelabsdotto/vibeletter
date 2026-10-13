import { getImage, IMAGE_CACHE_CONTROL, imageTypeForKey, ImageStorageError } from "@/lib/blob";

type FileContext = { params: Promise<{ key: string[] }> };

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function serveImage(request: Request, context: FileContext, head: boolean): Promise<Response> {
	try {
		const { key: segments } = await context.params;
		// Next decodes the segments once. Never decode or normalize them again.
		if (!Array.isArray(segments) || segments.length !== 2 || segments.some((segment) => typeof segment !== "string" || segment.includes("/") || segment.includes("\\"))) throw new ImageStorageError("Image not found", 404);
		const key = segments.join("/");
		imageTypeForKey(key);
		const image = await getImage(key);
		const headers = new Headers({
			"Content-Type": image.contentType,
			"Content-Length": String(image.bytes.byteLength),
			"Content-Disposition": `inline; filename="${segments[1]}"`,
			"Cache-Control": IMAGE_CACHE_CONTROL,
			"X-Content-Type-Options": "nosniff",
			"Content-Security-Policy": "default-src 'none'; sandbox",
			"ETag": image.etag,
		});
		const matches = request.headers.get("if-none-match")?.split(",").some((candidate) => candidate.trim().replace(/^W\//, "") === image.etag || candidate.trim() === "*");
		if (matches) {
			headers.delete("Content-Length");
			return new Response(null, { status: 304, headers });
		}
		return new Response(head ? null : image.bytes, { headers });
	} catch (error: unknown) {
		const status = error instanceof ImageStorageError ? error.status : 502;
		const message = status === 404 ? "Image not found" : status === 503 ? "Image storage is not configured" : "Image could not be loaded";
		if (!(error instanceof ImageStorageError)) console.error("[files] Image read failed");
		const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
		return head ? new Response(null, { status, headers }) : Response.json({ error: message }, { status, headers });
	}
}

// Images stay public for sent emails. This endpoint never lists objects or proxies caller-supplied URLs.
export async function GET(request: Request, context: FileContext): Promise<Response> {
	return serveImage(request, context, false);
}

export async function HEAD(request: Request, context: FileContext): Promise<Response> {
	return serveImage(request, context, true);
}
