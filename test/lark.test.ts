import assert from "node:assert/strict";
import { test } from "node:test";
import {
    eventOf,
    mimeOf,
    parseEventLine,
    refOf,
    replyKey,
    resourcesOf,
    splitText,
    words,
} from "../lark.ts";

const NO_CHATS = new Set<string>();
const BOT = { id: "ou_0123456789abcdef0123456789abcdef", name: "测试助手" };

const PING = '{"type":"im.message.receive_v1","event_id":"0f0e0d0c0b0a09080706050403020100","timestamp":"1795580234859","id":"om_x100b7f525a6828accff04f86ab74a01","message_id":"om_x100b7f525a6828accff04f86ab74a01","create_time":"1795580234488","chat_id":"oc_0123456789abcdef0123456789abcdef","chat_type":"p2p","message_type":"text","sender_id":"ou_0123456789abcdef0123456789abcdef","sender_type":"user","content":"ping"}';

const RAW = JSON.parse(PING);
const GROUP = { ...RAW, chat_type: "group" };

test("a real direct message becomes an event", () => {
    assert.deepEqual(parseEventLine(PING, { chats: NO_CHATS }), {
        id: "om_x100b7f525a6828accff04f86ab74a01",
        text: "ping",
        author: { id: "ou_0123456789abcdef0123456789abcdef", name: "ou_0123456789abcdef0123456789abcdef", bot: false },
        channel: "oc_0123456789abcdef0123456789abcdef",
        mentioned: true,
        at: 1795580234488,
    });
});

test("lines that are not an event are dropped", () => {
    assert.equal(parseEventLine("", { chats: NO_CHATS }), undefined);
    assert.equal(parseEventLine("[event] ready event_key=im.message.receive_v1", { chats: NO_CHATS }), undefined);
    assert.equal(parseEventLine("{not json", { chats: NO_CHATS }), undefined);
    assert.equal(parseEventLine("{}", { chats: NO_CHATS }), undefined);
});

test("only a message from a person is taken", () => {
    assert.equal(eventOf({ ...RAW, sender_type: "app" }, { chats: NO_CHATS }), undefined);
    assert.equal(eventOf({ ...RAW, message_id: undefined, id: undefined }, { chats: NO_CHATS }), undefined);
    assert.equal(eventOf({ ...RAW, chat_id: undefined }, { chats: NO_CHATS }), undefined);
    assert.equal(eventOf({ ...RAW, chat_type: "topic" }, { chats: NO_CHATS }), undefined);
});

test("a chat list keeps only those chats", () => {
    const one = new Set(["oc_0123456789abcdef0123456789abcdef"]);

    assert.ok(eventOf(RAW, { chats: one }));
    assert.equal(eventOf(PING, { chats: new Set(["oc_other"]) }), undefined);
});

test("a group message comes only when it names the bot", () => {
    const rules = { chats: NO_CHATS, groups: true, botId: BOT.id, botName: BOT.name };

    assert.equal(eventOf(GROUP, rules), undefined);
    assert.equal(eventOf({ ...GROUP, mentions: [{ id: "ou_someone", name: "别人" }] }, rules), undefined);
    assert.ok(eventOf({ ...GROUP, mentions: [{ id: BOT.id, name: "whatever" }] }, rules));
    assert.ok(eventOf({ ...GROUP, mentions: [{ id: "ou_other", name: BOT.name }] }, rules));
    assert.equal(eventOf({ ...GROUP, mentions: [{ id: BOT.id, name: BOT.name }] }, { ...rules, groups: false }), undefined);
});

test("an image keeps a file to download and no key in the text", () => {
    const event = eventOf(
        { ...RAW, message_type: "image", content: "[Image: img_v3_0123abcd-4567]" },
        { chats: NO_CHATS },
    );

    assert.equal(event?.text, "");
    assert.deepEqual(event?.attachments, ["image image"]);
    assert.deepEqual(event?.files, [
        { name: "image", ref: "om_x100b7f525a6828accff04f86ab74a01|image|img_v3_0123abcd-4567" },
    ]);
});

