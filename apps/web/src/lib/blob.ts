import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";
import { crc32 } from "node:zlib";

export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
export const IMAGE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const IO_TIMEOUT_MS = 30_000;
const MAX_IMAGE_PIXELS = 64_000_000;
const IMAGE_EXTENSIONS = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" } as const;
export type ImageContentType = keyof typeof IMAGE_EXTENSIONS;

export class ImageStorageError extends Error {
	readonly status: number;
	constructor(message: string, status: number) {
		super(message);
		this.name = "ImageStorageError";
		this.status = status;
	}
}

type Storage = { kind: "local"; root: string } | {
	kind: "r2"; accountId: string; bucket: string; accessKeyId: string; secretAccessKey: string;
};
export type StoredImage = { bytes: Uint8Array<ArrayBuffer>; contentType: ImageContentType; etag: string };

export function imageExtension(contentType: string | null): string {
	if (!contentType || !Object.hasOwn(IMAGE_EXTENSIONS, contentType)) {
		throw new ImageStorageError("Use a PNG, JPEG, GIF or WebP image", 415);
	}
	return IMAGE_EXTENSIONS[contentType as ImageContentType];
}

function invalidImage(): never {
	throw new ImageStorageError("This file isn't a valid PNG, JPEG, GIF or WebP image", 415);
}

function dimensions(width: number, height: number): boolean {
	return width > 0 && height > 0 && width <= 16_384 && height <= 16_384 && width * height <= MAX_IMAGE_PIXELS;
}

