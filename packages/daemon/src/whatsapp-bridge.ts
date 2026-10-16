/**
 * This file contains integration code for WhatsApp via Baileys/BuilderBot.
 *
 * Portions of this implementation reference patterns from BuilderBot (https://github.com/builderbot/builderbot),
 * which is licensed under the MIT License. The original BuilderBot code is:
 * Copyright (c) 2022-present Jhonny Fernando.
 *
 * This integration adapts BuilderBot's patterns for the Gentle Dot ecosystem.
 * The MIT License notice for BuilderBot:
 *
 * MIT License
 *
 * Copyright (c) 2022-present Jhonny Fernando
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { mkdirSync, existsSync, readFileSync, statSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, extname } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { UploadedFile, AttachmentRef } from "@gentle-dot/protocol";
import type { WebSocket } from "ws";

// MIME type mapping for file extensions
const MIME_MAP: Record<string, string> = {
	".jpg": "image/jpeg", ".jpeg": "image/jpeg",
	".png": "image/png",
	".gif": "image/gif",
	".webp": "image/webp",
	".mp4": "video/mp4",
	".mov": "video/quicktime",
	".mp3": "audio/mpeg",
	".ogg": "audio/ogg",
	".wav": "audio/wav",
	".pdf": "application/pdf",
	".doc": "application/msword",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".xls": "application/vnd.ms-excel",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/**
 * Configuración del bridge WhatsApp -> Gentle Dot
 */
export interface WhatsAppBridgeConfig {
	/** URL base del daemon Gentle Dot (ej: http://127.0.0.1:4317) */
	daemonUrl: string;
	/** Token de acceso del daemon */
	accessToken: string;
	/** Origen permitido para CORS */
	origin: string;
	/** Directorio temporal para archivos descargados */
	tempDir?: string;
	/** Límite de tamaño de archivo en bytes (default: 100MB) */
	maxFileSize?: number;
	/** Límite de imagen para modelos (default: 3.75MB) */
	maxImageSize?: number;
	/** Número de reintentos para upload */
	uploadRetries?: number;
	/** Timeout para requests HTTP (ms) */
	httpTimeout?: number;
}

/**
 * Metadatos de un archivo subido
 */
export interface UploadedFileInfo {
	uploadId: string;
	name: string;
	size: number;
	mime: string;
	path: string;
}

/**
 * Mapeo de sesión WhatsApp -> sesión Gentle Dot
 */
interface SessionMapping {
	waChatId: string;
	gentleDotSessionId?: string;
	uploadId?: string;
	lastActivity: number;
}

/**
 * Bridge WhatsApp (Baileys/BuilderBot) -> Gentle Dot
 *
 * Flujo:
 * 1. Recibe mensaje de WhatsApp (texto, imagen, video, audio, documento)
 * 2. Si tiene media: descarga -> sube a /upload -> obtiene uploadId
 * 3. Envía mensaje al daemon via WebSocket con attachments
 * 4. Mantiene mapping de chat WhatsApp -> sesión Gentle Dot
 */
export class WhatsAppBridge {
	private client: {
		on(event: string, handler: (...args: never[]) => void): void;
		initialize(): Promise<void>;
		close(): Promise<void>;
		sendMessage(chatId: string, text: string): Promise<unknown>;
		downloadMedia(msg: unknown): Promise<{ data: string; mimetype?: string; filename?: string } | null>;
	};
	private config: Required<WhatsAppBridgeConfig>;
	private sessionMap: Map<string, SessionMapping> = new Map();
	private ws: WebSocket | null = null;
	private wsReconnectTimer: NodeJS.Timeout | null = null;

	constructor(config: WhatsAppBridgeConfig) {
		this.config = {
			daemonUrl: config.daemonUrl,
			accessToken: config.accessToken,
			origin: config.origin,
			tempDir: config.tempDir ?? join(tmpdir(), "gentle-dot-whatsapp"),
			maxFileSize: config.maxFileSize ?? 100 * 1024 * 1024, // 100MB
			maxImageSize: config.maxImageSize ?? 3_750_000, // 3.75MB
			uploadRetries: config.uploadRetries ?? 3,
			httpTimeout: config.httpTimeout ?? 30000,
		};

		// Asegurar directorio temporal
		if (!existsSync(this.config.tempDir)) {
			mkdirSync(this.config.tempDir, { recursive: true });
		}

		// Placeholder client until initClient() replaces it with the real one (or a mock)
		this.client = this.mockClient();
	}

