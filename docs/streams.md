# Streams

A **stream** is an address you can POST to. What arrives becomes a task, an
inbox item, a GitHub issue, or a task with an issue linked to it. A contact
form, a webhook, a monitoring alert, a bug report from your own app, an email —
they all come in the same way.

Each stream belongs to one space and has its own address, its own rules and its
own log. You create them in Kern: **Streams → New stream.**

- [The address](#the-address)
- [Sending something](#sending-something)
- [Fields](#fields)
- [Authentication](#authentication)
- [What you get back](#what-you-get-back)
- [Why a submission was refused](#why-a-submission-was-refused)
- [Not sending twice](#not-sending-twice)
- [HTML forms](#html-forms)
- [Email](#email)
- [Spam](#spam)
- [Rate limits](#rate-limits)

## The address

```
POST https://kern.example.com/kern/<64 hex characters>
```

The hex part is the stream's id, and it is the whole credential for a public
stream: anyone who has the address can post to it. Treat it like a secret URL.
If it leaks, **rotate** the stream in Kern rather than deleting it — the old
address stops working and the new one takes its place.

## Sending something

JSON, and that is all you need:

```sh
curl -X POST https://kern.example.com/kern/a1b2c3… \
  -H 'Content-Type: application/json' \
  -d '{"title":"Boiler making a noise","email":"sam@example.com","notes":"Started this morning."}'
```

```json
{ "ok": true, "id": 412, "status": "delivered", "message": "Thanks! We've received it." }
```

`title` becomes the task's title; everything else goes in the body. Both are
templated, so the stream's owner can arrange them differently — see
[Fields](#fields).

Three content types are accepted:

| | |
|---|---|
| `application/json` | The normal way. |
| `application/x-www-form-urlencoded` | An ordinary HTML form. |
| `multipart/form-data` | A form with file inputs (the files themselves are not kept). |

Nested keys work with dots: `{"customer.name": "Sam"}` and
`{"customer": {"name": "Sam"}}` are the same thing.

## Fields

A stream can list the fields it expects, with a type, a label, whether it is
required, and a maximum length. Types are `text`, `long_text`, `email`, `url`,
`number`, `boolean` and `choice` (which carries its own options).

Two modes:

- **lenient** (the default) — unlisted fields are kept and shown in the task.
- **strict** — unlisted fields are refused, naming them. Use this once you have
  settled what your form sends; it catches a renamed input immediately instead
  of silently dropping it.

A `422` tells you exactly which field was wrong and why, so a form can show it
next to the input.

Keys beginning with an underscore are reserved for the stream itself (`_hp`,
`_fields`, `_stream` and friends) and are stripped from what you send.

## Authentication

Set in Kern, per stream.

### public

No credential beyond the address. Intended for a form on a web page, so by
default it **refuses requests with no `Origin` header** — that is, requests
that didn't come from a browser page. Turn that off (`requireOrigin`) for
server-to-server posts, or better, use a token.

A public stream never returns record ids, whatever else is configured: an
address that anyone may hold shouldn't be a way to learn what is in the space.

### token

A bearer secret, shown once when you create or rotate it:

```sh
curl -X POST https://kern.example.com/kern/a1b2c3… \
  -H 'Authorization: Bearer kss_…' \
  -H 'Content-Type: application/json' \
  -d '{"title":"Disk 80% full on web-1"}'
```

What a webhook or a script should use.

### signature

An HMAC over the exact bytes you send, with replay protection. For anything
where a leaked bearer token would matter, or where you want to be sure the body
wasn't altered in transit.

```
Kern-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256>
```

The signed message is the timestamp, a literal `.`, then the raw request body:

```
HMAC-SHA256(secret, "<t>." + body)
```

```sh
body='{"title":"Deploy failed","run":"4821"}'
t=$(date +%s)
sig=$(printf '%s.%s' "$t" "$body" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')

curl -X POST https://kern.example.com/kern/a1b2c3… \
  -H "Kern-Signature: t=$t,v1=$sig" \
  -H 'Content-Type: application/json' \
  -d "$body"
```

```python
import hashlib, hmac, time, requests

body = '{"title":"Deploy failed","run":"4821"}'
t = int(time.time())
sig = hmac.new(SECRET.encode(), f"{t}.{body}".encode(), hashlib.sha256).hexdigest()

requests.post(URL, data=body, headers={
    "Content-Type": "application/json",
    "Kern-Signature": f"t={t},v1={sig}",
})
```

Sign **the exact bytes you send** — serialise the body once, into a variable,
and send that variable. Re-serialising between signing and sending is the usual
cause of `bad_signature`.

Timestamps more than 300 seconds from the server's clock are refused
(`stale_signature`; the stream's owner can widen it). A signature is accepted
once, so a replayed request is refused even inside the window.

Rotating a signature or token stream keeps the previous secret working while
you roll it out; **revoke previous** ends it immediately. You can send several
`v1=` values in one header, which is what makes rotating from the sender's side
safe too.

## What you get back

| | |
|---|---|
| `201` | Delivered. |
| `200` | Accepted, and recognised as something already sent — see [Not sending twice](#not-sending-twice). |
| `202` | Taken, but part of it needs retrying (a GitHub issue that couldn't be created yet). The stream's owner can redeliver from the log. |

Every reply carries `Kern-Event: <id>`, the delivery's number in the stream's
log. Quote it when asking the stream's owner what happened to a submission.

```json
{ "ok": true, "id": 412, "status": "delivered", "message": "Thanks! We've received it." }
```

`message` is whatever the stream's owner wrote, so it is safe to show to whoever
filled in the form. Token and signature streams can also ask for `taskId` and
`issue` in the reply (`returnIds`).

## Why a submission was refused

| Status | Code | What to do |
|---|---|---|
| `400` | `invalid_json`, `invalid_idempotency_key` | Fix the request. |
| `401` | `missing_token`, `bad_token`, `missing_signature`, `bad_signature`, `stale_signature` | See [Authentication](#authentication). |
| `403` | `origin_not_allowed`, `ip_not_allowed`, `origin_required` | The stream's rules exclude you; ask its owner. |
| `404` | `not_found` | No stream at that address — or it was rotated. |
| `405` | | Streams take `POST`. |
| `413` | `too_large` | Over the stream's size limit (32 KB by default). |
| `415` | | Use one of the three content types above. |
| `422` | `invalid_fields` | The reply names each field and what was wrong. |
| `429` | `rate_limited` | Back off; `Retry-After` says how long. |
| `503` | `paused` | The stream is paused. |

Refusals *before* authentication are not written to the stream's log, so nobody
can fill it up from outside. That also means a `401` leaves no trace for the
stream's owner to look at — if you are debugging your own integration, read
your end.

## Not sending twice

Send an `Idempotency-Key` header with each submission — any string of up to 200
visible ASCII characters, unique per submission:

```
Idempotency-Key: order-10432-contact
```

Retrying with the same key returns the **first** result, with `"duplicate":
true`, and creates nothing new. This is what makes a retry after a timeout
safe, and it is the right answer whenever you can't tell whether a request got
through.

Independently, a stream can treat identical submissions within a window (10
minutes by default) as one, which catches a double-clicked submit button
without the sender doing anything.

## HTML forms

Post straight to the address — no JavaScript:

```html
<form method="POST" action="https://kern.example.com/kern/a1b2c3…">
  <input name="title" placeholder="Subject" required>
  <input name="email" type="email" placeholder="Your email">
  <textarea name="notes"></textarea>

  <!-- The honeypot: leave it empty and hidden. Bots fill it in. -->
  <input name="_hp" style="display:none" tabindex="-1" autocomplete="off">

  <button>Send</button>
</form>
```

Set a **redirect** on the stream and the browser is sent there afterwards with
`?kern=ok` or `?kern=error` — a thank-you page with no JavaScript at all.
Without one, Kern serves a small page of its own.

Each stream has its own **allowed origins** list, which is what its CORS reply
is built from. Add your site (`https://example.com`, or
`https://*.example.com`) or a browser post will be refused before it arrives.

There is also a **capture page** for each stream, at
`/kern/<id>/capture#k=<secret>`: Kern's own hosted form, for sending something
from a phone with nothing to build. The secret rides in the URL fragment, so it
is never sent to the server as part of the request — keep the whole link
private, and rotate the stream if it leaks.

## Email

If the server's administrator has set up inbound email, a stream can have an
address — `<alias>@in.example.com`, where the alias is a random 20-character
string the stream generates — and anything sent to it becomes a submission: the
subject is the title, the body is the body. `+tags` on the address are ignored,
so `alias+invoices@…` reaches the same stream.

The address is the credential, so treat it as one.

This is off unless `INBOUND_EMAIL_SECRET` is configured. See
[SELF-HOSTING.md](SELF-HOSTING.md).

## Spam

Defences a stream's owner can turn on, roughly in order of how much they cost
whoever is sending:

- **The honeypot** — a hidden field (`_hp` by default) that people leave empty
  and bots fill in. Free, and catches a surprising amount.
- **Turnstile** — [Cloudflare's](https://developers.cloudflare.com/turnstile/)
  challenge, usually invisible. Send the token as `Kern-Turnstile`, or as
  `cf-turnstile-response` in a form post.
- **Origin rules** — which sites may post from a browser.
- **An IP allowlist** — addresses or CIDR ranges, for a webhook from a known
  source.
- **Blocked senders** — the stream's owner can block a sender from its log,
  without ever seeing their address: senders are stored hashed.

**Spam is answered exactly like success.** A caught submission gets the same
`ok` reply as a real one, so bots learn nothing from trying — and so a false
positive doesn't tell a real person their message was thrown away. The stream's
owner sees it in the log, marked, and can redeliver it.

Submitted text is escaped before it becomes a task, so it can't inject links,
images or formatting, and invisible control and direction-changing characters
are stripped. Streams that open GitHub issues also neutralise `@mentions` and
issue cross-references by default, so a submission can't notify people or
link itself into unrelated threads.

## Rate limits

Three ceilings, all set per stream:

| | Default |
|---|---|
| Per sender, per minute | 5 |
| Per sender, per hour | 30 |
| The whole stream, per hour | 200 |

A `429` carries `Retry-After` in seconds. Honour it: retrying immediately just
extends the window. For a bulk import, ask the stream's owner to raise the
limits rather than working around them — a stream is not an import tool.

The administrator of a self-hosted server has their own ceiling over all of
these (`STREAM_MAX_PER_HOUR`), and can disable any stream on the instance with
`kernctl streams disable <id>`.
