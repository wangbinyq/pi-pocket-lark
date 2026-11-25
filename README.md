# pi-pocket-lark

A [Pi Pocket](https://github.com/TannerMidd/pi-pocket) drop-in that connects Lark/Feishu to a Pi Pocket session.
People write to the app's bot in a direct chat, or name it in a group; Pi answers in the session, and the answer goes
back to where it came from. Images and files that people send come through as files Pi can read.

Status: **direct chats and group mentions, text, images, and files.** Pi cannot send an image or a file back yet.

## How it works

```
Lark -> lark-cli event consume (long connection, no public address)
  -> lark connector (this drop-in) -> Relay: filter, fence, dedupe, rate limit, on-disk queue
  -> inbox -> the session's Pi -> relay_reply -> this connector -> lark-cli im +messages-reply
                                       -> relay_fetch -> this connector -> lark-cli im +messages-resources-download
```

- The connector registers with Pi Pocket's built-in **Relay** extension (`web.use("pocket-relay")`, API 1), so
  fencing, once-only delivery, limits, the on-disk queue, and retries are the relay's work, not this module's.
- Receiving is `lark-cli event consume im.message.receive_v1 --as bot`: an outbound long connection. Ports stay
  closed, and nothing is exposed to the internet.
- Credentials stay in `lark-cli`'s own config. This module reads no secret and stores no token.
- A reply goes back as a reply to the message it answers. Long answers are cut at a paragraph, then a line, then
  the character count, and each part is sent as its own message.

## What comes through

| In Lark | What Pi gets |
| --- | --- |
| A direct message | the message |
| A group message that names the bot | the message; every other group message is dropped |
| An image | `files` entry `image`; Pi calls `relay_fetch` to read its bytes |
| A file, audio, or video | `files` entry with its own name |
| A rich post | its words, and a `files` entry for each picture in it |

Downloaded files land in the session's `.relay/` folder, at most 25 MB each and 10 to an event. The type is read from
the bytes, so a PNG without an extension still arrives as an image, and a text file stays `text/plain` even when
`lark-cli` saved it as `.bin`.

## Requirements

- Pi Pocket 0.29.0 or later, with **Relay** turned on (Menu -> Extensions).
- `lark-cli` 1.0.x signed in for a Feishu app, with the bot in the chat and `im.message.receive_v1` enabled in
  the developer console. `lark-cli doctor` and `lark-cli event schema im.message.receive_v1` tell the state.
- The person writes the bot first: a bot cannot open a direct chat on its own. For a group, the bot must be in it.
- `GET /open-apis/bot/v3/info` answers for the bot: the connector asks once at start for its open id and name, which
  are how a group message that names the bot is recognized. Without that answer, only direct chats come through, and
  the connector says so in the server log.

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

| Field | Meaning |
| --- | --- |
| `binary` | The `lark-cli` program, or its full path. |
| `profile` | A `lark-cli --profile` name. Empty uses the default profile. |
| `chats` | Only these `oc_…` chats, separated by commas. Empty takes every one. |
| `groups` | On: a group message that names the bot comes through. Off: direct chats only. |
| `max_chars` | The most characters in one Lark message. Longer answers are sent in parts. |

## What was checked on a live Lark app

| Check | Result |
| --- | --- |
| Receiving | One JSON line per message: `message_id`, `chat_id` (`oc_…`), `chat_type`, `sender_id` (`ou_…`), `sender_type`, `content` (already rendered), `create_time` (ms) |
| Sending | `im +messages-reply --as bot` lands in the same chat, attached to the message it answers |
| Markdown | `--markdown` sends `msg_type: post` with an `md` tag; lists and code blocks render |
| Exactly once | `--idempotency-key` becomes the request's `uuid`; two calls with one key return the same `message_id` |
| No echo | The bot's own messages do not come back as `im.message.receive_v1`; the connector also drops `sender_type` other than `user` |
| Images and files | The bot downloads both with `im +messages-resources-download --type image\|file`; the rendered content carries `img_…` and `<file key=\"file_…\" name=\"…\"/>` |
| Bot identity | `api GET /open-apis/bot/v3/info --as bot` gives `open_id` and `app_name` |
| Attachment path | `+messages-resources-download` may rename what it saves (`LICENSE` becomes `LICENSE.bin`) and answers `data.saved_path`; the connector reads that path, never the one it asked for |

Not yet seen on a live app: a group mention, because this app's bot cannot be added to a group. The connector
matches either the bot's open id or its app name, and a group message that matches neither is dropped, so a wrong
guess costs a missing message, never a wrong answer.

## Test

```sh
node --test test/*.test.ts
```

The tests cover the pure parts: one event line, the chat and group rules, what an image or a file becomes, the
attachment refs, a file's type, cutting a long reply, and the reply key. They make no network call. A fake `lark-cli`
drives the spawn paths: an abort returns in under a second, a split reply reaches it in parts, and a download comes
back as bytes.

Type check, with a `tsc` 5.9 or later and Pi Pocket's packages linked as `node_modules`:

```sh
tsc --noEmit -p .
```

## Limits

- One consumer of `im.message.receive_v1` for each app: a second `lark-cli event consume` (a probe too) makes Pi
  answer twice. Every probe runs with `--timeout`.
- Messages sent while the connector is down are lost: Lark retries an event for a short time only.
- Pi cannot send an image or a file back: a reply is text.
- A sticker has nothing to download.
- A group needs the bot in it. Where an app's availability keeps the bot out of groups, only direct chats are possible.
