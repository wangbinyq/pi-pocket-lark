# Project Instructions

## What this is

A Pi Pocket drop-in: one module, `lark.ts`, that adds a `lark` connector to Pi Pocket's built-in Relay extension.
It is not a standalone service and it must not become one: fencing, once-only delivery, limits, the queue, and
retries belong to Relay (`host.inbox`).

## Layout

- `lark.ts` - the drop-in. Its leading /** */ comment is the description in the Extensions sheet; no other comments.
- `test/` - `node --test` tests of the pure parts and of the spawn paths, driven by fake binaries under `/tmp`.
- `tsconfig.json` - type check only.
- Local links, never committed: `_pocket.d.ts` -> Pi Pocket's `types/pocket.d.ts`, `node_modules` -> Pi Pocket's
  `node_modules`.
- Nothing else belongs at the root.

## Install and check

```sh
cp lark.ts ~/.pi-pocket/extensions/
node --test test/*.test.ts
tsc --noEmit -p .
```

Pi Pocket loads a saved drop-in again a moment later, so the copy is the whole install. Turning it on and adding a
connector are the owner's steps in the app (Menu -> Extensions, Menu -> Relay); do them only when asked.

## Rules

- Do not change Pi Pocket's own code for this project. A need that core must meet is a finding for the owner.
- The module runs in the server process with the owner's rights: read no secret, keep the credentials in `lark-cli`.
- One `lark-cli event consume` per app at a time, and every probe runs with `--timeout`: a second consumer makes
  Pi answer twice.
- A reply carries `--idempotency-key` (Lark's `uuid`), so it is sent once. Keep `idempotentReply: true` only
  while that holds.
- `node --test test/*.test.ts` must pass before a change is called done.
