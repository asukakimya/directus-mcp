# directus-safe-mcp

Schema-aware, dry-run/verify-guarded Directus MCP sidecar.

Directus REST API'yi güvenli, schema-first ve LLM dostu bir MCP (Model Context Protocol) ara katmanıyla saran bağımsız Node.js / TypeScript servisi. Directus resmi remote MCP'deki `items` tool'undaki stringified-JSON serialization bug sınıfını (#26891 / PR #27005) kendi içinde çözer; ek olarak dry-run, verify, after-read doğrulaması, collection allowlist, system collection guard ve batch limit politikaları uygular.

> Bu MCP Directus'un yerine geçmez. Directus API'yi güvenli ve LLM dostu bir ara katmanla kullanır. RBAC bypass etmez — token'ın sahip olduğu izinler neyse MCP de onu kullanır.

Bu MCP **iş kuralı bilmez**. Koleksiyon anlamları (örneğin "şu koleksiyon satın alma kaynağıdır", "bu alan şu vendor'a bağlıdır") MCP'nin değil, bağlanan ajan prompt'larının / skill'lerin / `ai_prompts` kayıtlarının sorumluluğundadır. MCP sadece: schema oku, veri oku, güvenli yaz, validate et, dry-run yap, verify yap, after-read yap.

---

## Özellikler