	/**
	 * Inicializa el bridge: carga BuilderBot (opcional), conecta WebSocket al daemon
	 */
	async start(): Promise<void> {
		await this.initClient();
		await this.connectWebSocket();
		await this.client.initialize();

		// Limpieza periódica de archivos temporales antiguos
		setInterval(() => this.cleanupTempFiles(), 5 * 60 * 1000);
	}

	/**
	 * Carga @builderbot/bot dinámicamente (dependencia opcional).
	 * Si no está instalado, usa un mock client inerte y reporta un warning.
	 */
	private async initClient(): Promise<void> {
		try {
			const { createClient, MemoryStorage } = await import("@builderbot/bot");
			this.client = createClient({
				storage: new MemoryStorage(),
			});
			this.setupEventHandlers();
		} catch {
			console.warn(
				"[WhatsAppBridge] @builderbot/bot not installed. WhatsApp bridge will not work unless installed.",
			);
			this.client = this.mockClient();
		}
	}

	/**
	 * Mock client para cuando @builderbot/bot no está instalado
	 */
	private mockClient(): WhatsAppBridge["client"] {
		return {
			on: () => {},
			initialize: async () => {},
			close: async () => {},
			sendMessage: async () => {},
			downloadMedia: async () => null,
		};
	}

	/**
	 * Conecta WebSocket al daemon Gentle Dot
	 */
	private async connectWebSocket(): Promise<void> {
		const { default: WebSocket } = await import("ws");
		const wsUrl = `${this.config.daemonUrl.replace("http", "ws")}/ws`;
		this.ws = new WebSocket(wsUrl);

		this.ws.on("open", () => {
			console.log("[WhatsAppBridge] WebSocket conectado al daemon");
			this.ws?.send(
				JSON.stringify({
					type: "hello",
					token: this.config.accessToken,
					protocol: 1,
				}),
			);
		});

		this.ws.on("message", (data: unknown) => {
			this.handleDaemonMessage(String(data));
		});

		this.ws.on("close", () => {
			console.log("[WhatsAppBridge] WebSocket cerrado, reintentando en 5s...");
			this.scheduleReconnect();
		});

		this.ws.on("error", (err: Error) => {
			console.error("[WhatsAppBridge] Error WebSocket:", err);
		});
	}

	private scheduleReconnect(): void {
		if (this.wsReconnectTimer) clearTimeout(this.wsReconnectTimer);
		this.wsReconnectTimer = setTimeout(() => this.connectWebSocket(), 5000);
	}

	/**
	 * Maneja mensajes entrantes del daemon
	 */
	private handleDaemonMessage(data: string): void {
		try {
			const msg = JSON.parse(data) as { type?: string; text?: string };
			switch (msg.type) {
				case "ready":
					console.log("[WhatsAppBridge] Daemon listo");
					break;
				case "message":
					this.broadcastToWhatsApp(msg.text ?? "");
					break;
				case "error":
					console.error("[WhatsAppBridge] Error del daemon:", msg);
					break;
			}
		} catch (err) {
			console.error("[WhatsAppBridge] Error parseando mensaje daemon:", err);
		}
	}

	/**
	 * Configura handlers de eventos de Baileys
	 */
	private setupEventHandlers(): void {
		// Mensaje entrante de WhatsApp
		this.client.on("message", async (...args: never[]) => {
			const msg = args[0] as unknown as {
				from: string;
				body?: string;
				hasMedia: boolean;
				downloadMedia(): Promise<{ data: string; mimetype?: string; filename?: string } | null>;
			};
			try {
				await this.handleIncomingMessage(msg);
			} catch (err) {
				console.error("[WhatsAppBridge] Error manejando mensaje:", err);
			}
		});

		// QR code para autenticación
		this.client.on("qr", (qr: string) => {
			console.log("[WhatsAppBridge] QR Code recibido - escanea con WhatsApp:");
			console.log(qr);
		});

		// Listo
		this.client.on("ready", () => {
			console.log("[WhatsAppBridge] Cliente Baileys listo");
		});

		// Desconexión
		this.client.on("disconnected", (reason: string) => {
			console.log("[WhatsAppBridge] Baileys desconectado:", reason);
		});
	}