test("a file keeps its name and a way to download it", () => {
    const event = eventOf(
        { ...RAW, message_type: "file", content: '<file key="file_v3_0017p_abcd" name="note.txt"/>' },
        { chats: NO_CHATS },
    );

    assert.deepEqual(event?.files, [
        { name: "note.txt", ref: "om_x100b7f525a6828accff04f86ab74a01|file|file_v3_0017p_abcd" },
    ]);
});

test("a post keeps its words and its pictures", () => {
    const event = eventOf(
        { ...RAW, message_type: "post", content: "看图\nimg_v3_aaaa" },
        { chats: NO_CHATS },
    );

    assert.equal(event?.text, "看图\nimg_v3_aaaa");
    assert.equal(event?.files?.length, 1);
});

test("resources and refs join and split", () => {
    const found = resourcesOf('a img_v3_one b <file key="file_v3_two" name="x.pdf"/>', "om_1");

    assert.deepEqual(found, [
        { name: "image", ref: "om_1|image|img_v3_one" },
        { name: "x.pdf", ref: "om_1|file|file_v3_two" },
    ]);
    assert.deepEqual(refOf("om_1|file|file_v3_two"), { messageId: "om_1", kind: "file", key: "file_v3_two" });
    assert.equal(refOf("om_1"), undefined);
    assert.equal(refOf("|image|key"), undefined);
    assert.equal(refOf("om_1|sticker|key"), undefined);
});

test("a file's type comes from its bytes, then its name", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    assert.equal(mimeOf(png, "image"), "image/png");
    assert.equal(mimeOf(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), "image"), "image/jpeg");
    assert.equal(mimeOf(new TextEncoder().encode("hello"), "note.txt"), "text/plain");
    assert.equal(mimeOf(new TextEncoder().encode("hello"), "mystery"), "application/octet-stream");
});

test("a reply that fits stays one message", () => {
    assert.deepEqual(splitText("  hello  ", 100), ["hello"]);
    assert.deepEqual(splitText("", 100), []);
    assert.deepEqual(splitText("   \n\n ", 100), []);
});

test("a long reply is cut at a paragraph, a line, or the limit", () => {
    assert.deepEqual(splitText("a".repeat(50) + "\n\n" + "b".repeat(50), 60), ["a".repeat(50), "b".repeat(50)]);
    assert.deepEqual(splitText("a".repeat(50) + "\n" + "b".repeat(50), 60), ["a".repeat(50), "b".repeat(50)]);
    assert.deepEqual(splitText("x".repeat(25), 10), ["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
});

test("no part of a split reply is longer than the limit", () => {
    const text = Array.from({ length: 40 }, (_, index) => `line ${index} ${"y".repeat(80)}`).join("\n");
    const parts = splitText(text, 300);

    assert.ok(parts.length > 1);
    assert.ok(parts.every((part) => part.length <= 300));
    assert.equal(parts.join("\n"), text);
});

test("a reply key is short, stable, and different for each part", () => {
    const first = replyKey("1f4c9a7b", 0);

    assert.equal(first, replyKey("1f4c9a7b", 0));
    assert.notEqual(first, replyKey("1f4c9a7b", 1));
    assert.notEqual(first, replyKey("1f4c9a7c", 0));
    assert.match(first, /^lark-[0-9a-f]{1,8}-\d+$/);
    assert.ok(replyKey("x".repeat(400), 12).length <= 50);
});

test("chats are read from commas, spaces, and newlines", () => {
    assert.deepEqual(words("oc_a, oc_b\noc_c  oc_d"), ["oc_a", "oc_b", "oc_c", "oc_d"]);
    assert.deepEqual(words(undefined), []);
    assert.deepEqual(words("  "), []);
});
