/**
 * Lark（飞书）连接器，给 Pi Pocket 自带的 Relay 用：私聊或群里 @ 机器人的消息进入会话，Pi 的回复回到原处；
 * 图片和文件可以下载给 Pi 看。
 *
 * 收消息走 lark-cli 的本地事件总线（长连接，不需要公网地址），凭证留在 lark-cli 自己的配置里；围栏、只投递一次、
 * 限流、磁盘队列和重试都是 Relay 的事。Pi 还不能往飞书发图片或文件。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import type { Web } from "./_pocket.d.ts";

export const KIND = "lark";

const DEFAULT_BINARY = "lark-cli";
const DEFAULT_MAX_CHARS = 3000;
const KEY_LIMIT = 50;
const MAX_FILE_BYTES = 30 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_SENT_FILES = 10;
const FILE_KEY_BASE = 100;
const KIND_ONLY = new Set(["image", "file", "audio", "video", "media", "sticker"]);

type RelayValues = Readonly<Record<string, string | number | boolean | undefined>>;

interface RelayField {
    name: string;
    label: string;
    type: "text" | "secret" | "number" | "boolean" | "choice" | "textarea";
    description?: string;
    placeholder?: string;
    default?: string | number | boolean;
    required?: boolean;
    min?: number;
    max?: number;
    multiline?: boolean;
}

interface RelayAuthor {
    id: string;
    name: string;
    bot?: boolean;
}

interface RelayFile {
    name: string;
    type?: string;
    size?: number;
    ref: string;
}

interface RelayEvent {
    id: string;
    text: string;
    author: RelayAuthor;
    channel?: string;
    channelName?: string;
    thread?: string;
    mentioned?: boolean;
    at?: number;
    url?: string;
    attachments?: readonly string[];
    files?: readonly RelayFile[];
}

interface RelayContext {
    readonly values: RelayValues;
    readonly state: Readonly<Record<string, unknown>>;
    save(state: Record<string, unknown>): void;
    emit(events: readonly RelayEvent[]): Promise<void>;
    readonly signal: AbortSignal;
    status(text: string): void;
    log(text: string): void;
    sleep(ms: number): Promise<void>;
}

type ShortContext = Pick<RelayContext, "values" | "signal" | "log">;

interface RelayReply {
    text: string;
    to?: RelayEvent;
    channel?: string;
    thread?: string;
    key: string;
    files?: readonly { name: string; type: string; data: Uint8Array }[];
}

interface RelayConnector {
    kind: string;
    label: string;
    description?: string;
    fields: readonly RelayField[];
    shape: "poll" | "stream";
    files?: { max: number; maxBytes: number };
    interval?: number;
    mentions?: boolean;
    idempotentReply?: boolean;
    check?(values: RelayValues): string | undefined;
    poll?(context: RelayContext): Promise<void>;
    run?(context: RelayContext): Promise<void>;
    reply?(context: ShortContext, reply: RelayReply): Promise<{ id?: string } | void>;
    fetch?(context: ShortContext, file: RelayFile, maxBytes: number): Promise<{ data: Uint8Array; type: string }>;
}

interface RelayService {
    api: number;
    register(connector: RelayConnector): () => void;
}

export interface Rules {
    readonly chats?: ReadonlySet<string>;
    readonly groups?: boolean;
    readonly botId?: string;
    readonly botName?: string;
}

interface Command {
    readonly code: number | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly failure?: Error;
}

function record(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function text(value: unknown): string | undefined {
    return typeof value === "string" && value !== "" ? value : undefined;
}

export function words(value: unknown): string[] {
    return String(value ?? "")
        .split(/[\s,]+/)
        .filter((word) => word !== "");
}

function mentioned(item: Record<string, unknown>, rules: Rules): boolean {
    const list = Array.isArray(item.mentions) ? item.mentions : [];

    return list.some((each) => {
        const entry = record(each);
        const id = text(entry?.id);
        const name = text(entry?.name);

        return (rules.botId !== undefined && id === rules.botId) || (rules.botName !== undefined && name === rules.botName);
    });
}

export function resourcesOf(content: string, messageId: string): RelayFile[] {
    const files: RelayFile[] = [];

    for (const match of content.matchAll(/img_[0-9A-Za-z_-]+/g)) {
        files.push({ name: "image", ref: `${messageId}|image|${match[0]}` });
    }

    for (const match of content.matchAll(/key="(file_[^"]+)"(?:[^>]*?\bname="([^"]*)")?/g)) {
        files.push({
            name: match[2] === undefined || match[2] === "" ? "file" : match[2],
            ref: `${messageId}|file|${match[1]}`,
        });
    }

    return files;
}

export function refOf(ref: string): { messageId: string; kind: "image" | "file"; key: string } | undefined {
    const [messageId, kind, key] = ref.split("|");

    if (messageId === undefined || messageId === "" || key === undefined || key === "") {
        return undefined;
    }

    if (kind !== "image" && kind !== "file") {
        return undefined;
    }

    return { messageId, kind, key };
}

function looksText(data: Uint8Array): boolean {
    const head = data.subarray(0, 512);

    if (head.includes(0)) {
        return false;
    }

    try {
        new TextDecoder("utf-8", { fatal: true }).decode(head);
        return true;
    } catch {
        return false;
    }
}

export function safeName(name: string): string {
    const base = name.split(/[\\/]/).at(-1) ?? "";
    const cleaned = base
        .replace(/[\u0000-\u001f:<>"|?*]+/g, "_")
        .replace(/^\.+/, "")
        .trim()
        .slice(0, 80);

    return cleaned === "" ? "file" : cleaned;
}

export function mimeOf(data: Uint8Array, name: string): string {
    const head = Array.from(data.subarray(0, 12), (byte) => byte.toString(16).padStart(2, "0")).join("");

    if (head.startsWith("89504e47")) {
        return "image/png";
    }

    if (head.startsWith("ffd8ff")) {
        return "image/jpeg";
    }

    if (head.startsWith("47494638")) {
        return "image/gif";
    }

    if (head.startsWith("52494646") && head.slice(16, 24) === "57454250") {
        return "image/webp";
    }

    if (head.startsWith("25504446")) {
        return "application/pdf";
    }

    if (looksText(data)) {
        return "text/plain";
    }

    const extension = name.toLowerCase().split(".").at(-1) ?? "";
    const byExtension: Record<string, string> = {
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        gif: "image/gif",
        webp: "image/webp",
        pdf: "application/pdf",
        txt: "text/plain",
        md: "text/markdown",
        json: "application/json",
        csv: "text/csv",
        zip: "application/zip",
        opus: "audio/opus",
        mp3: "audio/mpeg",
        mp4: "video/mp4",
    };

    return byExtension[extension] ?? "application/octet-stream";
}

export function attachmentKind(file: { name: string; data: Uint8Array }): "image" | "file" {
    return mimeOf(file.data, file.name).startsWith("image/") ? "image" : "file";
}

export function eventOf(raw: unknown, rules: Rules): RelayEvent | undefined {
    const item = record(raw);

    if (item === undefined) {
        return undefined;
    }

    const id = text(item.message_id) ?? text(item.id);
    const chat = text(item.chat_id);

    if (id === undefined || chat === undefined) {
        return undefined;
    }

    if (rules.chats !== undefined && rules.chats.size > 0 && !rules.chats.has(chat)) {
        return undefined;
    }

    if (item.sender_type !== "user") {
        return undefined;
    }

    if (item.chat_type === "group") {
        if (rules.groups !== true || !mentioned(item, rules)) {
            return undefined;
        }
    } else if (item.chat_type !== "p2p") {
        return undefined;
    }

    const kind = text(item.message_type) ?? "text";
    const content = typeof item.content === "string" ? item.content : "";
    const at = Number(item.create_time);
    const thread = text(item.thread_id);
    const files = kind === "text" ? [] : resourcesOf(content, id);
    const event: RelayEvent = {
        id,
        text: KIND_ONLY.has(kind) ? "" : content,
        author: { id: text(item.sender_id) ?? chat, name: text(item.sender_id) ?? chat, bot: false },
        channel: chat,
        mentioned: true,
    };

    if (thread !== undefined) {
        event.thread = thread;
    }

    if (Number.isFinite(at)) {
        event.at = at;
    }

    if (kind !== "text") {
        event.attachments = files.length > 0 ? files.map((file) => `${kind} ${file.name}`) : [kind];
    }

    if (files.length > 0) {
        event.files = files;
    }

    return event;
}

export function parseEventLine(line: string, rules: Rules): RelayEvent | undefined {
    const trimmed = line.trim();

    if (!trimmed.startsWith("{")) {
        return undefined;
    }

    let raw: unknown;

    try {
        raw = JSON.parse(trimmed);
    } catch {
        return undefined;
    }

    return eventOf(raw, rules);
}

export function splitText(value: string, max: number): string[] {
    const whole = value.trim();

    if (whole === "") {
        return [];
    }

    const parts: string[] = [];
    let rest = whole;

    while (rest.length > max) {
        let cut = rest.lastIndexOf("\n\n", max);

        if (cut < max / 2) {
            cut = rest.lastIndexOf("\n", max);
        }

        if (cut < max / 2) {
            cut = max;
        }

        parts.push(rest.slice(0, cut).trimEnd());
        rest = rest.slice(cut).trimStart();
    }

    if (rest !== "") {
        parts.push(rest);
    }

    return parts;
}

export function replyKey(key: string, index: number): string {
    let hash = 2166136261;

    for (const character of key) {
        hash ^= character.codePointAt(0) ?? 0;
        hash = Math.imul(hash, 16777619);
    }

    return `lark-${(hash >>> 0).toString(16)}-${index}`.slice(0, KEY_LIMIT);
}

function binary(values: RelayValues): string {
    return String(text(values.binary) ?? DEFAULT_BINARY);
}

function profileArgs(values: RelayValues): string[] {
    const profile = text(values.profile);

    return profile === undefined ? [] : ["--profile", profile];
}

function runCli(
    values: RelayValues,
    args: string[],
    signal: AbortSignal,
    options: { input?: string; cwd?: string } = {},
): Promise<Command> {
    const child = spawn(binary(values), [...args, ...profileArgs(values)], {
        stdio: ["pipe", "pipe", "pipe"],
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    });
    const stop = () => child.kill("SIGTERM");
    signal.addEventListener("abort", stop, { once: true });

    const input = options.input;

    if (input === undefined) {
        child.stdin.destroy();
    } else {
        child.stdin.end(input);
    }

    return new Promise<Command>((resolve, reject) => {
        let stdout = "";
        let stderr = "";
        let failure: Error | undefined;

        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
            stdout += chunk;
        });
        child.stderr.on("data", (chunk: string) => {
            stderr += chunk;
        });
        child.once("error", (error) => {
            failure = error;
        });
        child.once("close", (code) => {
            signal.removeEventListener("abort", stop);

            if (signal.aborted) {
                reject(new Error("命令被停止。"));
                return;
            }

            resolve({ code, stdout, stderr, failure });
        });
    });
}

function reasonOf(command: Command): string | undefined {
    let parsed: unknown;

    try {
        parsed = JSON.parse(command.stdout.trim());
    } catch {
        parsed = undefined;
    }

    const body = record(parsed);
    const error = record(body?.error);
    const said = command.stderr
        .trim()
        .split("\n")
        .filter((line) => line !== "");
    const interesting = said.filter((line) => /reason|error|fail|refus|denied|scope|expired/i.test(line));

    return (
        text(error?.message) ??
        (interesting.length > 0 ? interesting : said).slice(-2).join(" ") ??
        undefined
    );
}

function savedPath(stdout: string): string | undefined {
    let parsed: unknown;

    try {
        parsed = JSON.parse(stdout.trim());
    } catch {
        return undefined;
    }

    const data = record(record(parsed)?.data);

    return text(data?.saved_path);
}

function messageId(command: Command): string | undefined {
    let parsed: unknown;

    try {
        parsed = JSON.parse(command.stdout.trim());
    } catch {
        return undefined;
    }

    const body = record(parsed);
    const data = record(body?.data);

    return body?.ok === true ? text(data?.message_id) : undefined;
}

async function botOf(values: RelayValues, signal: AbortSignal): Promise<{ id?: string; name?: string }> {
    const command = await runCli(
        values,
        ["api", "GET", "/open-apis/bot/v3/info", "--as", "bot", "--format", "json"],
        signal,
    );

    if (command.code !== 0) {
        return {};
    }

    let parsed: unknown;

    try {
        parsed = JSON.parse(command.stdout.trim());
    } catch {
        return {};
    }

    const data = record(record(parsed)?.data);

    return { id: text(data?.open_id), name: text(data?.app_name) };
}

async function fetchFile(
    context: ShortContext,
    file: RelayFile,
    maxBytes: number,
): Promise<{ data: Uint8Array; type: string }> {
    const parts = refOf(file.ref);

    if (parts === undefined) {
        throw new Error("这个附件没有可用的标识。");
    }

    const folder = mkdtempSync(join(tmpdir(), "lark-relay-"));

    try {
        const name = file.name.replace(/[^\w.-]+/g, "_").slice(0, 60) || "resource";
        const output = join(folder, name);
        const command = await runCli(
            context.values,
            [
                "im",
                "+messages-resources-download",
                "--message-id",
                parts.messageId,
                "--file-key",
                parts.key,
                "--type",
                parts.kind,
                "--output",
                output,
                "--as",
                "bot",
                "--format",
                "json",
            ],
            context.signal,
        );

        if (command.code !== 0) {
            throw new Error(`飞书没有给出这个附件：${reasonOf(command) ?? "没有说明"}`);
        }

        const saved = savedPath(command.stdout) ?? output;

        if (!resolve(saved).startsWith(resolve(folder) + sep)) {
            throw new Error("lark-cli 把附件存到了别处。");
        }

        const size = statSync(saved).size;

        if (size > maxBytes) {
            throw new Error(`这个附件有 ${size} 字节，超过上限 ${maxBytes} 字节。`);
        }

        const data = readFileSync(saved);

        return { data, type: mimeOf(data, basename(saved)) };
    } finally {
        rmSync(folder, { recursive: true, force: true });
    }
}

function lark(): RelayConnector {
    return {
        kind: KIND,
        label: "Lark",
        description: "飞书：私聊机器人，或在群里 @ 机器人。图片和文件两边都能带。",
        shape: "stream",
        mentions: true,
        idempotentReply: true,
        files: { max: MAX_SENT_FILES, maxBytes: MAX_FILE_BYTES },
        fields: [
            { name: "binary", label: "lark-cli", type: "text", default: DEFAULT_BINARY },
            { name: "profile", label: "Profile", type: "text", placeholder: "default" },
            {
                name: "chats",
                label: "Chats",
                type: "text",
                description: "只接这些 oc_ 会话，逗号分隔；留空接全部。",
            },
            {
                name: "groups",
                label: "群聊",
                type: "boolean",
                default: true,
                description: "关掉就只接私聊。",
            },
            {
                name: "max_chars",
                label: "回答的字数上限",
                type: "number",
                default: DEFAULT_MAX_CHARS,
                min: 200,
                max: 8000,
            },
        ],
        check(values) {
            const wrong = words(values.chats).find((chat) => !/^oc_[0-9A-Za-z]+$/.test(chat));

            return wrong === undefined ? undefined : `"${wrong}" 不是飞书会话 id，它以 oc_ 开头。`;
        },
        async run(context) {
            const chats = new Set(words(context.values.chats));
            const groups = context.values.groups === undefined ? true : context.values.groups === true;
            const bot = groups ? await botOf(context.values, context.signal) : {};

            if (groups && bot.id === undefined && bot.name === undefined) {
                context.log("没有取到机器人的身份：群里 @ 机器人的消息不会进来。");
            }

            const rules: Rules = { chats, groups, botId: bot.id, botName: bot.name };
            const args = ["event", "consume", "im.message.receive_v1", "--as", "bot"];
            const child = spawn(binary(context.values), [...args, ...profileArgs(context.values)], {
                stdio: ["pipe", "pipe", "pipe"],
            });

            if (child.stdout === null || child.stderr === null) {
                throw new Error("lark-cli 没有给出输出。");
            }

            const stop = () => {
                child.stdin.destroy();
                child.kill("SIGTERM");
            };
            context.signal.addEventListener("abort", stop, { once: true });
            context.status("正在连接");

            let tail = "";
            let failure: Error | undefined;

            child.stderr.setEncoding("utf8");
            child.stderr.on("data", (chunk: string) => {
                tail = (tail + chunk).slice(-2000);

                if (chunk.includes("connected") || chunk.includes("ready event_key=")) {
                    context.status("已连接");
                }
            });
            child.once("error", (error) => {
                failure = error;
            });

            const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
            const lines = createInterface({ input: child.stdout });
            const stopped = new Promise<void>((resolve) => {
                context.signal.addEventListener("abort", () => resolve(), { once: true });
            });
            const reading = (async () => {
                for await (const line of lines) {
                    const event = parseEventLine(line, rules);

                    if (event !== undefined) {
                        await context.emit([event]);
                    }
                }
            })();

            try {
                await Promise.race([reading, stopped]);
            } finally {
                context.signal.removeEventListener("abort", stop);
                lines.close();
            }

            if (context.signal.aborted) {
                child.stdout.destroy();
                return;
            }

            const code = await closed;

            if (failure !== undefined) {
                throw failure;
            }

            if (code === 0) {
                throw new Error("lark-cli 的收消息进程结束了（code 0）。");
            }

            const said = tail.trim().split("\n").filter((line) => line !== "");
            const interesting = said.filter((line) => /reason|error|fail|refus|denied|scope|expired/i.test(line));
            const why = (interesting.length > 0 ? interesting : said)
                .slice(-3)
                .join(" ")
                .slice(0, 400);

            throw new Error(`lark-cli 的收消息进程出错（code ${code}）${why === "" ? "。" : `：${why}`}`);
        },
        async reply(context, reply) {
            const target = reply.to?.id;

            if (target === undefined) {
                throw new Error("回复飞书需要 reply_to：给它那条消息的 id。");
            }

            const max = Number(context.values.max_chars ?? DEFAULT_MAX_CHARS);
            const parts = splitText(reply.text, Number.isFinite(max) && max > 0 ? max : DEFAULT_MAX_CHARS);
            const files = reply.files ?? [];

            if (parts.length === 0 && files.length === 0) {
                throw new Error("回复是空的。");
            }

            if (files.length > MAX_SENT_FILES) {
                throw new Error(`飞书一次最多发 ${MAX_SENT_FILES} 个文件。`);
            }

            let id: string | undefined;

            for (const [index, part] of parts.entries()) {
                const command = await runCli(
                    context.values,
                    [
                        "im",
                        "+messages-reply",
                        "--message-id",
                        target,
                        "--as",
                        "bot",
                        "--markdown",
                        "-",
                        "--idempotency-key",
                        replyKey(reply.key, index),
                        "--format",
                        "json",
                    ],
                    context.signal,
                    { input: part },
                );

                if (command.code !== 0) {
                    throw new Error(`飞书没有收下这条回复：${reasonOf(command) ?? `lark-cli 退出（code ${command.code}）`}`);
                }

                id = messageId(command) ?? id;
            }

            if (files.length === 0) {
                return id === undefined ? undefined : { id };
            }

            const folder = mkdtempSync(join(tmpdir(), "lark-send-"));

            try {
                for (const [index, file] of files.entries()) {
                    const name = safeName(file.name);
                    const kind = attachmentKind(file);
                    const size = file.data.length;

                    if (size > (kind === "image" ? MAX_IMAGE_BYTES : MAX_FILE_BYTES)) {
                        throw new Error(`"${name}" 有 ${size} 字节，超过飞书对${kind === "image" ? "图片" : "文件"}的上限。`);
                    }

                    writeFileSync(join(folder, name), file.data);

                    const command = await runCli(
                        context.values,
                        [
                            "im",
                            "+messages-reply",
                            "--message-id",
                            target,
                            "--as",
                            "bot",
                            `--${kind}`,
                            `./${name}`,
                            "--idempotency-key",
                            replyKey(reply.key, FILE_KEY_BASE + index),
                            "--format",
                            "json",
                        ],
                        context.signal,
                        { cwd: folder },
                    );

                    if (command.code !== 0) {
                        throw new Error(
                            `飞书没有收下 "${name}"：${reasonOf(command) ?? `lark-cli 退出（code ${command.code}）`}`,
                        );
                    }

                    id = messageId(command) ?? id;
                }
            } finally {
                rmSync(folder, { recursive: true, force: true });
            }

            return id === undefined ? undefined : { id };
        },
        fetch: fetchFile,
    };
}

export default function createLark(_host: unknown, web: Web): void {
    if (typeof web.use !== "function" || typeof web.onService !== "function") {
        return;
    }

    const waits = [250, 500, 1000, 2000, 4000, 8000, 15000];
    let remove: (() => void) | undefined;
    let attempt = 0;
    let stopped = false;

    const connect = async () => {
        remove?.();
        remove = undefined;

        while (!stopped) {
            const service = web.use("pocket-relay") as Partial<RelayService> | undefined;

            if (service?.api !== 1 || typeof service.register !== "function") {
                return;
            }

            try {
                remove = service.register(lark());
                attempt = 0;
                return;
            } catch {
                await delay(waits[Math.min(attempt, waits.length - 1)]);
                attempt += 1;
            }
        }
    };

    void connect();
    web.onService("pocket-relay", () => void connect());
    web.onDispose(() => {
        stopped = true;
        remove?.();
    });
}