	/**
	 * Maneja mensaje entrante de WhatsApp
	 */
	private async handleIncomingMessage(msg: {
		from: string;
		body?: string;
		hasMedia: boolean;
		downloadMedia(): Promise<{ data: string; mimetype?: string; filename?: string } | null>;
	}): Promise<void> {
		const chatId = msg.from;
		this.getOrCreateSession(chatId);

		// Si es comando especial del bridge
		if (msg.body?.startsWith("!gentle ")) {
			await this.handleBridgeCommand(msg.from, msg.body);
			return;
		}

		// Preparar attachments si hay media
		const attachments: Array<{ uploadId: string; name: string }> = [];

		if (msg.hasMedia) {
			try {
				const media = await msg.downloadMedia();
				if (media?.data) {
					const fileInfo = await this.uploadMedia(media);
					if (fileInfo) {
						attachments.push({ uploadId: fileInfo.uploadId, name: fileInfo.name });
					}
				}
			} catch (err) {
				console.error("[WhatsAppBridge] Error procesando media:", err);
				await this.sendToWhatsApp(chatId, "Error procesando el archivo adjunto");
			}
		}

		// Enviar al daemon via WebSocket
		const payload = {
			type: "send",
			text: msg.body ?? "",
			attachments,
			requestId: randomUUID(),
		};

		this.sendToDaemon(payload);
	}

	/**
	 * Sube media al endpoint /upload del daemon con reintentos
	 */
	private async uploadMedia(media: {
		data: string;
		mimetype?: string;
		filename?: string;
	}): Promise<UploadedFileInfo | null> {
		const mimeType = media.mimetype ?? this.guessMimeType(media.filename);
		const fileName = media.filename ?? `whatsapp_${Date.now()}${this.guessExtension(mimeType)}`;
		const buffer = Buffer.from(media.data, "base64");

		// Validar tamaño
		if (buffer.length > this.config.maxFileSize) {
			throw new Error(`Archivo demasiado grande: ${buffer.length} bytes (máx: ${this.config.maxFileSize})`);
		}

		if (mimeType.startsWith("image/") && buffer.length > this.config.maxImageSize) {
			console.warn(`[WhatsAppBridge] Imagen grande (${buffer.length} bytes), considerar compresión`);
		}

		// Guardar archivo temporal
		const tempPath = join(this.config.tempDir, `wa_${Date.now()}_${randomUUID()}`);
		writeFileSync(tempPath, buffer);

		// Upload con reintentos y backoff exponencial
		let lastError: Error | null = null;
		for (let attempt = 1; attempt <= this.config.uploadRetries; attempt++) {
			try {
				const uploadId = randomUUID();
				const response = await this.httpUpload({
					uploadId,
					fileName,
					filePath: tempPath,
				});

				this.safeUnlink(tempPath);
				return response;
			} catch (err) {
				lastError = err as Error;
				console.warn(`[WhatsAppBridge] Upload intento ${attempt} falló:`, err);
				if (attempt < this.config.uploadRetries) {
					await new Promise((r) => setTimeout(r, 1000 * attempt));
				}
			}
		}

		this.safeUnlink(tempPath);
		throw lastError ?? new Error("Upload falló después de reintentos");
	}

