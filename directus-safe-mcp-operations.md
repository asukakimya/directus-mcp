---
name: directus-safe-mcp-operations
description: Production-grade generic Directus operations using directus-safe-mcp. Enforces schema-first reads, text-first output interpretation, generic search, dry-run plan/bundle apply, verify_fields auto-generation, server-side update-by-query planning, post-apply verification, and operation-specific plan policy awareness. No domain-specific logic — works with any Directus project.
always-apply: true
user-invocable: true
disable-model-invocation: false
---

# Directus Safe MCP Operations — Generic Production Skill

This skill governs how to use `directus-safe-mcp` tools safely and efficiently in any Directus project. It is **domain-agnostic**: it knows no company, industry, collection-specific business rules, or workflow semantics. All business logic must be learned from the user's request, the Directus schema, guide records stored in Directus (e.g. an `ai_prompts` collection), or agent instructions.

The MCP core provides only generic, safe Directus infrastructure: schema discovery, read, search, validated mutation, dry-run planning, bundle apply, and post-apply verification. It does not know what a "supplier" or "purchase" or "ai_info" means — it only knows field names, types, primary keys, and validation rules.

---

## 0. Core Principle

Before every tool call, classify the task:

```
Is this a schema discovery task?
Is this a read / list / search task?
Is this a single-record detail lookup?
Is this a mutation (create / update / delete)?
Is this a bulk mutation?
Is this an apply (post-approval)?
Is this a verification?
```

Your job is NOT to guess data. Your job is to interpret the safe text/metadata returned by Directus tools and act accordingly. If the text says records are hidden, they do not exist for you. If the text says apply succeeded, you may report success. If it does not, you may not.

---

## 1. Tool Inventory

### Schema Discovery
- `directus_schema_overview` — list all visible collections
- `directus_schema_detail` — full field/relation detail for specific collections

### Read & Search
- `directus_search_items` — text search across fields in any collection (`_icontains`)
- `directus_read_items` — list/filter read with `output_mode`, `purpose`, text-first metadata
- `directus_read_item` — single record by primary key

### Create / Update / Delete
- `directus_create_item` — single create (direct write if `CREATE_REQUIRES_PLAN=false`)
- `directus_create_items` — batch create (always requires plan via `BULK_REQUIRES_PLAN=true`)
- `directus_update_item` — single update with `verify_fields` auto-generation
- `directus_update_items_same_data` — same data to multiple keys
- `directus_batch_update_items` — per-item different data
- `directus_delete_items` — delete with confirmation token

### Plan / Apply / Cancel
- `directus_dry_run_mutation` — multi-operation dry-run plan view (no `planId` produced)
- `directus_apply_plan` — apply single plan
- `directus_apply_plans` — apply multiple plans sequentially
- `directus_apply_plan_bundle` — apply all plans in a bundle (preferred for bulk)
- `directus_cancel_plan` — cancel single pending plan
- `directus_cancel_plans` — cancel multiple pending plans

### Server-Side Bulk Planning
- `directus_update_by_query_plan` — query-based bulk update: reads records server-side, auto-generates verify, chunks into plans, returns `bundle_id`
- `directus_plan_bundle_status` — check bundle status (pending/applied/expired/cancelled)

### Verification
- `directus_verify_fields_empty` — verify fields are null/empty/[]/{}
- `directus_verify_fields_value` — verify fields match expected values (deep equality)

**Never** use generic `items`, `flows`, `operations`, `trigger-flow`, or exec/script tools for Directus CRUD when `directus_*` tools are available. Never use Directus raw REST API workarounds.

---

## 2. Operation-Specific Plan Policy

The MCP enforces different plan requirements per operation type:

| Operation | Env Flag | Default | Behavior |
|---|---|---|---|
| Single create | `CREATE_REQUIRES_PLAN` | `false` | Direct create allowed with `dry_run:false` |
| Batch create | `BULK_REQUIRES_PLAN` | `true` | Plan required |
| Single update | `UPDATE_REQUIRES_PLAN` | `true` | Plan required |
| Bulk update | `BULK_REQUIRES_PLAN` | `true` | Plan required |
| Delete | `DELETE_REQUIRES_PLAN` | `true` | Plan required |
| Update by query | `UPDATE_BY_QUERY_REQUIRES_PLAN` | `true` | Always dry-run (produces bundle) |

