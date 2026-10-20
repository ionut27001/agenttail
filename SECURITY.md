# Security

## Local only

agenttail binds to `127.0.0.1` only. It has no authentication because it is not
reachable from the network. Keep it that way: do not put it behind a reverse
proxy, port-forward it, or change the bind address.

Every request must carry a `Host` header of exactly `127.0.0.1:<port>` or
`localhost:<port>`; anything else receives `403`. POST requests must also carry
an `Origin` matching that exact Host and `Content-Type: application/json`.
Together these block DNS rebinding and cross-site request forgery.

## Read-only

The server reads session logs and workspace files. It never writes to session
stores, transcripts or workspace files. Its only writes are the local nickname
file and optional configuration files in the agenttail config directory.

## Stream mode

Stream mode is enabled by default: emails, Windows usernames, URLs with
credentials, tokens, IPv4/IPv6/MAC addresses and several opaque identifiers are
redacted on the server before anything reaches the browser. If a redaction
fails, the event is dropped rather than sent raw. You can add private literals
and patterns in `redact.json`. **Review the stream before sharing or recording
it.** Redaction reduces risk; it is not a guarantee that every sensitive string
is caught.

## Privacy

agenttail collects **no** telemetry, analytics or crash reports. It makes **no**
network requests: it only reads local session logs and serves them on
`127.0.0.1`. All frontend libraries and fonts are vendored under
`public/vendor/`; the page loads nothing from a CDN. Nothing leaves your
machine.

## Reporting a vulnerability

Please report security issues privately to the maintainer rather than opening a
public issue with exploit details. Include the affected version, a minimal
reproduction, and the impact. You should receive an acknowledgement within a
few days. Do not test against systems you do not own.
