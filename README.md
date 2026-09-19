# @pipeworx/ttab

Trademark disputes before the USPTO Trademark Trial and Appeal Board —
oppositions, cancellation petitions, extensions of time to oppose, and ex parte
appeals, with both parties, the marks at issue, and the full docket.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1576+ live data sources.

## Tools

- `ttab_search(party?, other_party?, mark?, correspondent?, serial_or_registration_number?, query?, status?, match_mode?, page?, limit?)` —
  finds proceedings by party name, mark text, correspondent firm, or
  application/registration number. Each result carries the board proceeding
  number, proceeding type, filing date, and both sides with their marks and
  serial/registration numbers. Answers "is anyone opposing this trademark".
- `ttab_proceeding(proceeding_number, type?)` — one proceeding in full: status
  and status date, interlocutory attorney and paralegal, each party's
  correspondence address and pleaded marks, and the complete prosecution
  history (every docket entry, its date, and any due date).
- `ttab_party_history(party, status?, match_mode?, max_pages?, limit?)` —
  profiles a company across TTAB: how often it appears as plaintiff (opposing)
  versus defendant (opposed), a breakdown by proceeding type, and every name
  spelling it has been filed under.

## Auth

Keyless.

## Data sources

- <https://ttabvue.uspto.gov/ttabvue/> — TTABVUE, the Board's inquiry system
  (v2.8.0). Server-rendered HTML; there is no JSON API and no bot wall.
- `v?qt=adv&...` is the advanced-search endpoint. Parameters: `procstatus`
  (`Pending`/`Terminated`/`All`), `pno` (proceeding number), `propno`
  (application/registration number), `qs` (all words anywhere), `propname` +
  `propnameop` (mark), `pn` + `pop` (party), `pn2` + `pop2` (other party),
  `cn` + `cop` (correspondent), `page` (1-based, 25 rows per page). The `*op`
  operators take `''` (contains all words), `beg` (starts with), or `mat`
  (is exactly).
- `v?pno=<number>[&pty=<type>]` is the proceeding detail page.

### Things worth knowing before you touch this

- **An unknown proceeding number returns HTTP 200 with an empty record page**,
  not a 404. The pack detects the blank `Number:` field and returns
  `{found:false, reason:'proceeding_not_found'}`; do not trust the status code.
- **Result totals saturate at the literal string `"100+"`** — `result_count` is
  a string, not a number, and the pack says so in `result_count_note`.
- **`EXT` (extension of time to oppose) and `EXA` (ex parte appeal) are keyed by
  application serial number**, not by an 8-digit board number, so one number can
  name two different records. `pty` disambiguates; omitting it lets TTABVUE
  choose, and asking for the wrong `pty` yields the empty page above.
- **Party names are stored exactly as filed**, so one company appears under
  several spellings. Names are returned raw, and `ttab_party_history` reports
  the spellings it saw rather than merging them.
- A proceeding has marks on both sides — the defendant's applications under
  attack and the plaintiff's pleaded registrations. They are kept in separate
  party objects, never merged into one mark list.
- Search results are three top-level `<td class="p1">` cells per row
  (proceeding / defendant / plaintiff); nested layout tables use bare `<td>`,
  which is what makes the cell split safe.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "ttab": {
      "url": "https://gateway.pipeworx.io/ttab/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/ttab/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1576+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/ttab_search \
  -H 'Content-Type: application/json' \
  -d '{"party":"Nike, Inc.","limit":5}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/ttab_search`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "ttab": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-ttab"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-ttab
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Ttab data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