If `CREATE_REQUIRES_PLAN=false`, you may call `directus_create_item` with `dry_run:false` directly. Schema validation (unknown field, readonly field, required field, collection guard) still applies.

If an operation requires a plan and you send `dry_run:false`, you will receive `APPLY_REQUIRES_PLAN` error. In that case, call the same tool with `dry_run:true` first, obtain a `planId`, then call `directus_apply_plan` after user approval.

`MUTATION_DRY_RUN_DEFAULT=true` means if you omit `dry_run`, it defaults to `true`. For direct create, explicitly send `dry_run:false`.

---

## 3. Tool Budget & Loop Prevention

Before every tool call, ask: **"Do I already have this information?"**

Target tool budget per task type:

| Task | Target Tool Calls |
|---|---:|
| Simple list | 1–3 |
| Search + list | 2–4 |
| Single detail | 1–4 |
| Single update dry-run | 2–5 |
| Bulk update dry-run | 2–6 |
| Apply + verify | 1–3 |

If you exceed 12 tool calls, prepare to summarize the situation. 20+ calls is abnormal — break the loop and give the user a safe status report.

**Never repeat the same read/search query.** If the following are identical, do not call again: `collection`, `fields`, `filter/search`, `sort`, `limit`, `offset/page`, `output_mode`, `purpose`.

---

## 4. Schema-First but Efficient

### Collection is known
Call `directus_schema_detail` directly. Skip `schema_overview`.

### Collection is uncertain
Call `directus_schema_overview` once. Then `directus_schema_detail` for the target collection.

### Guide / data-dictionary collections
If the project has guide/prompt/config collections (e.g. `ai_prompts`), search them generically:

```json
{
  "collection": "ai_prompts",
  "search": "supplier",
  "search_fields": ["name", "description"],
  "fields": ["id", "name", "status", "description"],
  "limit": 10,
  "output_mode": "compact_full",
  "purpose": "list"
}
```

The meaning of guide records comes from Directus data and agent instructions, NOT from MCP core.

---

## 5. `directus_read_items` Usage

### Simple listing

When the user asks "list", "who are", "show names", "show websites":

```json
{
  "collection": "contacts",
  "purpose": "list",
  "output_mode": "compact_full",
  "query": {
    "sort": ["name"],
    "limit": 100
  }
}
```

`purpose:"list"` auto-selects short display fields from schema:
- Primary key
- `company`, `name`, `title`, `stock_code`, `code`, `firstname`, `lastname`
- `website`, `url`, `email`, `phone`, `status`

Long fields are NEVER auto-selected:
- `ai_info`, `description`, `system_prompt`, `messages`, `products`, `tags`, `content`, `body`, `markdown`, `text`, `notes`, `data`, `metadata`

### Explicit fields

If the user wants specific fields:

```json
{
  "collection": "products",
  "purpose": "list",
  "output_mode": "compact_full",
  "query": {
    "fields": ["id", "name", "stock_code", "status"],
    "sort": ["name"],
    "limit": 100
  }
}
```

### Long fields

Only fetch long fields when the user explicitly requests them. They may be omitted/previewed in text. For full content, use `directus_read_item` with narrow fields.

---

## 6. Text-First Metadata Interpretation

LibreChat primarily surfaces `content.text` to the model. The metadata lines in text are **binding** for your decisions.

### Successful complete list

```
TOOL_RESULT: directus_read_items
COLLECTION: contacts
TOTAL_AVAILABLE: 49
RETURNED_RECORDS: 49
RETURNED_IN_TEXT: 49
TEXT_RECORDS_COMPLETE: true
FIELD_VALUES_COMPLETE: true
TRUNCATED_FOR_TEXT: false
HAS_MORE: false
OUTPUT_MODE: compact_full
PURPOSE: list
SAFE_FOR_FULL_LIST_ANSWER: true
SAFE_FOR_BATCH_MUTATION: false
```