	/**
	 * Realiza el HTTP POST a /upload
	 */
	private async httpUpload(params: {
		uploadId: string;
		fileName: string;
		filePath: string;
	}): Promise<UploadedFileInfo> {
		const body = readFileSync(params.filePath);

		const response = await fetch(`${this.config.daemonUrl}/upload`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.config.accessToken}`,
				Origin: this.config.origin,
				"Content-Type": "application/octet-stream",
				"X-File-Name": encodeURIComponent(params.fileName),
				"X-Upload-Id": params.uploadId,
			},
			body,
		});

		if (!response.ok) {
			const error = (await response.json().catch(() => ({ code: "unknown", message: response.statusText }))) as {
				code: string;
				message: string;
			};
			throw new Error(`Upload failed: ${error.code} - ${error.message}`);
		}

		const result = (await response.json()) as { file: UploadedFileInfo };
		return result.file;
	}

	/**
	 * Envía mensaje al daemon via WebSocket
	 */
	private sendToDaemon(payload: object): void {
		if (this.ws?.readyState === 1) {
			this.ws.send(JSON.stringify(payload));
		} else {
			console.warn("[WhatsAppBridge] WebSocket no conectado, mensaje descartado");
		}
	}

	/**
	 * Envía mensaje a un chat de WhatsApp
	 */
	private async sendToWhatsApp(chatId: string, text: string): Promise<void> {
		try {
			await this.client.sendMessage(chatId, text);
		} catch (err) {
			console.error("[WhatsAppBridge] Error enviando a WhatsApp:", err);
		}
	}

	/**
	 * Broadcast a todas las sesiones activas (respuestas del asistente)
	 */
	private async broadcastToWhatsApp(text: string): Promise<void> {
		for (const [chatId] of this.sessionMap) {
			await this.sendToWhatsApp(chatId, text);
		}
	}

	/**
	 * Maneja comandos del bridge (!gentle ...)
	 */
	private async handleBridgeCommand(chatId: string, body: string): Promise<void> {
		const args = body.slice(8).trim().split(" ");
		const cmd = args[0]?.toLowerCase();

		switch (cmd) {
			case "session":
				await this.sendToWhatsApp(
					chatId,
					`Sesión actual: ${this.sessionMap.get(chatId)?.gentleDotSessionId ?? "ninguna"}`,
				);
				break;
			case "reset":
				this.sessionMap.delete(chatId);
				await this.sendToWhatsApp(chatId, "Sesión reiniciada");
				break;
			case "help":
				await this.sendToWhatsApp(
					chatId,
					"Comandos disponibles:\n" +
						"!gentle session - Ver sesión actual\n" +
						"!gentle reset - Reiniciar sesión\n" +
						"!gentle help - Esta ayuda",
				);
				break;
			default:
				await this.sendToWhatsApp(chatId, `Comando desconocido: ${cmd}. Usa !gentle help`);
		}
	}

	/**
	 * Obtiene o crea mapeo de sesión
	 */
	private getOrCreateSession(chatId: string): SessionMapping {
		let session = this.sessionMap.get(chatId);
		if (!session) {
			session = {
				waChatId: chatId,
				lastActivity: Date.now(),
			};
			this.sessionMap.set(chatId, session);
		}
		session.lastActivity = Date.now();
		return session;
	}

	/**
	 * Limpia archivos temporales antiguos (>24h)
	 */
	private cleanupTempFiles(): void {
		if (!existsSync(this.config.tempDir)) return;

		const now = Date.now();

		try {
			const files = readdirSync(this.config.tempDir);
			for (const file of files) {
				const filePath = join(this.config.tempDir, file);
				const stats = statSync(filePath);
				if (now - stats.mtimeMs > 24 * 60 * 60 * 1000) {
					unlinkSync(filePath);
				}
			}
		} catch (err) {
			console.warn("[WhatsAppBridge] Error limpiando temp:", err);
		}
	}

	private safeUnlink(path: string): void {
		try {
			if (existsSync(path)) unlinkSync(path);
		} catch {
			// ignore
		}
	}

	private guessMimeType(filename?: string): string {
		if (!filename) return "application/octet-stream";
		const ext = extname(filename).toLowerCase();
		return MIME_MAP[ext] ?? "application/octet-stream";
	}

	private guessExtension(mimeType: string): string {
		for (const [ext, mime] of Object.entries(MIME_MAP)) {
			if (mime === mimeType) return ext;
		}
		return ".bin";
	}

	/**
	 * Detiene el bridge
	 */
	async stop(): Promise<void> {
		if (this.wsReconnectTimer) clearTimeout(this.wsReconnectTimer);
		if (this.ws) this.ws.close();
		await this.client.close();
		console.log("[WhatsAppBridge] Detenido");
	}
}

/**
 * Factory para crear bridge con configuración por defecto
 */
export function createWhatsAppBridge(daemonUrl: string, accessToken: string, origin: string): WhatsAppBridge {
	return new WhatsAppBridge({ daemonUrl, accessToken, origin });
}

export default WhatsAppBridge;
