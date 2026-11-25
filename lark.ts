/**
 * Lark（飞书）连接器，给 Pi Pocket 自带的 Relay 用：别人在飞书里私聊应用机器人，消息进入会话，Pi 的回复发回同一个单聊。
 *
 * 收消息走 lark-cli 的本地事件总线（长连接，不需要公网地址），凭证留在 lark-cli 自己的配置里；围栏、只投递一次、
 * 限流、磁盘队列和重试都是 Relay 的事。群聊、图片和文件还没有接。
 */
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { createInterface } from "node:readline";
import type { Web } from "./_pocket.d.ts";

export const KIND = "lark";

const DEFAULT_BINARY = "lark-cli";
const DEFAULT_MAX_CHARS = 3000;
const KEY_LIMIT = 50;

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
    interval?: number;
    mentions?: boolean;
    idempotentReply?: boolean;
    check?(values: RelayValues): string | undefined;
    poll?(context: RelayContext): Promise<void>;
    run?(context: RelayContext): Promise<void>;
    reply?(
        context: Pick<RelayContext, "values" | "signal" | "log">,
        reply: RelayReply,
    ): Promise<{ id?: string } | void>;
}

interface RelayService {
    api: number;
    register(connector: RelayConnector): () => void;
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

export function eventOf(raw: unknown, chats: ReadonlySet<string>): RelayEvent | undefined {
    const item = record(raw);

    if (item === undefined) {
        return undefined;
    }

    const id = text(item.message_id) ?? text(item.id);
    const chat = text(item.chat_id);

    if (id === undefined || chat === undefined || chats.size > 0 && !chats.has(chat)) {
        return undefined;
    }

    if (item.chat_type !== "p2p" || item.sender_type !== "user") {
        return undefined;
    }

    const kind = text(item.message_type) ?? "text";
    const at = Number(item.create_time);
    const thread = text(item.thread_id);
    const event: RelayEvent = {
        id,
        text: typeof item.content === "string" ? item.content : "",
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
        event.attachments = [kind];
    }

    return event;
}

export function parseEventLine(line: string, chats: ReadonlySet<string>): RelayEvent | undefined {
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

    return eventOf(raw, chats);
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

function answer(stdout: string, stderr: string): string | undefined {
    let parsed: unknown;

    try {
        parsed = JSON.parse(stdout.trim());
    } catch {
        return undefined;
    }

    const body = record(parsed);
    const error = record(body?.error);
    const message = text(error?.message) ?? text(body?.error);

    if (body?.ok === true) {
        const data = record(body.data);

        return text(data?.message_id);
    }

    return message ?? stderr.trim().split("\n").at(-1);
}

function send(
    values: RelayValues,
    signal: AbortSignal,
    target: string,
    body: string,
    key: string,
): Promise<string | undefined> {
    const args = [
        "im",
        "+messages-reply",
        "--message-id",
        target,
        "--as",
        "bot",
        "--markdown",
        "-",
        "--idempotency-key",
        key,
        "--format",
        "json",
        ...profileArgs(values),
    ];
    const child = spawn(binary(values), args, { stdio: ["pipe", "pipe", "pipe"] });
    const stop = () => child.kill("SIGTERM");
    signal.addEventListener("abort", stop, { once: true });
    child.stdin.end(body);

    return new Promise<string | undefined>((resolve, reject) => {
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
                reject(new Error("回复被停止。"));
                return;
            }

            const problem = failure === undefined ? (code === 0 ? undefined : answer(stdout, stderr) ?? `lark-cli 退出（code ${code}）。`) : failure.message;

            if (problem !== undefined) {
                reject(new Error(`飞书没有收下这条回复：${problem}`));
                return;
            }

            resolve(answer(stdout, stderr));
        });
    });
}

function lark(): RelayConnector {
    return {
        kind: KIND,
        label: "Lark",
        description: "飞书里的单聊：别人私聊应用机器人，消息进入会话，Pi 的回答回到同一个单聊。",
        shape: "stream",
        idempotentReply: true,
        fields: [
            { name: "binary", label: "lark-cli", type: "text", default: DEFAULT_BINARY },
            { name: "profile", label: "Profile", type: "text", placeholder: "default" },
            {
                name: "chats",
                label: "Chats",
                type: "text",
                description: "只接这些 oc_ 单聊，逗号分隔；留空接全部。",
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

            return wrong === undefined ? undefined : `"${wrong}" 不是飞书单聊 id，它以 oc_ 开头。`;
        },
        async run(context) {
            const args = [
                "event",
                "consume",
                "im.message.receive_v1",
                "--as",
                "bot",
                ...profileArgs(context.values),
            ];
            const chats = new Set(words(context.values.chats));
            const child = spawn(binary(context.values), args, { stdio: ["pipe", "pipe", "pipe"] });

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
                    const event = parseEventLine(line, chats);

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

            if (context.signal.aborted) {
                return;
            }

            if (failure !== undefined) {
                throw failure;
            }

            if (code === 0) {
                throw new Error("lark-cli 的收消息进程结束了（code 0）。");
            }

            const said = tail.trim().split("\n").filter((line) => line !== "");
            const interesting = said.filter(
                (line) => /reason|error|fail|refus|denied|scope|expired/i.test(line),
            );
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

            if (parts.length === 0) {
                throw new Error("回复是空的。");
            }

            let id: string | undefined;

            for (const [index, part] of parts.entries()) {
                id = (await send(context.values, context.signal, target, part, replyKey(reply.key, index))) ?? id;
            }

            return id === undefined ? undefined : { id };
        },
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