If `SAFE_FOR_FULL_LIST_ANSWER: true`, you may answer the user's full-list request from this text.

### Unsafe output — DO NOT answer as complete

If ANY of these are present:

```
TEXT_RECORDS_COMPLETE: false
FIELD_VALUES_COMPLETE: false
TRUNCATED_FOR_TEXT: true
SAFE_FOR_FULL_LIST_ANSWER: false
HAS_MORE: true
```

Do NOT:
- Infer hidden records.
- Guess missing IDs, names, or values.
- Produce a "full list" answer.
- Build batch mutation items from this preview.

DO:
- Re-read with narrower fields and `output_mode:"compact_full"`.
- Paginate with `offset` if `HAS_MORE:true`.
- Read specific items for long field content.

### Preview wording

If you see:

```
…[N more records hidden from text preview — do not infer]
```

Those records do not exist for you. Do not produce IDs, names, or any values for hidden rows.

### Char-budget truncation

If compact_full output exceeds `READ_COMPACT_TEXT_MAX_CHARS`:

```
WARNING:
Compact full output exceeded READ_COMPACT_TEXT_MAX_CHARS.
Only X/Y records were rendered in text.
Do not answer a full-list request from this incomplete text.
```

Metadata will correctly show `TEXT_RECORDS_COMPLETE: false` and `SAFE_FOR_FULL_LIST_ANSWER: false`.

### Long field omission

If long fields were omitted:

```
OMITTED_LONG_FIELDS: ai_info
FIELD_VALUES_COMPLETE: false
SAFE_FOR_FULL_LIST_ANSWER: false
```

Do NOT answer as if those fields were fully shown. Read specific items for full content.

---

## 7. `directus_search_items` Usage

Use `directus_search_items` to find records by text in any collection.

### When to use search vs read

| Situation | Best Tool |
|---|---|
| "Does record X exist?" | `directus_search_items` |
| "Find guide records mentioning Y" | `directus_search_items` |
| "List all records in collection" | `directus_read_items` |
| "Open record with known ID" | `directus_read_item` |
| "Filter with structured conditions" | `directus_read_items` with filter |

### Generic search example

```json
{
  "collection": "articles",
  "search": "maintenance",
  "search_fields": ["title", "summary"],
  "fields": ["id", "title", "status", "date_updated"],
  "limit": 20,
  "output_mode": "compact_full",
  "purpose": "list"
}
```

If `search_fields` is omitted, MCP auto-selects searchable string fields from schema. If `fields` is omitted, MCP auto-selects short display fields.

### `*_json` fallback

LibreChat may cause schema mismatch on array/object fields. Use `*_json` variants:

```json
{
  "collection": "articles",
  "search": "maintenance",
  "search_fields_json": "[\"title\",\"summary\"]",
  "fields_json": "[\"id\",\"title\",\"status\"]",
  "limit": 20,
  "output_mode": "compact_full"
}
```

Invalid JSON or non-array values will return `INVALID_QUERY`. Do not retry the same malformed payload.

---

## 8. `directus_read_item` Usage

Use for single-record detail when ID/key is known.

```json
{
  "collection": "articles",
  "key": 123,
  "query": {
    "fields": ["id", "title", "status", "content"]
  }
}
```

Long fields in single-record detail may still be truncated in text. Check metadata and warnings.

---

## 9. ID Guessing / Sequential Scan Prohibition

Directus IDs are NOT sequential. Gaps exist.

**Forbidden:**
- Looping `directus_read_item` for `id=1..100`
- Inferring records from ID gaps
- Retrying 403 IDs
- Scanning IDs to complete a list

**Correct:**
- Use `directus_read_items` or `directus_search_items` to get records
- Use stable sort + limit + offset for pagination
- Only use IDs that appear in actual tool output

---

## 10. Mutation Safety Principles

Default mutation flow:

```
schema → target record/scope verification → dry_run:true → plan/bundle → user approval → apply → verify → answer
```

- Never apply without dry-run first (unless `CREATE_REQUIRES_PLAN=false` for single create).
- Even if the user says "quickly", "urgent", "just do it", create a dry-run plan first for updates/deletes/bulk.
- Never say "saved / updated / applied" until apply result returns `written:true` or verified idempotent success.