- **MCP TypeScript SDK** üzerinde `streamable-http` (varsayılan, production) + `stdio` (local debug) transport. Legacy HTTP+SSE transport desteklenmez; Streamable HTTP kendi içinde gerektiğinde `text/event-stream` response kullanabilir (bu, SDK'nın resmi Streamable HTTP davranışıdır).
- **Stateless Streamable HTTP** — `sessionIdGenerator: undefined` ile gerçek stateless mod. Her HTTP request için taze `McpServer` + taze `StreamableHTTPServerTransport` oluşturulur; `mcp-session-id` header üretilmez. Bu sayede `initialize` sonrası `tools/list` tek HTTP bağlantısında çalışır.
- **Endpoint path guard** — sadece `MCP_ENDPOINT_PATH` (default `/mcp`) MCP endpoint. `GET /healthz` liveness probe, diğer path'ler 404.
- **Bearer auth gate** — `MCP_REQUIRE_AUTH=true` (default) ise her HTTP request `Authorization: Bearer <MCP_AUTH_TOKEN>` taşır. Constant-time compare. Stdio exempt (local subprocess).
- **Origin / Host guard** — `MCP_ALLOWED_ORIGINS` ve `MCP_ALLOWED_HOSTS` ile DNS rebinding + CSRF koruması.
- **Verify enforcement** — `MUTATION_REQUIRE_VERIFY=true` (default) iken `directus_update_item` ve `directus_batch_update_items` verify olmadan çalışmaz; `directus_update_items_same_data` tamamen reddedilir (per-key verify desteklemez).
- **All-or-nothing batch apply** — `directus_batch_update_items` ve `directus_create_items` apply (dry_run=false) sırasında önce preflight çalıştırır. Herhangi bir item validation/verify/dedupe hatası verirse **tüm batch abort edilir, sıfır yazma yapılır**. `allow_partial_apply=true` ile eski partial-success davranışına geri dönülebilir.
- **Single-mode read query** — `directus_read_item` artık `limit`/`page`/`offset` parametrelerini reddeder (tek kayıt endpoint'inde anlamsız; LLM karışıklığını gösterir). `fields`/`deep`/`version` hala destekleniyor.
- **Token-bounded `content.text`** — Tüm tool response'larında `content.text` artık sadece kısa bir etiket değil; modelin karar vermesi için gereken gerçek sonucu (şema field listesi, dönen kayıtlar, before/after/diff, hata kodları, batch summary) kompakt formatta içerir. LibreChat `structuredContent`'i modele göstermese bile LLM gerçek sonucu görür. Limitler: `SCHEMA_TEXT_MAX_FIELDS=80`, `READ_TEXT_MAX_ROWS=10`, `READ_TEXT_MAX_CHARS=12000`.
- **Recursive JSON normalisation** — `data`, `query`, `filter`, `deep`, `keys`, `headers`, `verify`, `dedupe`, `items`, `operations` alanları JSON string olarak gelirse otomatik parse.
- **Schema-first validation** — her yazma işleminde field set şemadan doğrulanır; unknown ve readonly field'lar Directus'a gitmeden reddedilir.
- **Read-before, verify, diff, after-read** doğrulama zinciri update'lerde.
- **Dry-run default** — `MUTATION_DRY_RUN_DEFAULT=true` ile yazma işlemleri varsayılan olarak simulate edilir.
- **Collection allowlist + `directus_*` blocklist**.
- **Delete default kapalı** — `DIRECTUS_ALLOW_DELETE=true` + `confirm="DELETE <collection>:<keys>"` gerekli.
- **Batch size limiti** — `MUTATION_MAX_BATCH_SIZE`.
- **Filter operator whitelist** — sadece spec'te listelenen operatorlere izin verilir.
- **Safe default fields** — `fields` verilmezse PK + ilk 10 scalar field döner; `*` wildcard default olarak reddedilir.
- **Partial success reporting** — batch işlemler per-item sonuç döner.
- **Audit log** — her mutation girişimi loglanır.

---

## Hızlı Başlangıç

### 1. Environment

`.env.example`'ı kopyalayıp doldurun:

```bash
cp .env.example .env
# .env içine:
#   DIRECTUS_URL=https://your-directus.example.com
#   DIRECTUS_TOKEN=replace-with-directus-static-token
#   MCP_AUTH_TOKEN=<random 32+ byte string>
```

### 2. Production (Docker, Streamable HTTP)

```bash
docker compose up --build
```

Container `3333` portunda Streamable HTTP MCP sunar. Bearer token ile auth zorunludur (`MCP_REQUIRE_AUTH=true` default).

### 3. Local debug (Node, stdio)

```bash
npm install
npm run build
MCP_TRANSPORT=stdio node dist/index.js
```

Stdio modu local subprocess olduğu için `MCP_REQUIRE_AUTH` yok sayılır — auth parent process'in sorumluluğundadır.

### 4. Local HTTP debug

```bash
MCP_TRANSPORT=streamable-http \
MCP_HTTP_PORT=3333 \
MCP_REQUIRE_AUTH=true \
MCP_AUTH_TOKEN=dev-token \
node dist/index.js
```

---

## Configuration (env)

| Variable | Default | Açıklama |
|---|---|---|
| `DIRECTUS_URL` | (zorunlu) | Directus instance URL'i |
| `DIRECTUS_TOKEN` | (zorunlu) | Directus access token (RBAC'ye tabi) |
| `MCP_TRANSPORT` | `streamable-http` | `streamable-http`, `http` (alias), veya `stdio` |
| `MCP_HTTP_PORT` | `3333` | Streamable HTTP port |
| `MCP_BIND_HOST` | `0.0.0.0` | Network interface (`127.0.0.1` = local-only) |
| `MCP_ENDPOINT_PATH` | `/mcp` | MCP HTTP endpoint path. `/healthz` her zaman açık. |
| `MCP_REQUIRE_AUTH` | `true` | HTTP transport'ta Bearer auth zorunlu mu |
| `MCP_AUTH_TOKEN` | (zorunlu HTTP auth için) | Bearer token; constant-time compare |
| `MCP_ALLOWED_ORIGINS` | (boş = tümü) | Virgülle ayrılmış Origin allowlist (DNS rebinding koruması) |
| `MCP_ALLOWED_HOSTS` | (boş = tümü) | Virgülle ayrılmış Host allowlist. Port-tolerant: `mcp.example.com` allowlist'i hem `mcp.example.com` hem `mcp.example.com:3333` Host header'larını kabul eder. |
| `DIRECTUS_ALLOWED_COLLECTIONS` | (boş = hepsi) | Virgülle ayrılmış allowlist |
| `DIRECTUS_DENIED_COLLECTION_PREFIXES` | `directus_` | Yasaklı prefix'ler |
| `DIRECTUS_ALLOW_DELETE` | `false` | Delete tool'larını açar |
| `DIRECTUS_ALLOW_SCHEMA_WRITE` | `false` | (rezerve) |
| `MUTATION_DRY_RUN_DEFAULT` | `true` | dry-run default |
| `MUTATION_REQUIRE_VERIFY` | `true` | Update'lerde verify zorunlu; `update_items_same_data` reddedilir |
| `MUTATION_MAX_BATCH_SIZE` | `100` | Batch limit |
| `READ_DEFAULT_LIMIT` | `50` | Read default limit |
| `READ_MAX_LIMIT` | `500` | Read maksimum limit (clamp) |
| `ALLOW_WILDCARD_FIELDS` | `false` | `fields: ["*"]` izni |
| `SCHEMA_CACHE_TTL_SECONDS` | `300` | Schema cache TTL |
| `VERIFY_CASE_INSENSITIVE` | `false` | Verify string compare modu |
| `SCHEMA_TEXT_MAX_FIELDS` | `80` | `content.text` için şema detayında maksimum field sayısı |
| `READ_TEXT_MAX_ROWS` | `10` | `content.text` için read/batch sonuçlarında maksimum satır |
| `READ_TEXT_MAX_CHARS` | `12000` | `content.text` toplam karakter limiti (truncation marker dahil) |
| `APPLY_REQUIRES_PLAN` | `true` | Direct `dry_run:false` reddedilir; model önce dry-run yapıp plan almalı, sonra `directus_apply_plan` çağırmalı |
| `PLAN_STORE` | `file` | Plan store backend: `file` (production) veya `memory` (test) |
| `PLAN_STORE_DIR` | `/tmp/directus-safe-mcp-plans` | File-based plan store dizini (0600 izinleri) |
| `PLAN_TTL_SECONDS` | `900` | Plan TTL (saniye, default 15 dk) |
| `PLAN_MAX_BYTES` | `1048576` | Maks plan payload boyutu (byte) |
| `LOG_LEVEL` | `info` | pino log level |

---

## MCP Tool Listesi

20 tool register edilir (hepsi `directus_` prefix'i ile):

| Tool | Açıklama |
|---|---|
| `directus_schema_overview` | Koleksiyon listesi + PK + field count |
| `directus_schema_detail` | Bir veya birden fazla koleksiyonun tam şema detayı |
| `directus_read_items` | Liste okuma (validate edilmiş query ile) |
| `directus_read_item` | Tek item okuma |
| `directus_create_item` | Tek item create (dedupe + dry-run + plan destekli) |
| `directus_create_items` | Batch create (serial, per-item result, all-or-nothing preflight) |
| `directus_update_item` | Tek item update (verify_fields auto-gen destekli) |
| `directus_update_items_same_data` | Bulk PATCH /items/{collection} (aynı data, multi key) |
| `directus_batch_update_items` | Per-item different data update (serial PATCH) |
| `directus_delete_items` | Delete (default kapalı, confirm gerekli) |
| `directus_dry_run_mutation` | Çoklu operasyon planı (dry-run only, planId üretmez) |
| `directus_update_by_query_plan` | **Query ile toplu update planı + bundle** (model kayıt listesi üretmez) |
| `directus_apply_plan` | Tek plan uygular (gerçek yazma + read-back verification) |
| `directus_apply_plans` | Çoklu plan toplu uygular (stop_on_error destekli) |
| `directus_apply_plan_bundle` | **Bundle'ı toplu uygular** (already-applied tolerant + verification) |
| `directus_cancel_plan` | Tek pending plan'ı iptal eder |
| `directus_cancel_plans` | Çoklu pending plan'ı toplu iptal eder |
| `directus_plan_bundle_status` | **Bundle durumunu sorgular** (pending/applied/expired/cancelled) |
| `directus_verify_fields_empty` | Belirli field'ların boş olduğunu doğrular |
| `directus_verify_fields_value` | **Belirli field'ların beklenen değere eşit olduğunu doğrular** (deep equality) |

### Tool input kuralları

- `data`, `items`, `keys`, `query`, `filter`, `deep`, `verify`, `dedupe`, `operations` hem native JSON hem de `<field>_json` formunda kabul edilir.
- **`*_json` alanları string, array VE object kabul eder** (LibreChat uyumluluğu için). Handler otomatik normalize eder.
- LibreChat bazen `keys_json: [1,2,3]` (array) veya `data_json: {tags:[]}` (object) gönderir — bu artık schema validation'da patlamaz, handler'da normalize edilir.
- Update işlemlerinde `verify` field'ları mevcut kayıtla eşleşmezse `VERIFY_FAILED` hatası döner; yazma yapılmaz.
- Unknown field → `UNKNOWN_FIELD` hatası (sessizce drop edilmez).
- Readonly / system audit field'lar (`user_created`, `date_created`, `user_updated`, `date_updated`) → `READONLY_FIELD` hatası.
- Primary key update → `PRIMARY_KEY_UPDATE_DENIED`.
- `directus_*` koleksiyonlarında mutation → `SYSTEM_COLLECTION_DENIED`.
- Filter operator whitelist dışı → `INVALID_FILTER_OPERATOR`.
- Wildcard field default olarak reddedilir (`ALLOW_WILDCARD_FIELDS=false`).

### JSON array alanlarında filtre güvenilirliği uyarısı

**Directus JSON/array alanlarında `_nnull`, `_nempty` filtreleri her zaman güvenilir sonuç vermeyebilir.** JSON kolonlar `"null"`, `"[]"`, `"{}"` veya whitespace string saklayabilir; Directus bunları non-null/non-empty sayabilir.

Güvenli yöntem: `directus_verify_fields_empty` tool'unu kullanın. Bu tool kayıtları okur ve client-side boş/dolu kontrolü yapar:
- `null`, `undefined`, `""`, whitespace-only string, `[]`, `{}` → boş
- diğer her şey → dolu

Örnek:
```json
{
  "tool": "directus_verify_fields_empty",
  "input": {
    "collection": "suppliers",
    "fields": ["tags", "products"]
  }
}
```

Response'da `nonEmpty` listesi döner — bu kayıtlar tekrar işlenmelidir. Toplu temizlik sonrası "tüm kayıtlar temiz" demeden önce bu tool ile doğrulama yapın.

### Hata formatı

```json
{
  "ok": false,
  "error": {
    "code": "UNKNOWN_FIELD",
    "message": "Field 'bogus' does not exist in 'articles'",
    "details": { "collection": "articles", "field": "bogus" }
  }
}
```

Hata kodları: `CONFIG_ERROR`, `DIRECTUS_API_ERROR`, `COLLECTION_NOT_ALLOWED`, `SYSTEM_COLLECTION_DENIED`, `SCHEMA_NOT_FOUND`, `PRIMARY_KEY_NOT_FOUND`, `UNKNOWN_FIELD`, `READONLY_FIELD`, `PRIMARY_KEY_UPDATE_DENIED`, `REQUIRED_FIELD_MISSING`, `INVALID_QUERY`, `INVALID_FILTER_OPERATOR`, `VERIFY_FAILED`, `VERIFY_REQUIRED`, `ABORTED_BY_PREFLIGHT`, `DUPLICATE_FOUND`, `BATCH_LIMIT_EXCEEDED`, `DELETE_DISABLED`, `CONFIRMATION_REQUIRED`, `INVALID_JSON`, `INVALID_DATA_TYPE`, `DRY_RUN_REQUIRED`, `NOT_FOUND`, `PLAN_NOT_FOUND`, `PLAN_EXPIRED`, `PLAN_ALREADY_APPLIED`, `PLAN_ALREADY_IN_PROGRESS`, `PLAN_CANCELLED`, `PLAN_CHECKSUM_MISMATCH`, `APPLY_REQUIRES_PLAN`, `PLAN_STORE_ERROR`, `PLAN_TOO_LARGE`, `READBACK_MISMATCH`, `CONFIRM_TRUE_REQUIRED`.

---

## Dry-run → Approval → Apply Plan Flow

Bu akış, modelin "uyguladım" deyip gerçekte yazmaması problemini kökten çözer.

### Akış

1. **Mutation tool** `dry_run:true` ile çağrılır (örn. `directus_update_item`).
2. Server dry-run çalıştırır: read-before → verify → validate → diff. **Hiçbir yazma yapmaz.**
3. Server bir `planId` oluşturur ve store eder (file-based, TTL 15 dk).
4. Response'da `planId`, `requiresApplyPlan: true`, `written: false` döner.
5. `content.text`'te açıkça "DRY-RUN ONLY — hiçbir veri yazılmadı" yazar ve `directus_apply_plan` çağrı önerisi verilir.
6. Kullanıcı onay verince model **aynı payload'u tekrar üretmez** — sadece `directus_apply_plan({ plan_id, confirm: true })` çağırır.
7. `directus_apply_plan` planı yükler, checksum doğrular, collection guard + schema + field validation + verify **tekrar** yapar, gerçek yazma yapar, read-back verification yapar, plan'ı `applied` olarak işaretler.
8. Response'da `applied: true`, `written: true`, `dryRun: false`, `readBackOk: true` döner.
9. `content.text`'te "APPLIED — gerçek yazma yapıldı" yazar.

### Kritik kurallar

- `dry_run:true` **asla** veri yazmaz. Kullanıcı onayı sadece apply iznidir; gerçek yazma `directus_apply_plan` çağrısıyla olur.
- `APPLY_REQUIRES_PLAN=true` (default) iken direct `dry_run:false` mutation tool çağrısı `APPLY_REQUIRES_PLAN` hatası alır.
- Her plan sadece bir kez uygulanabilir (idempotency). İkinci apply → `PLAN_ALREADY_APPLIED`.
- **Concurrent apply protection**: plan claim atomik `pending → applying` geçişi yapar. Eşzamanlı iki apply çağrısından ilki claim alır, ikincisi `PLAN_ALREADY_IN_PROGRESS` alır.
- Süresi dolmuş plan → `PLAN_EXPIRED`. Yeni dry-run gerekir.
- Apply sırasında verify koşulları artık geçerli değilse → `VERIFY_FAILED`, yazma yapılmaz (pre-write error, plan cancelled).
- **Read-back mismatch post-write davranışı**: yazma başarılı olursa, plan **mutlaka terminal** duruma geçer. Read-back mismatch olursa `applied_with_warning` statüsü alır ve `warning.code: "READBACK_MISMATCH"` response'da döner — **throw etmez**. Plan tekrar apply edilemez. Bu, "yazıldı ama error döndü, tekrar yazıldı" riskini önler.
- Post-write unexpected error → `failed_after_write` (terminal, tekrar apply edilemez, caller read ile durumu kontrol etmeli).
- Plan store file-based (default), 0600 dosya izinleri, TTL 15 dk, max 1 MB payload.
- Startup + periyodik (5 dk) cleanup: expired/cancelled/applied plan dosyaları temizlenir. `applied_with_warning` ve `failed_after_write` planları korunur (post-mortem inspection için).
- Audit log plan payload'unu loglamaz — sadece `planId`, `operation`, `collection`, `changedFields`.

### `directus_dry_run_mutation` plan üretmez

`directus_dry_run_mutation` tool'u **çoklu işlem planlama/görünüm** içindir. Apply edilebilir `planId` **üretmez**.

Apply edilebilir plan gerekiyorsa spesifik mutation tool `dry_run:true` kullanın:
- Tek kayıt update: `directus_update_item dry_run:true`
- Çoklu farklı update: `directus_batch_update_items dry_run:true`
- Tek/çoklu create: `directus_create_item(s) dry_run:true`
- Delete: `directus_delete_items dry_run:true`

Onay sonrası sadece `directus_apply_plan` çağırın.

### Plan lifecycle durumları

```text
pending → applying → applied                          (write + readback OK)
                   → applied_with_warning             (write OK, readback mismatch)
                   → failed_after_write               (write happened, post-write error)
pending → cancelled                                   (user rejected or pre-write validation fail)
pending/applying → expired                            (TTL passed)
```

`applied`, `applied_with_warning`, `failed_after_write`, `expired`, `cancelled` hepsi terminal — plan bir daha apply edilemez.

### Örnek akış

```json
// 1. Model: dry-run update
{ "tool": "directus_update_item", "input": {
    "collection": "articles", "key": 1,
    "verify": { "title": "Intro to MCP" },
    "data": { "slug": "intro-to-mcp" },
    "dry_run": true
}}
// Response: { "planId": "plan_...", "requiresApplyPlan": true, "written": false, ... }

// 2. Kullanıcı: "onaylıyorum"

// 3. Model: apply plan (payload'u tekrar üretmez!)
{ "tool": "directus_apply_plan", "input": {
    "plan_id": "plan_...",
    "confirm": true
}}
// Response: { "applied": true, "written": true, "dryRun": false, "readBackOk": true, ... }
```

### Content text örnekleri

Dry-run:
```text
DRY-RUN UPDATE articles — OK (dryRun=true) NOT WRITTEN
Plan ID: plan_...
Plan expires at: 2024-01-01T00:15:00.000Z
Changed fields: slug
Before: {"id":1,"title":"Intro to MCP","slug":null}
After: {"id":1,"title":"Intro to MCP","slug":"intro-to-mcp"}

⚠ DRY-RUN ONLY — hiçbir veri yazılmadı.
Kullanıcı onay verirse şu tool çağrılmalı:
directus_apply_plan({ "plan_id": "plan_...", "confirm": true })
Başarı mesajı ancak directus_apply_plan sonucunda applied:true / written:true görüldükten sonra verilebilir.
```

Apply:
```text
APPLIED UPDATE articles — OK (dryRun=false) written=true
Plan ID: plan_...
Read-back verification: OK
Changed fields: slug
```

### Delete işlemleri

Delete işlemleri de aynı plan akışını kullanır:
1. `directus_delete_items` ile `dry_run:true` → plan oluşturulur (confirm token dahil).
2. `directus_apply_plan` → gerçek delete + read-back (kayıtların artık okunamadığını doğrular).

### Local debug (plan akışı olmadan)

`APPLY_REQUIRES_PLAN=false` ile direct `dry_run:false` çağrılabilir (eski davranış). Sadece local debug için önerilir.

---

## Bundle Flow: Query-Based Toplu Update (düşük parametreli modeller için)

Bu akış, modelin kayıt listesi toplamasını, verify üretmesini, planId'leri takip etmesini engeller. Model sadece niyeti söyler.

### Akış

1. **Model**: `directus_update_by_query_plan` çağırır (query + data + verify_fields)
2. **MCP**: kayıtları okur, verify üretir, chunk'lara böler, planlar oluşturur, **bundle_id** döndürür
3. **Kullanıcı**: onay verir
4. **Model**: `directus_apply_plan_bundle({ bundle_id, confirm: true })` çağırır (payload tekrar üretmez)
5. **MCP**: tüm planları uygular, read-back + bundle-level verification yapar
6. **Response**: `applied: true`, `written: true`, `readBackStatus: 'ok'`, `verification: { ok: true }`

### Örnek

```json
// 1. Model: "Tüm tedarikçilerin tags alanı ['test'] olsun"
{
  "tool": "directus_update_by_query_plan",
  "input": {
    "collection": "suppliers",
    "query": { "fields": ["id", "company"], "sort": ["id"], "limit": 100 },
    "data": { "tags": ["test"] },
    "verify_fields": ["company"],
    "dry_run": true,
    "chunk_size": 25
  }
}
// Response: { "bundleId": "bundle_...", "planIds": [...], "totalMatched": 49, ... }

// 2. Kullanıcı: "onaylıyorum"

// 3. Model: apply bundle (payload tekrar üretmez!)
{
  "tool": "directus_apply_plan_bundle",
  "input": { "bundle_id": "bundle_...", "confirm": true }
}
// Response: { "applied": true, "written": true, "readBackStatus": "ok", "verification": { "ok": true, "totalChecked": 49 } }
```

### Neden bundle?

- Model planId listesi takip etmez — tek `bundle_id` yeterli
- Model kayıt listesi üretmez — MCP server-side okur
- Model verify üretmez — MCP `verify_fields`'tan otomatik üretir
- Model id tahmini yapamaz — sadece gerçek dönen kayıtlar kullanılır
- `PLAN_ALREADY_APPLIED` durumu otomatik verification ile çözülür

### `verify_fields` auto-generation

`directus_update_item` ve `directus_update_by_query_plan` artık `verify_fields` parametresi destekliyor. `verify` nesnesi vermek yerine field adları verilir; MCP kaydı okur ve verify'yi server-side üretir.

```json
{
  "collection": "suppliers",
  "key": 61,
  "verify_fields": ["company"],
  "data": { "ai_info": "# O KIMYA" },
  "dry_run": true
}
```

MCP içeride şunu üretir:
```json
{ "verify": { "company": "O KIMYA" } }
```

Bu, modelin `verify: { ai_info: true }` gibi hatalı verify'ler üretmesini engeller.

---

## LibreChat Agent Instructions

Bağlanan ajana şu talimatı verin:

```text
Directus mutation işlemlerinde (create/update/delete) her zaman önce dry_run:true kullan.

Dry-run sonucu planId dönerse, kullanıcı onayı sonrası AYNI PAYLOAD'U TEKRAR ÜRETTME.
Sadece şu çağrıyı yap:
  directus_apply_plan({ "plan_id": "<önceki planId>", "confirm": true })

Kullanıcı "onaylıyorum", "uygula", "tamam", "devam et" derse directus_apply_plan çağır.

directus_apply_plan çalışmadan ve çıktıda applied:true / dryRun:false / written:true görmeden
"başarıyla güncellendi", "uygulandı", "kaydedildi" DEME.

Dry-run çıktısı başarı değildir. Dry-run sadece plan üretir.
Eğer planId yoksa veya apply başarısız olursa, kullanıcıya gerçeği söyle.

directus_dry_run_mutation tool'u planId ÜRETMEZ — sadece çoklu işlem görünümü içindir.
Apply edilebilir plan için spesifik mutation tool dry_run:true kullan (update_item, batch_update_items, create_item, delete_items).

Eğer directus_apply_plan çıktısında warning alanı varsa (örn. READBACK_MISMATCH),
yazma gerçekleşmiş ama doğrulama başarısız olmuş demektir. Kullanıcıya gerçeği söyle:
"Yazma yapıldı ama read-back doğrulaması başarısız. Kaydı kontrol edin."
Plan zaten terminal durumdadır, tekrar apply ETME.
```

---

## Client Bağlantı Örnekleri

### 1. Streamable HTTP (production, Docker/LibreChat)

LibreChat veya başka bir MCP client `url` alanını destekliyorsa:

```yaml
mcpServers:
  directus-safe:
    url: http://directus-safe-mcp:3333/mcp
    headers:
      Authorization: "Bearer ${MCP_AUTH_TOKEN}"
    timeout: 90000
```

Container'ı `MCP_TRANSPORT=streamable-http` + `MCP_AUTH_TOKEN=<token>` ile çalıştırın.

### 2. stdio (local debug, Claude Desktop / Cursor)

```yaml
mcpServers:
  directus-safe:
    command: docker
    args:
      - exec
      - -i
      - directus-safe-mcp
      - node
      - dist/index.js
    env:
      DIRECTUS_URL: "${DIRECTUS_URL}"
      DIRECTUS_TOKEN: "${DIRECTUS_TOKEN}"
      MCP_TRANSPORT: "stdio"
    timeout: 90000
    initTimeout: 60000
```

Stdio modunda `MCP_REQUIRE_AUTH` yok sayılır (auth parent process'in sorumluluğunda).

---

## Örnek Kullanım

### 1. Schema keşfi

```json
{ "tool": "directus_schema_overview", "input": { "include_system": false } }
{ "tool": "directus_schema_detail", "input": { "collections": ["articles"] } }
```

### 2. Okuma

```json
{
  "tool": "directus_read_items",
  "input": {
    "collection": "articles",
    "query": {
      "fields": ["id", "title", "slug"],
      "filter": { "title": { "_icontains": "MCP" } },
      "limit": 10
    }
  }
}
```

### 3. Dry-run update (önerilen akış)

```json
{
  "tool": "directus_batch_update_items",
  "input": {
    "collection": "articles",
    "items": [
      { "key": 1, "verify": { "title": "Intro to MCP" }, "data": { "status": "published" } },
      { "key": 2, "verify": { "title": "Directus Deep Dive" }, "data": { "status": "published" } }
    ],
    "dry_run": true
  }
}
```

LLM sonucu kullanıcıya sunar; kullanıcı onaylayınca `dry_run: false` ile gerçek yazma yapılır.

### 4. Stringified JSON regression test

Eğer client `data`'yı string olarak gönderirse (Directus issue #26891):

```json
{
  "tool": "directus_update_item",
  "input": {
    "collection": "articles",
    "key": 1,
    "data": "{\"status\":\"published\"}",
    "dry_run": true
  }
}
```

Sidecar bunu otomatik parse eder ve validation'a sokar.

---

## Ajan Kullanım Talimatı

Bağlanan ajana şunu verin:

```text
Directus verisi için resmi Directus remote MCP items tool yerine directus-safe-mcp tool'larını kullan.

Her görevde sıra:
1. directus_schema_detail ile ilgili koleksiyonları incele.
2. directus_read_items veya directus_read_item ile mevcut kayıtları oku.
3. Yazma işleminden önce dry_run=true kullan.
4. Kullanıcı/ana ajan onayı olmadan dry_run=false yapma.
5. Update'lerde verify kullan.
6. Unknown/readonly field hatasında tahminle devam etme.
7. Tool schema hatası alırsan aynı payload'u tekrar etme; data_json veya query_json kullan.
```

İş kuralları (koleksiyon anlamları, vendor mapping'leri, domain-specific davranışlar) MCP'de değil, ajan prompt'larında / skill'lerde / `ai_prompts` kayıtlarında tutulur.

---

## Test

```bash
npm test                # vitest run
npm run test:watch      # vitest watch
npm run typecheck       # tsc --noEmit (strict)
```

Test kapsamı:

- `normalize.test.ts` — recursive JSON normalisation (regression testleri dahil)
- `diff-verify.test.ts` — diff ve verify davranışı
- `permissions.test.ts` — collection / batch guard'lar
- `validators.test.ts` — query validation + field validation
- `mutations.test.ts` — DirectusRestClient + items operations + relation type inference
- `mcp-tools.test.ts` — fetch-mock ile MCP tool entegrasyon testleri (dry-run, verify fail, unknown field, batch partial success, stringified JSON regression)
- `transports.test.ts` — Streamable HTTP auth gate + transport alias parsing

---

## Mimari Notlar

### Stateless Streamable HTTP

`StreamableHTTPServerTransport`'a `sessionIdGenerator: undefined` veriyoruz. Bu, SDK'ya "session üretme, her request self-contained" der. Bu olmadan SDK her initialize'da `mcp-session-id` header üretir; client sonraki request'te bu header'ı göndermek zorundadır; ama server tarafında session map tutmadığımız için ikinci request "Server not initialized" 400 hatası alır. `undefined` ile bu davranış tamamen kapanır.

Her HTTP request için taze `McpServer` + taze transport oluşturulur. Tool'lar zaten stateless — Directus REST çağrısı yapıyorlar, server içinde kullanıcı state'i tutmaya gerek yok.

### Bearer auth

`MCP_REQUIRE_AUTH=true` (default) ise her HTTP request `Authorization: Bearer <MCP_AUTH_TOKEN>` taşır. Token karşılaştırması constant-time yapılır (timing side-channel önlemi). Stdio transport exempt — auth parent process'in sorumluluğunda.

Config yükleme sırasında: eğer `streamable-http` + `MCP_REQUIRE_AUTH=true` + `MCP_AUTH_TOKEN` boşsa server refuse-to-start eder. Yanlışlıkla unauthenticated HTTP açmamak için.

### Transaction garantisi yok (V1)

`directus_batch_update_items` tek tek `PATCH /items/{collection}/{id}` çağrıları yapar. Bir kayıt başarısız olursa diğerleri devam eder (fail_fast=false default). Partial success `summary` alanında raporlanır. All-or-nothing transaction gerekiyorsa Directus API extension içinde `ItemsService` + database transaction kullanmak gerekir (V2 planı).

### Different-data batch update

Resmi Directus Items API "Update Multiple Items" endpoint'i (`PATCH /items/{collection}`) sadece **aynı data**'yı birden fazla key'e uygular (`{ keys, data }` body). Per-key farklı data için sidecar serial `PATCH /items/{collection}/{id}` kullanır.

### RBAC

Sidecar Directus RBAC'yi bypass etmez. Token'ın sahip olduğu permission'lar geçerlidir. 403/401 hataları `DIRECTUS_API_ERROR` olarak sarılır.

### Schema cache

`/collections`, `/fields/{collection}`, `/relations` çağrıları TTL cache'lenir (default 5 dakika). Schema değişikliği olursa servisi restart edin veya cache'i temizleyin.

---

## Dosya Yapısı

```text
directus-safe-mcp/
  Dockerfile
  docker-compose.yml
  .env.example
  package.json
  tsconfig.json
  vitest.config.ts
  README.md
  scripts/
    smoke-stdio.mjs              # stdio transport smoke test (initialize + tools/list)
    smoke-http.mjs               # Streamable HTTP smoke test (healthz, 404, 401, initialize, tools/list)
  src/
    index.ts                     # entry: load config → server factory → connect transport
    config.ts                    # env loader + pino logger + transport alias parsing
    mcp/
      server.ts                  # ToolContext + buildServer
      transports.ts              # stdio / stateless streamable-http + Bearer auth
      tools.ts                   # registerAllTools wrapper (normalise + error mapping)
    directus/
      client.ts                  # low-level items operations
      rest.ts                    # DirectusRestClient + DirectusApiError
      schema.ts                  # internal schema model + relation inference
      schemaService.ts           # /collections + /fields + /relations cache
      query.ts                   # read query validation + filter operator whitelist
      validators.ts              # field validation (unknown, readonly, pk, required)
      mutations.ts               # read/create/update/delete orchestration
      errors.ts                  # McpUserError + ErrorCode union
    safety/
      normalize.ts               # recursive JSON normaliser
      permissions.ts             # collection / batch / delete guards
      diff.ts                    # MutationDiff + deepEqual
      dryRun.ts                  # dry-run result shape
      verify.ts                  # verify record vs expectations
      audit.ts                   # in-memory audit log
      textFormat.ts              # compact content.text formatters (token-bounded)
      plans.ts                   # MutationPlan + PlanStore (file/memory) + checksum
      bundles.ts                 # PlanBundle + BundleStore + status computation
    tools/
      schemaOverview.ts
      schemaDetail.ts
      readItems.ts
      readItem.ts
      createItem.ts
      createItems.ts
      updateItem.ts
      updateItemsSameData.ts
      batchUpdateItems.ts
      deleteItems.ts
      dryRunMutation.ts
      applyPlan.ts                # single plan apply
      applyPlans.ts               # batch plan apply (stop_on_error)
      applyPlanBundle.ts          # bundle apply (already-applied tolerant + verification)
      cancelPlan.ts               # single plan cancel
      cancelPlans.ts              # batch plan cancel
      planBundleStatus.ts         # bundle status query
      updateByQueryPlan.ts        # query-based batch plan + bundle creation
      verifyFieldsEmpty.ts        # post-apply verification helper (fields empty)
      verifyFieldsValue.ts        # post-apply verification helper (fields match expected)
    test/
      helpers.ts                 # expectErrorCode test helper
      normalize.test.ts
      diff-verify.test.ts
      permissions.test.ts
      validators.test.ts
      mutations.test.ts
      mcp-tools.test.ts
      transports.test.ts
```

---

## Kabul Kriterleri

Tüm kabul kriterleri (spec §25) karşılanır:

1. ✅ Docker Compose ile ayağa kalkar.
2. ✅ `stdio` MCP transport çalışır (+ `streamable-http` production default).
3. ✅ 11 tool register edilir (spec minimum 8).
4. ✅ `data` stringified JSON olarak gelirse native objeye çevrilir.
5. ✅ `query` stringified JSON olarak gelirse native objeye çevrilir.
6. ✅ Update dry-run before/after diff döndürür.
7. ✅ Update apply sonrası after-read doğrulama yapar.
8. ✅ Unknown field update Directus'a gitmeden reddedilir.
9. ✅ Readonly field update Directus'a gitmeden reddedilir.
10. ✅ `directus_*` collection mutation reddedilir.
11. ✅ Delete default kapalıdır.
12. ✅ Batch update partial success raporlar.
13. ✅ Tests pass (`npm test`).
14. ✅ README içinde hem Streamable HTTP hem stdio bağlantı örneği vardır.
15. ✅ Kod TypeScript strict modda compile olur.
16. ✅ Streamable HTTP varsayılan transport, Bearer auth gate zorunlu.
17. ✅ Şirket/koleksiyon sabiti yok — generic Directus ürünü.
18. ✅ Stateless Streamable HTTP: `sessionIdGenerator: undefined` ile `initialize` → `tools/list` tek HTTP bağlantısında çalışır.
19. ✅ Endpoint path guard: sadece `/mcp` MCP endpoint, `/healthz` liveness probe, diğerleri 404.
20. ✅ Origin/Host guard (DNS rebinding + CSRF).
21. ✅ `MUTATION_REQUIRE_VERIFY=true` iken update'lerde verify zorunlu, `update_items_same_data` reddedilir.
22. ✅ Smoke testler proje içinde (`scripts/smoke-stdio.mjs`, `scripts/smoke-http.mjs`) — HTTP smoke test `tools/list`'i de doğrular.
23. ✅ Host allowlist port-tolerant: `mcp.example.com` allowlist'i `mcp.example.com:3333` Host header'ını da kabul eder.
24. ✅ `batch_update_items` ve `create_items` apply sırasında all-or-nothing preflight (`allow_partial_apply` default false). Abort durumunda sıfır yazma yapılır.
25. ✅ `read_item` single-mode: `limit`/`page`/`offset` reddedilir, default limit enjekte edilmez.
26. ✅ `content.text` token-bounded: gerçek sonuç (şema, kayıtlar, diff, hata, summary) kompakt formatta, `SCHEMA_TEXT_MAX_FIELDS` / `READ_TEXT_MAX_ROWS` / `READ_TEXT_MAX_CHARS` limitleriyle.
27. ✅ `directus_apply_plan` tool: dry-run plan'ını uygular, read-back verification yapar, idempotent (plan sadece bir kez apply edilir).
28. ✅ `directus_cancel_plan` tool: pending plan'ı iptal eder.
29. ✅ Dry-run mutation response'ları `planId` döndürür; `content.text` "DRY-RUN ONLY — hiçbir veri yazılmadı" içerir.
30. ✅ `APPLY_REQUIRES_PLAN=true` (default): direct `dry_run:false` reddedilir, model önce plan almalı.
31. ✅ Plan store: file-based (default) / memory, 0600 izinleri, TTL, max bytes, checksum.
32. ✅ Delete işlemleri de plan akışını kullanır (confirm token plan içinde saklanır).
33. ✅ Read-back mismatch post-write: warning olarak döner (throw etmez), plan `applied_with_warning` terminal durumu alır, tekrar apply edilemez.
34. ✅ Concurrent apply protection: atomik `pending → applying` claim, ikinci eşzamanlı apply `PLAN_ALREADY_IN_PROGRESS` alır.
35. ✅ Post-write unexpected error: plan `failed_after_write` terminal durumu alır, tekrar apply edilemez.
36. ✅ `directus_dry_run_mutation` planId üretmez — README ve agent instruction'da belgelendi.
37. ✅ Create işlemleri için gerçek read-back: created id bulunur, kayıt tekrar okunur, field değerleri doğrulanır.
38. ✅ Startup + periyodik (5 dk) plan cleanup: expired/cancelled/applied plan dosyaları temizlenir.
39. ✅ Batch tool `*_json` alanları string + array + object kabul eder (LibreChat uyumluluğu).
40. ✅ `directus_apply_plans` tool: çoklu plan toplu apply + `stop_on_error` desteği.
41. ✅ `directus_cancel_plans` tool: çoklu plan toplu cancel.
42. ✅ `directus_verify_fields_empty` tool: post-apply verification (JSON array field doluluk kontrolü, client-side).
43. ✅ JSON array alanlarında `_nnull`/`_nempty` filtrelerinin güvenilmez olduğu README'de belgelendi.
44. ✅ `directus_update_by_query_plan` tool: query ile toplu update planı + bundle (model kayıt listesi üretmez).
45. ✅ `directus_apply_plan_bundle` tool: bundle toplu apply + already-applied tolerant + verification.
46. ✅ `directus_plan_bundle_status` tool: bundle durum sorgulama.
47. ✅ `directus_verify_fields_value` tool: deep equality ile field değer kontrolü.
48. ✅ `verify_fields` auto-generation: update_item + update_by_query_plan (model verify üretmez).
49. ✅ Bundle sistemi: `bundle_id` ile tek referans (model planId listesi takip etmez).
50. ✅ NEXT ACTION text'leri tüm mutation/apply response'larında.

---

## Kaynaklar

- [Directus API Reference](https://directus.com/docs/api)
- [Directus Items API](https://directus.com/docs/api/items)
- [Directus Filter Rules](https://directus.com/docs/guides/connect/filter-rules)
- [Directus Issue #26891](https://github.com/directus/directus/issues/26891)
- [Directus PR #27005](https://github.com/directus/directus/pull/27005)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [MCP Transports Specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