function validPng(bytes: Buffer): boolean {
	if (bytes.length < 57 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return false;
	let offset = 8;
	let hasHeader = false;
	let hasData = false;
	while (offset + 12 <= bytes.length) {
		const length = bytes.readUInt32BE(offset);
		const end = offset + 12 + length;
		if (end > bytes.length) return false;
		// latin1 preserves every byte; Node's ascii decoder masks invalid high bits.
		const type = bytes.toString("latin1", offset + 4, offset + 8);
		if (!/^[A-Za-z]{4}$/.test(type) || crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) return false;
		if (!hasHeader) {
			if (type !== "IHDR" || length !== 13 || !dimensions(bytes.readUInt32BE(offset + 8), bytes.readUInt32BE(offset + 12))) return false;
			const depths: Record<number, readonly number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
			if (!depths[bytes[offset + 17]]?.includes(bytes[offset + 16]) || bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || bytes[offset + 20] > 1) return false;
			hasHeader = true;
		} else if (type === "IHDR") return false;
		if (type === "IDAT" && length > 0) hasData = true;
		if (type === "IEND") return length === 0 && hasData && end === bytes.length;
		offset = end;
	}
	return false;
}

function validJpeg(bytes: Buffer): boolean {
	if (bytes.length < 12 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
	let offset = 2;
	let hasFrame = false;
	let hasScan = false;
	while (offset < bytes.length) {
		if (bytes[offset++] !== 0xff) return false;
		while (bytes[offset] === 0xff) offset++;
		const marker = bytes[offset++];
		if (marker === 0xd9) return hasFrame && hasScan && offset === bytes.length;
		if (marker === 0 || marker === 0xd8 || marker === undefined || (marker >= 0xd0 && marker <= 0xd7)) return false;
		if (offset + 2 > bytes.length) return false;
		const length = bytes.readUInt16BE(offset);
		if (length < 2 || offset + length > bytes.length) return false;
		if ([0xc0, 0xc1, 0xc2].includes(marker)) {
			if (length < 11 || !dimensions(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3))) return false;
			const components = bytes[offset + 7];
			if (![1, 3, 4].includes(components) || length !== 8 + 3 * components) return false;
			hasFrame = true;
		}
		offset += length;
		if (marker === 0xda) {
			if (!hasFrame || length < 6) return false;
			hasScan = true;
			// Skip entropy bytes, escaped FF bytes and restart markers, but parse every following marker.
			while (offset < bytes.length) {
				if (bytes[offset] !== 0xff) { offset++; continue; }
				const next = bytes[offset + 1];
				if (next === 0 || (next >= 0xd0 && next <= 0xd7)) { offset += 2; continue; }
				break;
			}
		}
	}
	return false;
}

function validGif(bytes: Buffer): boolean {
	if (bytes.length < 14 || !["GIF87a", "GIF89a"].includes(bytes.toString("latin1", 0, 6)) || !dimensions(bytes.readUInt16LE(6), bytes.readUInt16LE(8))) return false;
	let offset = 13 + ((bytes[10] & 0x80) ? 3 * (1 << ((bytes[10] & 7) + 1)) : 0);
	let hasFrame = false;
	function subBlocks(): boolean {
		while (offset < bytes.length) {
			const size = bytes[offset++];
			if (size === 0) return true;
			offset += size;
			if (offset > bytes.length) return false;
		}
		return false;
	}
	while (offset < bytes.length) {
		const marker = bytes[offset++];
		if (marker === 0x3b) return hasFrame && offset === bytes.length;
		if (marker === 0x21) {
			if (offset >= bytes.length) return false;
			offset++;
			if (!subBlocks()) return false;
		} else if (marker === 0x2c) {
			if (offset + 9 > bytes.length || !dimensions(bytes.readUInt16LE(offset + 4), bytes.readUInt16LE(offset + 6))) return false;
			const packed = bytes[offset + 8];
			offset += 9 + ((packed & 0x80) ? 3 * (1 << ((packed & 7) + 1)) : 0);
			if (offset >= bytes.length || bytes[offset] < 2 || bytes[offset] > 8) return false;
			offset++;
			if (bytes[offset] === 0 || !subBlocks()) return false;
			hasFrame = true;
		} else return false;
	}
	return false;
}

function webpFrame(bytes: Buffer, offset: number, length: number, type: string): boolean {
	if (type === "VP8 ") {
		return length >= 10 && (bytes[offset] & 1) === 0 && bytes.subarray(offset + 3, offset + 6).equals(Buffer.from([0x9d, 0x01, 0x2a])) && dimensions(bytes.readUInt16LE(offset + 6) & 0x3fff, bytes.readUInt16LE(offset + 8) & 0x3fff);
	}
	if (type === "VP8L") {
		if (length < 5 || bytes[offset] !== 0x2f) return false;
		const bits = bytes.readUInt32LE(offset + 1);
		return (bits >>> 29) === 0 && dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
	}
	return false;
}

function validWebp(bytes: Buffer): boolean {
	if (bytes.length < 26 || bytes.toString("latin1", 0, 4) !== "RIFF" || bytes.toString("latin1", 8, 12) !== "WEBP" || bytes.readUInt32LE(4) !== bytes.length - 8) return false;
	let offset = 12;
	let hasFrame = false;
	while (offset + 8 <= bytes.length) {
		const type = bytes.toString("latin1", offset, offset + 4);
		// RIFF FourCCs contain printable ASCII, even for unknown chunks we skip.
		if (!/^[\x20-\x7e]{4}$/.test(type)) return false;
		const length = bytes.readUInt32LE(offset + 4);
		const data = offset + 8;
		const end = data + length + (length & 1);
		if (end > bytes.length) return false;
		if (type === "VP8 " || type === "VP8L") {
			if (!webpFrame(bytes, data, length, type)) return false;
			hasFrame = true;
		} else if (type === "VP8X") {
			if (offset !== 12 || length !== 10 || !dimensions(bytes.readUIntLE(data + 4, 3) + 1, bytes.readUIntLE(data + 7, 3) + 1)) return false;
		} else if (type === "ANMF") {
			if (length < 24 || !dimensions(bytes.readUIntLE(data + 6, 3) + 1, bytes.readUIntLE(data + 9, 3) + 1)) return false;
			let frame = data + 16;
			let found = false;
			while (frame + 8 <= data + length) {
				const frameType = bytes.toString("latin1", frame, frame + 4);
				if (!/^[\x20-\x7e]{4}$/.test(frameType)) return false;
				const frameLength = bytes.readUInt32LE(frame + 4);
				if (frame + 8 + frameLength + (frameLength & 1) > data + length) return false;
				if (frameType === "VP8 " || frameType === "VP8L") {
					if (!webpFrame(bytes, frame + 8, frameLength, frameType)) return false;
					found = true;
				}
				frame += 8 + frameLength + (frameLength & 1);
			}
			if (!found || frame !== data + length) return false;
			hasFrame = true;
		}
		offset = end;
	}
	return hasFrame && offset === bytes.length;
}

/** Validate real container signatures and structure, not a client-provided MIME type or filename. SVG is never accepted. */
export function validateImage(input: Uint8Array, contentType: string): ImageContentType {
	imageExtension(contentType);
	if (input.byteLength > MAX_UPLOAD_BYTES) throw new ImageStorageError("Images must be under 4 MB", 413);
	if (input.byteLength === 0) invalidImage();
	const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
	const valid = contentType === "image/png" ? validPng(bytes) : contentType === "image/jpeg" ? validJpeg(bytes) : contentType === "image/gif" ? validGif(bytes) : validWebp(bytes);
	if (!valid) invalidImage();
	return contentType as ImageContentType;
}

/** Enforce the limit while reading even when Content-Length is absent or dishonest. */
export async function readImageBytes(stream: ReadableStream<Uint8Array> | null, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
	if (!stream) invalidImage();
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	let fail: (reason: ImageStorageError) => void = () => {};
	const interrupted = new Promise<never>((_resolve, reject) => { fail = reject; });
	const timer = setTimeout(() => fail(new ImageStorageError("Image transfer timed out", 408)), IO_TIMEOUT_MS);
	const abort = () => fail(new ImageStorageError("Image transfer was interrupted", 400));
	signal?.addEventListener("abort", abort, { once: true });
	if (signal?.aborted) abort();
	let completed = false;
	try {
		while (true) {
			const chunk = await Promise.race([reader.read(), interrupted]);
			if (chunk.done) break;
			length += chunk.value.byteLength;
			if (length > MAX_UPLOAD_BYTES) throw new ImageStorageError("Images must be under 4 MB", 413);
			chunks.push(chunk.value);
		}
		if (!length) invalidImage();
		const bytes = new Uint8Array(length);
		let offset = 0;
		for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
		completed = true;
		return bytes;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
		if (!completed) void reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

function storage(): Storage {
	if (process.env.UPLOAD_STORAGE === "local") {
		if (process.env.NODE_ENV !== "development") throw new ImageStorageError("Local image storage is only allowed in development", 503);
		return { kind: "local", root: path.resolve(/* turbopackIgnore: true */ process.env.UPLOAD_LOCAL_DIR || path.join(process.cwd(), "data", "uploads")) };
	}
	if (process.env.UPLOAD_STORAGE && process.env.UPLOAD_STORAGE !== "r2") throw new ImageStorageError("Invalid UPLOAD_STORAGE configuration", 503);
	const accountId = process.env.R2_ACCOUNT_ID?.trim();
	const bucket = process.env.R2_BUCKET?.trim();
	const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim();
	const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim();
	if (!accountId || !bucket || !accessKeyId || !secretAccessKey) throw new ImageStorageError("Image uploads need R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY", 503);
	if (!/^[a-f0-9]{32}$/i.test(accountId) || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) throw new ImageStorageError("Invalid R2 account or bucket configuration", 503);
	return { kind: "r2", accountId, bucket, accessKeyId, secretAccessKey };
}

function configuredUrl(value: string | undefined, label: string, originOnly: boolean): URL {
	try {
		if (!value) throw new Error("Missing URL");
		const url = new URL(value);
		if (!(["https:", "http:"].includes(url.protocol)) || (process.env.NODE_ENV !== "development" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash || (originOnly && url.pathname !== "/")) throw new Error("Invalid URL");
		return url;
	} catch {
		throw new ImageStorageError(`${label} must be an absolute ${process.env.NODE_ENV === "development" ? "HTTP(S)" : "HTTPS"} URL without credentials, query or fragment${originOnly ? " or a path" : ""}`, 503);
	}
}

function imageUrl(key: string, backend: Storage): string {
	if (backend.kind === "r2" && process.env.R2_PUBLIC_URL) {
		const base = configuredUrl(process.env.R2_PUBLIC_URL, "R2_PUBLIC_URL", false);
		base.pathname = `${base.pathname.replace(/\/$/, "")}/${key}`;
		return base.href;
	}
	return new URL(`/api/files/${key}`, configuredUrl(process.env.APP_URL, "APP_URL", true)).href;
}

export function assertImageStorageConfigured(): void {
	const backend = storage();
	imageUrl("images/configuration.png", backend);
}

function imageKey(pathname: string, contentType: ImageContentType): string {
	const extension = IMAGE_EXTENSIONS[contentType];
	// Do not normalize hostile paths into safe ones. Callers must supply the images namespace.
	const match = /^images\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,79})\.(png|jpg|jpeg|gif|webp)$/.exec(pathname);
	if (!match || (match[2] !== extension && !(contentType === "image/jpeg" && match[2] === "jpeg"))) throw new ImageStorageError("Invalid image pathname", 400);
	return `images/${match[1]}-${randomUUID()}.${extension}`;
}

export function imageTypeForKey(key: string): ImageContentType {
	if (!/^images\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,116}\.(png|jpg|gif|webp)$/.test(key)) throw new ImageStorageError("Image not found", 404);
	const extension = key.slice(key.lastIndexOf(".") + 1);
	const type = (Object.keys(IMAGE_EXTENSIONS) as ImageContentType[]).find((candidate) => IMAGE_EXTENSIONS[candidate] === extension);
	if (!type) throw new ImageStorageError("Image not found", 404);
	return type;
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

async function localDirectory(root: string, create: boolean): Promise<string> {
	// Reject symlinks in every ancestor, including a configurable storage root. No recursive mkdir follows links.
	const directory = path.join(root, "images");
	let current = path.parse(directory).root;
	for (const segment of directory.slice(current.length).split(path.sep)) {
		current = path.join(current, segment);
		if (create) await mkdir(current, { mode: 0o700 }).catch((error: unknown) => { if (errorCode(error) !== "EEXIST") throw error; });
		const stat = await lstat(current);
		if (stat.isSymbolicLink() || !stat.isDirectory()) throw new ImageStorageError("Unsafe local image storage path", 503);
	}
	if (await realpath(directory) !== directory) throw new ImageStorageError("Unsafe local image storage path", 503);
	return directory;
}

async function localRead(root: string, key: string): Promise<Uint8Array<ArrayBuffer>> {
	const directory = await localDirectory(root, false);
	const handle = await open(path.join(directory, path.basename(key)), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.nlink !== 1) throw new ImageStorageError("Image not found", 404);
		if (stat.size > MAX_UPLOAD_BYTES) throw new ImageStorageError("Images must be under 4 MB", 413);
		// readFile() could grow without bound if a file changed after stat(). Read a fixed maximum instead.
		const bytes = new Uint8Array(MAX_UPLOAD_BYTES + 1);
		let length = 0;
		while (length < bytes.length) {
			const result = await handle.read(bytes, length, bytes.length - length, length);
			if (!result.bytesRead) break;
			length += result.bytesRead;
		}
		if (length > MAX_UPLOAD_BYTES) throw new ImageStorageError("Images must be under 4 MB", 413);
		await localDirectory(root, false);
		return bytes.slice(0, length);
	} finally { await handle.close(); }
}

async function r2Client(backend: Extract<Storage, { kind: "r2" }>) {
	// Load only when R2 is configured. An explicitly selected local transport does not need the AWS SDK.
	const sdk = await import("@aws-sdk/client-s3");
	const client = new sdk.S3Client({
		region: "auto", endpoint: `https://${backend.accountId}.r2.cloudflarestorage.com`, forcePathStyle: true,
		credentials: { accessKeyId: backend.accessKeyId, secretAccessKey: backend.secretAccessKey }, maxAttempts: 2,
		// R2 does not implement all of the SDK's default optional checksum headers. Readback verifies integrity.
		requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED",
	});
	return { sdk, client };
}

async function readStoredImage(key: string, backend: Storage): Promise<StoredImage> {
	const contentType = imageTypeForKey(key);
	let bytes: Uint8Array<ArrayBuffer>;
	try {
		if (backend.kind === "local") bytes = await localRead(backend.root, key);
		else {
			const { sdk, client } = await r2Client(backend);
			try {
				const object = await client.send(new sdk.GetObjectCommand({ Bucket: backend.bucket, Key: key }), { abortSignal: AbortSignal.timeout(IO_TIMEOUT_MS) });
				if (!object.Body) throw new ImageStorageError("Image not found", 404);
				const body = object.Body.transformToWebStream();
				if (object.ContentType !== contentType || (object.ContentLength !== undefined && object.ContentLength > MAX_UPLOAD_BYTES)) {
					void body.cancel().catch(() => {});
					throw new ImageStorageError("Image not found", 404);
				}
				bytes = await readImageBytes(body);
			} finally { client.destroy(); }
		}
		validateImage(bytes, contentType);
	} catch (error: unknown) {
		const code = errorCode(error);
		const name = error instanceof Error ? error.name : "";
		if (["ENOENT", "ENOTDIR", "ELOOP"].includes(code || "") || ["NoSuchKey", "NotFound"].includes(name) || (error instanceof ImageStorageError && [413, 415].includes(error.status))) throw new ImageStorageError("Image not found", 404);
		throw error;
	}
	return { bytes, contentType, etag: `"${createHash("sha256").update(bytes).digest("hex")}"` };
}

/** Public email images need no session, but only validated image keys can ever be read. */
export async function getImage(key: string): Promise<StoredImage> {
	imageTypeForKey(key);
	return readStoredImage(key, storage());
}

/** Preserve the existing editor contract. Unique immutable keys never overwrite sent-email images. */
export async function putImage(pathname: string, input: Uint8Array, contentType: string): Promise<string> {
	// Own the bytes so a caller cannot mutate them between validation and the actual write.
	if (input.byteLength > MAX_UPLOAD_BYTES) throw new ImageStorageError("Images must be under 4 MB", 413);
	const bytes = new Uint8Array(input);
	const type = validateImage(bytes, contentType);
	const key = imageKey(pathname, type);
	const backend = storage();
	const url = imageUrl(key, backend);
	if (backend.kind === "local") {
		const directory = await localDirectory(backend.root, true);
		const handle = await open(path.join(directory, path.basename(key)), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
		try {
			await handle.writeFile(bytes);
			await handle.sync();
			await localDirectory(backend.root, false);
		} finally { await handle.close(); }
	} else {
		const { sdk, client } = await r2Client(backend);
		try {
			await client.send(new sdk.PutObjectCommand({
				Bucket: backend.bucket, Key: key, Body: bytes, ContentLength: bytes.byteLength, ContentType: type,
				CacheControl: IMAGE_CACHE_CONTROL, ContentDisposition: `inline; filename="${path.basename(key)}"`, IfNoneMatch: "*",
			}), { abortSignal: AbortSignal.timeout(IO_TIMEOUT_MS) });
		} finally { client.destroy(); }
	}
	// A provider acknowledgement alone is not success. Read the exact key back and compare its real bytes.
	let saved: StoredImage;
	try { saved = await readStoredImage(key, backend); }
	catch { throw new ImageStorageError("Stored image verification failed", 502); }
	if (!Buffer.from(saved.bytes).equals(Buffer.from(bytes))) throw new ImageStorageError("Stored image verification failed", 502);
	return url;
}