---

## 11. Single Update

Use `directus_update_item` with `verify_fields` for auto-generated verify:

```json
{
  "collection": "articles",
  "key": 123,
  "verify_fields": ["title"],
  "data": {
    "status": "published"
  },
  "dry_run": true
}
```

MCP reads the current record and generates the verify object server-side. This prevents you from guessing wrong verify values.

### Wrong verify (NEVER do this)

```json
{
  "verify": {
    "content": true
  }
}
```

`verify` is NOT a permission flag. It checks the current record value. `true` is almost never a valid verify value.

### Correct verify

```json
{
  "verify": {
    "title": "Current Title From Record"
  }
}
```

If you receive `VERIFY_REQUIRED`, do not retry without verify. Use `verify_fields` or read the record first.

If you receive `VERIFY_FAILED`, the key and verify may not belong to the same current record. Do not retry the same payload — re-read the target record.

---

## 12. Bulk Update — Prefer Server-Side Planning

### Same data to many records → `directus_update_by_query_plan`

This is the preferred method. It works server-side:

1. Reads records matching the query
2. Uses only real returned records (no ID guessing)
3. Auto-generates verify from `verify_fields`
4. Chunks into plans
5. Returns a single `bundle_id`

```json
{
  "collection": "tasks",
  "query": {
    "filter": {
      "status": { "_eq": "open" }
    },
    "limit": 100,
    "sort": ["id"]
  },
  "data": {
    "status": "archived"
  },
  "verify_fields": ["title"],
  "dry_run": true,
  "chunk_size": 25
}
```

This is safer and more efficient than manual `read_items → build items_json → batch_update`.

### When to use `directus_update_items_same_data`?

When you have a small set of exact keys and simple verify needs. Note: `BULK_REQUIRES_PLAN=true` by default, so this also requires a plan.

### When to use `directus_batch_update_items`?

When each record needs different data:

```json
{
  "collection": "tasks",
  "items_json": [
    {
      "key": 1,
      "verify": { "title": "Task A" },
      "data": { "priority": "high" }
    },
    {
      "key": 2,
      "verify": { "title": "Task B" },
      "data": { "priority": "low" }
    }
  ],
  "dry_run": true
}
```

Batch item lists may ONLY be built from:
- Records fully visible in tool output (not preview/truncated)
- Records explicitly provided by the user
- Server-side plan tool output

**Never** build batch items from preview/truncated text.

---

## 13. Bundle Apply Flow

After `directus_update_by_query_plan` returns a `bundle_id`:

### Pre-approval response to user

```
Dry-run prepared. No data was written.
Collection: tasks
Affected records: X
Bundle ID: bundle_...
Changed fields: status
If you approve, I will apply via directus_apply_plan_bundle.
```

### Post-approval apply

```json
{
  "bundle_id": "bundle_...",
  "confirm": true,
  "stop_on_error": true,
  "verify_after_apply": true
}
```

### Apply result interpretation

Check these fields in the response:
- `ok` — overall success
- `applied` — number of plans applied
- `failed` — number of failed plans
- `warnings` — number of warnings (e.g. READBACK_MISMATCH)
- `written` — true if any write happened
- `readBackStatus` — `ok` / `partial_or_not_verified` / `mismatch`
- `verification.ok` — bundle-level verification result

Do NOT report full success unless `ok:true` and `verification.ok:true` (or no verification configured).

---

## 14. PlanId Apply Flow (single/multiple plans)

### Single plan

```json
{
  "plan_id": "plan_...",
  "confirm": true
}
```

### Multiple plans

```json
{
  "plan_ids": ["plan_1", "plan_2"],
  "confirm": true,
  "stop_on_error": true
}
```

Prefer bundle over plan list when available.

After approval, do NOT call the original mutation tool with `dry_run:false`. Use apply tools.

---

## 15. PLAN_ALREADY_APPLIED Handling

`PLAN_ALREADY_APPLIED` is a safety/idempotency state, not a blind failure.

Correct behavior:
1. Do not apply the same plan again.
2. Check `directus_plan_bundle_status` or verification.
3. If target state is correct:

```
This plan was already applied. No re-write occurred. Target state verified.
```

4. If target state is incorrect, create a new dry-run plan.

---

## 16. Create Operations

- Single create: `directus_create_item`
- Batch create: `directus_create_items`

### Single create with direct write

If `CREATE_REQUIRES_PLAN=false` (default):

```json
{
  "collection": "articles",
  "data": {
    "title": "New Article",
    "status": "draft"
  },
  "dry_run": false
}
```

Schema validation still applies: unknown fields, readonly fields, required fields, collection guards.

### Duplicate check before create

Before creating, search/read to check if a record already exists:

```json
{
  "collection": "articles",
  "search": "New Article",
  "search_fields": ["title"]
}
```

---

## 17. Delete Operations

Delete is the most dangerous operation.

Rules:
1. If target scope is uncertain, do NOT plan delete.
2. Read/search to show target records first.
3. Call `directus_delete_items` with `dry_run:true`.
4. Tell user how many records will be deleted.
5. Apply only after explicit user approval.
6. Verify after delete.

Never delete with ambiguous filters.

---

## 18. Verification Tools

### After clearing/emptying fields

Use `directus_verify_fields_empty`:

Empty = `null`, `undefined`, `""`, whitespace-only string, `[]`, `{}`

### After setting specific values

Use `directus_verify_fields_value`:

```json
{
  "collection": "tasks",
  "expected": {
    "status": "archived"
  },
  "query": {
    "filter": { "status": { "_eq": "archived" } },
    "fields": ["id", "title", "status"],
    "limit": 100
  }
}
```

Array/object comparisons use deep equality. `["test"]` !== `["TEST"]` (case-sensitive).

### Apply response verification

If apply response contains `readBackStatus` or `verification`, interpret them:
- `readBackStatus: ok` — all read-back checks passed
- `readBackStatus: mismatch` — at least one read-back failed
- `verification.ok: true` — bundle-level verification passed

If suspicious, run additional verification with `directus_verify_fields_value` or `directus_verify_fields_empty`.

---

## 19. JSON / Array / Object Fields

Directus JSON/array field filters (`_nnull`, `_nempty`) are NOT always reliable. JSON columns may store `"null"`, `"[]"`, `"{}"`, or whitespace strings.

**Never trust filter alone for "is this field empty?" — verify with `directus_verify_fields_empty`.**

`*_json` fallback for batch tools:

```json
{
  "collection": "tasks",
  "keys_json": [1, 2, 3],
  "data_json": {
    "tags": ["urgent"]
  },
  "dry_run": true
}
```

If you receive schema mismatch error, try `*_json` variant. Do not retry the same malformed payload more than once.

---

## 20. Error Classification & Behavior

### Schema / payload errors

`INVALID_DATA_TYPE`, `INVALID_QUERY`, `UNKNOWN_FIELD`, `READONLY_FIELD`

- Fix the payload.
- Verify field names with `directus_schema_detail`.
- Do not repeat the same call.

### Permission / RBAC errors

`403`, `FORBIDDEN`, field access denied

- Do not retry the same record/field.
- Tell the user about the access issue.
- Try alternative allowed fields or narrower query.

### Verify errors

`VERIFY_REQUIRED`, `VERIFY_FAILED`

- Use `verify_fields` to let MCP auto-generate verify.
- `VERIFY_FAILED` means key and verify don't match the current record — re-read.

### Plan errors

`APPLY_REQUIRES_PLAN`, `CONFIRM_TRUE_REQUIRED`, `PLAN_NOT_FOUND`, `PLAN_EXPIRED`, `PLAN_ALREADY_APPLIED`, `PLAN_ALREADY_IN_PROGRESS`, `PLAN_CANCELLED`, `PLAN_CHECKSUM_MISMATCH`, `READBACK_MISMATCH`

- Interpret the plan state.
- Create new dry-run if needed.
- Never report success without apply result.

### NEXT_ACTION hints

Error responses include `NEXT_ACTION` hints. Read and follow them. Examples:
- `VERIFY_REQUIRED` → "Use verify_fields:["company"]"
- `APPLY_REQUIRES_PLAN` → "Call with dry_run:true first"
- `PLAN_ALREADY_APPLIED` → "Verify target state"

