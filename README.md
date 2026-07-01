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
| `LOG_LEVEL` | `info` | pino log level |

---

## MCP Tool Listesi

11 tool register edilir (hepsi `directus_` prefix'i ile):

| Tool | Açıklama |
|---|---|
| `directus_schema_overview` | Koleksiyon listesi + PK + field count |
| `directus_schema_detail` | Bir veya birden fazla koleksiyonun tam şema detayı |
| `directus_read_items` | Liste okuma (validate edilmiş query ile) |
| `directus_read_item` | Tek item okuma |
| `directus_create_item` | Tek item create (dedupe + dry-run destekli) |
| `directus_create_items` | Batch create (serial, per-item result) |
| `directus_update_item` | Tek item update (read-before → verify → diff → write → after-read) |
| `directus_update_items_same_data` | Bulk PATCH /items/{collection} (aynı data, multi key) |
| `directus_batch_update_items` | Per-item different data update (serial PATCH) |
| `directus_delete_items` | Delete (default kapalı, confirm gerekli) |
| `directus_dry_run_mutation` | Çoklu operasyon planı (dry-run only) |

### Tool input kuralları

- `data`, `items`, `keys`, `query`, `filter`, `deep`, `verify`, `dedupe`, `operations` hem native JSON hem de `<field>_json` string formunda kabul edilir. Wrapper otomatik parse eder.
- Update işlemlerinde `verify` field'ları mevcut kayıtla eşleşmezse `VERIFY_FAILED` hatası döner; yazma yapılmaz.
- Unknown field → `UNKNOWN_FIELD` hatası (sessizce drop edilmez).
- Readonly / system audit field'lar (`user_created`, `date_created`, `user_updated`, `date_updated`) → `READONLY_FIELD` hatası.
- Primary key update → `PRIMARY_KEY_UPDATE_DENIED`.
- `directus_*` koleksiyonlarında mutation → `SYSTEM_COLLECTION_DENIED`.
- Filter operator whitelist dışı → `INVALID_FILTER_OPERATOR`.
- Wildcard field default olarak reddedilir (`ALLOW_WILDCARD_FIELDS=false`).

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

Hata kodları: `CONFIG_ERROR`, `DIRECTUS_API_ERROR`, `COLLECTION_NOT_ALLOWED`, `SYSTEM_COLLECTION_DENIED`, `SCHEMA_NOT_FOUND`, `PRIMARY_KEY_NOT_FOUND`, `UNKNOWN_FIELD`, `READONLY_FIELD`, `PRIMARY_KEY_UPDATE_DENIED`, `REQUIRED_FIELD_MISSING`, `INVALID_QUERY`, `INVALID_FILTER_OPERATOR`, `VERIFY_FAILED`, `VERIFY_REQUIRED`, `ABORTED_BY_PREFLIGHT`, `DUPLICATE_FOUND`, `BATCH_LIMIT_EXCEEDED`, `DELETE_DISABLED`, `CONFIRMATION_REQUIRED`, `INVALID_JSON`, `INVALID_DATA_TYPE`, `DRY_RUN_REQUIRED`, `NOT_FOUND`.

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

---

## Kaynaklar

- [Directus API Reference](https://directus.com/docs/api)
- [Directus Items API](https://directus.com/docs/api/items)
- [Directus Filter Rules](https://directus.com/docs/guides/connect/filter-rules)
- [Directus Issue #26891](https://github.com/directus/directus/issues/26891)
- [Directus PR #27005](https://github.com/directus/directus/pull/27005)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [MCP Transports Specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
