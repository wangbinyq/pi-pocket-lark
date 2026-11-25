# pi-pocket-lark

A [Pi Pocket](https://github.com/TannerMidd/pi-pocket) drop-in that connects a Lark/Feishu direct chat to a Pi Pocket
session. People write to the app's bot in Lark, Pi answers in the session, and the answer goes back to the same chat.

Status: **direct chats, text only.** Group chats with an @mention, and images and files, are not connected yet.

## How it works

```
Lark direct chat -> lark-cli event consume (long connection, no public address)
  -> lark connector (this drop-in) -> Relay: filter, fence, dedupe, rate limit, on-disk queue
  -> inbox -> the session's Pi -> relay_reply -> this connector -> lark-cli im +messages-reply
```

- The connector registers with Pi Pocket's built-in **Relay** extension (`web.use("pocket-relay")`, API 1), so
  fencing, once-only delivery, limits, the on-disk queue, and retries are the relay's work, not this module's.
- Receiving is `lark-cli event consume im.message.receive_v1 --as bot`: an outbound long connection. Ports stay
  closed, and nothing is exposed to the internet.
- Credentials stay in `lark-cli`'s own config. This module reads no secret and stores no token.
- A reply goes back as a reply to the message it answers. Long answers are cut at a paragraph, then a line, then
  the character count, and each part is sent as its own message.

## Requirements

- Pi Pocket 0.29.0 or later, with **Relay** turned on (Menu -> Extensions).
- `lark-cli` 1.0.x signed in for a Feishu app, with the bot in the direct chat and `im.message.receive_v1`
  enabled in the developer console. `lark-cli doctor` and `lark-cli event schema im.message.receive_v1` tell
  the state.
- The person writes the bot first: a bot cannot open a direct chat on its own.

## Install

```sh
cp lark.ts ~/.pi-pocket/extensions/
```

Then, in Pi Pocket:

1. Menu -> Extensions -> turn on **Lark**. Pi Pocket loads a saved drop-in again a moment later, so the copy is the
   whole install.
2. Menu -> Relay -> add a connector of kind **Lark**: pick the session that answers, give your own `ou_…` open id
   as an owner id, and write the instructions Pi reads with each message.

## What the connector asks for

| Field      | Meaning                                                                     |
| ---------- | --------------------------------------------------------------------------- |
| `binary`   | The `lark-cli` program, or its full path.                                   |
| `profile`  | A `lark-cli --profile` name. Empty uses the default profile.                |
| `chats`    | Only these `oc_…` direct chats, separated by commas. Empty takes every one. |
| `max_chars` | The most characters in one Lark message. Longer answers are sent in parts.  |

## What was checked on a live Lark app

| Check                | Result                                                                                        |
| -------------------- | --------------------------------------------------------------------------------------------- |
| Receiving            | One JSON line per message: `message_id`, `chat_id` (`oc_…`), `chat_type`, `sender_id` (`ou_…`), `sender_type`, `content` (already rendered), `create_time` (ms) |
| Sending              | `im +messages-reply --as bot` lands in the same direct chat, attached to the message it answers |
| Markdown             | `--markdown` sends `msg_type: post` with an `md` tag; lists and code blocks render           |
| Exactly once         | `--idempotency-key` becomes the request's `uuid`; two calls with one key return the same `message_id` |
| No echo              | The bot's own messages do not come back as `im.message.receive_v1`; the connector also drops `sender_type: bot` |

## Test

```sh
node --test test/*.test.ts
```

The tests cover the pure parts: parsing one event line, mapping it, the chat filter, cutting a long reply, and the
reply key. They make no network call and start no process. A fake `lark-cli` drives the rest: the abort path returns
in under a second, and a split reply reaches it in parts.

Type check, with a `tsc` 5.9 or later and Pi Pocket's packages linked as `node_modules`:

```sh
tsc --noEmit -p .
```

## Limits

- One consumer of `im.message.receive_v1` for each app: a second `lark-cli event consume` (a probe too) makes Pi
  answer twice. Every probe runs with `--timeout`.
- Messages sent while the connector is down are lost: Lark retries an event for a short time only.
- Text only. An image or a file arrives as its kind, with no content; attaching those needs
  `im +messages-resources-download` and the connector's `fetch`.