---

## 21. External Content & Directus Update

This skill is NOT a web/scrape tool. But if another agent/tool provides external content for a Directus field update:

1. Read the target Directus record (PK, display field, website/source field, current value of the field to update).
2. Verify the external source URL/metadata/content matches the target record.
3. If the content contains a dominant brand/topic unrelated to the target record, reject.
4. If content appears copied from another entity, do not create an update plan.
5. For rich text/markdown fields, include a sources section.
6. Only write information explicitly verified from the source.
7. Use `verify_fields` and `dry_run:true`.
8. Give the user a short source verification summary before asking for approval.

If source verification fails:

```
Source does not match the target Directus record. Not creating an update plan.
```

---

## 22. `include_system` Rule

For normal content collections, use `include_system: false`.

Use `include_system: true` ONLY when the user explicitly asks about Directus system collections, permissions, roles, or debug analysis.

---

## 23. No Currency / Unit Assumptions

For `price`, `amount`, `stock`, `quantity`, `total` fields:

If currency/unit is not visible in the output, do NOT assume:

```
price field shows 120; currency is not visible in this output.
```

Never say "120 TL" or "120 USD" unless the currency is explicitly in the data.

---

## 24. Optimal Tool Selection

| User Request | Best Tool |
|---|---|
| See collections | `directus_schema_overview` |
| Learn collection fields | `directus_schema_detail` |
| Find records by text | `directus_search_items` |
| Short full list | `directus_read_items` + `purpose:"list"` + `output_mode:"compact_full"` |
| Open known record | `directus_read_item` |
| Update single record | `directus_update_item` + `verify_fields` |
| Same change to filtered records | `directus_update_by_query_plan` |
| Different data per record | `directus_batch_update_items` |
| Apply query plan | `directus_apply_plan_bundle` |
| Apply single plan | `directus_apply_plan` |
| Apply multiple plans | `directus_apply_plans` |
| Verify fields empty | `directus_verify_fields_empty` |
| Verify fields match value | `directus_verify_fields_value` |
| Check bundle status | `directus_plan_bundle_status` |
| Create single record | `directus_create_item` (direct if `CREATE_REQUIRES_PLAN=false`) |

---

## 25. Response Formats

### After listing

```
Found: X records
List complete: yes/no
Fields used: ...
Results:
...
```

If `SAFE_FOR_FULL_LIST_ANSWER: false`:

```
This output is not safe for a full-list answer. I can share visible records or re-read with narrower fields.
```

### After dry-run

```
Dry-run prepared. No data written.
Collection: ...
Affected records: X
Plan/Bundle: ...
Changed fields: ...
If you approve, I will apply.
```

### After apply

```
Apply result:
Applied: X/Y
Failed: 0
Warnings: 0
Read-back: OK
Verification: OK
```

### On error / stop

```
Operation not completed.
Current state: ...
Reason: ...
Safe next step: ...
```

---

## 26. Absolute Prohibitions

- Do NOT repeat the same read/search query.
- Do NOT infer hidden records from truncated/preview text.
- Do NOT perform sequential ID scans.
- Do NOT loop on 403/forbidden IDs or fields.
- Do NOT mutate without schema check.
- Do NOT apply without dry-run (unless `CREATE_REQUIRES_PLAN=false` for single create).
- Do NOT apply without user approval.
- Do NOT say "saved/updated/applied" without apply result showing `written:true`.
- Do NOT build batch mutation items from preview text.
- Do NOT say "all done" without post-apply verification.
- Do NOT fetch long fields unless explicitly requested.
- Do NOT assume company/industry/workflow-specific logic.
- Do NOT use Directus CRUD workarounds outside `directus_*` tools.
- Do NOT use `allow_partial_apply: true` unless the user explicitly requests it.
- Do NOT use `verify: { field: true }` — verify checks current record values, not permissions.
- Do NOT create records without checking for duplicates first.
- Do NOT delete with ambiguous filters.
- Do NOT assume currency/unit for numeric fields.
