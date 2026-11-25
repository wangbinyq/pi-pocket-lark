import assert from "node:assert/strict";
import { test } from "node:test";
import { eventOf, parseEventLine, replyKey, splitText, words } from "../lark.ts";

const NONE = new Set<string>();

const PING = '{"type":"im.message.receive_v1","event_id":"0f0e0d0c0b0a09080706050403020100","timestamp":"1795580234859","id":"om_x100b7f525a6828accff04f86ab74a01","message_id":"om_x100b7f525a6828accff04f86ab74a01","create_time":"1795580234488","chat_id":"oc_0123456789abcdef0123456789abcdef","chat_type":"p2p","message_type":"text","sender_id":"ou_0123456789abcdef0123456789abcdef","sender_type":"user","content":"ping"}';

test("a real direct message becomes an event", () => {
    const event = parseEventLine(PING, NONE);

    assert.deepEqual(event, {
        id: "om_x100b7f525a6828accff04f86ab74a01",
        text: "ping",
        author: { id: "ou_0123456789abcdef0123456789abcdef", name: "ou_0123456789abcdef0123456789abcdef", bot: false },
        channel: "oc_0123456789abcdef0123456789abcdef",
        mentioned: true,
        at: 1795580234488,
    });
});

test("lines that are not an event are dropped", () => {
    assert.equal(parseEventLine("", NONE), undefined);
    assert.equal(parseEventLine("[event] ready event_key=im.message.receive_v1", NONE), undefined);
    assert.equal(parseEventLine("{not json", NONE), undefined);
    assert.equal(parseEventLine("{}", NONE), undefined);
});

test("only a direct chat from a person is taken", () => {
    const raw = JSON.parse(PING);

    assert.equal(eventOf({ ...raw, chat_type: "group" }, NONE), undefined);
    assert.equal(eventOf({ ...raw, sender_type: "bot" }, NONE), undefined);
    assert.equal(eventOf({ ...raw, message_id: undefined, id: undefined }, NONE), undefined);
    assert.equal(eventOf({ ...raw, chat_id: undefined }, NONE), undefined);
});

test("a chat list keeps only those chats", () => {
    const one = new Set(["oc_0123456789abcdef0123456789abcdef"]);

    assert.ok(eventOf(JSON.parse(PING), one));
    assert.equal(eventOf(JSON.parse(PING), new Set(["oc_other"])), undefined);
});

test("a message that is not text keeps its kind", () => {
    const event = eventOf(
        { ...JSON.parse(PING), message_type: "image", content: "", thread_id: "omt_1" },
        NONE,
    );

    assert.equal(event?.text, "");
    assert.deepEqual(event?.attachments, ["image"]);
    assert.equal(event?.thread, "omt_1");
});

test("a reply that fits stays one message", () => {
    assert.deepEqual(splitText("  hello  ", 100), ["hello"]);
    assert.deepEqual(splitText("", 100), []);
    assert.deepEqual(splitText("   \n\n ", 100), []);
});

test("a long reply is cut at a paragraph, a line, or the limit", () => {
    assert.deepEqual(splitText("a".repeat(50) + "\n\n" + "b".repeat(50), 60), [
        "a".repeat(50),
        "b".repeat(50),
    ]);
    assert.deepEqual(splitText("a".repeat(50) + "\n" + "b".repeat(50), 60), [
        "a".repeat(50),
        "b".repeat(50),
    ]);
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
    assert.ok(first.length <= 50);
    assert.match(first, /^lark-[0-9a-f]{1,8}-\d+$/);
    assert.ok(replyKey("x".repeat(400), 12).length <= 50);
});

test("chats are read from commas, spaces, and newlines", () => {
    assert.deepEqual(words("oc_a, oc_b\noc_c  oc_d"), ["oc_a", "oc_b", "oc_c", "oc_d"]);
    assert.deepEqual(words(undefined), []);
    assert.deepEqual(words("  "), []);
});
