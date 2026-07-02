---
name: directus-safe-mcp-operations
description: Production-grade generic Directus operations using directus-safe-mcp in LibreChat. Enforces schema-first reads, text-first output interpretation, generic search, dry-run plan/bundle apply, verify_fields, server-side update-by-query planning, and post-apply verification.
always-apply: true
user-invocable: true
disable-model-invocation: false
---

# Directus Safe MCP Operations Skill — Generic Production

Bu skill, herhangi bir Directus projesinde `directus-safe-mcp` araçlarını güvenli, verimli ve düşük-parametreli modellerle stabil kullanmak için yazılmıştır.

Bu skill **firma, sektör, özel koleksiyon veya özel iş akışı bilmez**. İş kuralları; kullanıcı talebi, schema, varsa Directus içindeki rehber kayıtlar ve ajan talimatları üzerinden öğrenilir. MCP core yalnızca genel Directus okuma, arama, planlama, yazma ve doğrulama altyapısıdır.

---

## 0. Temel prensip

Her görevde önce şu ayrımı yap:

```text
Bilgi okuma mı?
Kayıt arama mı?
Tekil kayıt detayı mı?
Mutation/dry-run mı?
Toplu mutation mı?
Onay sonrası apply mı?
Doğrulama mı?
```

Modelin görevi veriyi tahmin etmek değil; Directus araçlarının döndürdüğü güvenli text/metadata’ya göre hareket etmektir.

---

## 1. Araç seti

Kullanılacak generic `directus_*` araçları:

### Schema

- `directus_schema_overview`
- `directus_schema_detail`

### Read / search

- `directus_search_items`
- `directus_read_items`
- `directus_read_item`

### Create / update / delete

- `directus_create_item`
- `directus_create_items`
- `directus_update_item`
- `directus_update_items_same_data`
- `directus_batch_update_items`
- `directus_delete_items`

### Plan / apply / cancel

- `directus_dry_run_mutation`
- `directus_apply_plan`
- `directus_apply_plans`
- `directus_cancel_plan`
- `directus_cancel_plans`

### Server-side bulk planning / bundle

- `directus_update_by_query_plan`
- `directus_apply_plan_bundle`
- `directus_plan_bundle_status`

### Verification

- `directus_verify_fields_empty`
- `directus_verify_fields_value`

Generic `items`, `schema`, `flows`, `operations`, `trigger-flow`, exec/script veya başka workaround araçlarıyla Directus CRUD yapma. `directus_*` araçları varken mutation için başka yol kullanma.

---

## 2. Tool bütçesi ve döngü kesme

Her tool çağrısından önce şu soruyu sor:

```text
Bu bilgi elimde zaten var mı?
```

Hedef tool bütçesi:

| Görev | Hedef tool sayısı |
|---|---:|
| Basit listeleme | 1-3 |
| Kayıt arama + listeleme | 2-4 |
| Tekil detay | 1-4 |
| Tekil update dry-run | 2-5 |
| Toplu update dry-run | 2-6 |
| Apply + doğrulama | 1-3 |

12 tool’u geçtiysen durumu özetlemeye hazırlan. 20+ tool çağrısı normal değildir; döngüyü kes ve kullanıcıya güvenli durum raporu ver.

Aynı read/search query’yi tekrarlama. Aşağıdakiler aynıysa yeni çağrı yapma:

- collection
- fields
- filter/search
- sort
- limit
- offset/page
- output_mode
- purpose

---

## 3. Schema-first ama verimli çalış

### Koleksiyon biliniyorsa

Doğrudan `directus_schema_detail` kullan. Gereksiz `schema_overview` çağırma.

### Koleksiyon belirsizse

Bir kez `directus_schema_overview` kullan. Ardından hedef koleksiyon için `directus_schema_detail` çağır.

### Rehber/veri sözlüğü koleksiyonu varsa

Projede rehber, prompt, açıklama, config, data dictionary gibi kayıtlar olabilir. Bunları özel tool varsaymadan generic arama ile bul:

```json
{
  "collection": "example_guides",
  "search": "tedarikçi",
  "search_fields": ["name", "description"],
  "fields": ["id", "name", "status", "description"],
  "limit": 10,
  "output_mode": "compact_full",
  "purpose": "list"
}
```

Koleksiyon adını veya alanları bilmiyorsan önce schema üzerinden öğren. Rehber koleksiyonun anlamını MCP core’dan değil, Directus verisinden ve ajan talimatından çıkar.

---

## 4. `directus_read_items` kullanımı

`directus_read_items`, listeleme ve filtreli okuma içindir.

### Basit listeleme

Kullanıcı “listele”, “kimler var”, “adları getir”, “websiteleri getir” gibi kısa liste istiyorsa:

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

`purpose:"list"` fields verilmemişse MCP generic kısa alanları seçer:

- primary key
- `company`, `name`, `title`, `stock_code`, `code`, `firstname`, `lastname`
- `website`, `url`, `email`, `phone`, `status`

Uzun alanlar otomatik çekilmemelidir:

- `ai_info`
- `description`
- `system_prompt`
- `messages`
- `products`
- `tags`
- `content`
- `body`
- rich text / büyük json / relation payload

### Belirli fields ile listeleme

Kullanıcı özel alan isterse açıkça fields ver:

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

### Uzun alan gerekiyorsa

Uzun alanları yalnızca kullanıcı açıkça isterse çek. Uzun alanlar text’te omit/preview edilebilir. Tam içerik gerekiyorsa tekil kayıt ve dar fields ile oku.

---

## 5. Text-first metadata’yı yorumlama

LibreChat ortamında model çoğunlukla tool’un text çıktısını işler. Bu yüzden metadata satırları karar için bağlayıcıdır.

Örnek başarılı tam liste:

```text
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

Bu durumda kullanıcı tam liste istediyse cevap verebilirsin.

### Tam liste için güvenli olmayan çıktı

Şu bayraklardan biri varsa tam liste cevabı verme:

```text
TEXT_RECORDS_COMPLETE: false
FIELD_VALUES_COMPLETE: false
TRUNCATED_FOR_TEXT: true
SAFE_FOR_FULL_LIST_ANSWER: false
HAS_MORE: true
```

Doğru davranış:

1. Görünmeyen kayıtları tahmin etme.
2. Kullanıcı tam liste istediyse daha dar fields veya `output_mode:"compact_full"` ile tekrar oku.
3. `HAS_MORE:true` ise offset/page ile devam oku.
4. Uzun alan omit edildiyse “bu alanların tam içeriği text’te yok” de veya tekil detay oku.

### Preview uyarısı

Tool çıktısında şu tarz ifade varsa:

```text
hidden from text preview — do not infer
```

görünmeyen kayıtlar model için yok hükmündedir. Görünmeyen satırlardan id, name, company, status veya başka değer üretme.

---

## 6. `directus_search_items` kullanımı

`directus_search_items`, bir koleksiyonda text aramak içindir. Koleksiyon biliniyor ama kayıt bulunacaksa read yerine search kullan.

### Ne zaman daha verimli?

| Durum | En verimli yöntem |
|---|---|
| “X adlı kayıt var mı?” | `directus_search_items` |
| “Şu kelimeyi içeren rehber kaydı bul” | `directus_search_items` |
| “Bu koleksiyondaki tüm kayıtları listele” | `directus_read_items` |
| “ID’si bilinen kaydı aç” | `directus_read_item` |
| “Filtre kesin ve structured ise” | `directus_read_items` filter |

### Generic search örneği

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

### `*_json` fallback

LibreChat bazen array/object alanlarında schema eşleşme hatası verebilir. Bu durumda `*_json` kullan:

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

Geçersiz JSON veya array olmayan değer hata verir. Aynı hatalı payload’u tekrar tekrar gönderme.

### Search output yorumu

`SAFE_FOR_FULL_LIST_ANSWER:true` ise arama sonucunu cevapta kullanabilirsin. Ancak search sonucu koleksiyondaki tüm kayıtlar demek değildir; sadece arama kriterine uyan kayıtlardır.

---

## 7. `directus_read_item` kullanımı

`directus_read_item`, ID/key bilinen tek kayıt içindir.

Ne zaman kullanılır:

- Kullanıcı belirli bir kaydın detayını ister.
- Search/list sonucu tek kayıt bulundu ve detay gerekli.
- Mutation öncesi hedef kaydı doğrulamak gerekir.

Örnek:

```json
{
  "collection": "articles",
  "key": 123,
  "fields": ["id", "title", "status", "content"]
}
```

Uzun field içeren tekil detayda text kesilebilir. Eğer uzun alan kritikse, tool metadata/uyarılarını dikkate al ve “tam içerik text’te görünmüyor” demeden kesin çıkarım yapma.

---

## 8. Truncated / hidden output kesin kuralı

Tool çıktısında aşağıdakiler varsa:

```text
hidden from text preview
TRUNCATED_FOR_TEXT: true
TEXT_RECORDS_COMPLETE: false
FIELD_VALUES_COMPLETE: false
SAFE_FOR_FULL_LIST_ANSWER: false
```

şunları asla yapma:

- Görünmeyen kayıtları batch item listesine ekleme.
- Görünmeyen id/name/company/status değerlerini tahmin etme.
- Önceki konuşma veya ezberle eksik satırları doldurma.
- “Toplam 49 kayıt var” diye 49 satır uydurma.
- Tam liste cevabı verme.

Doğru davranış:

1. Kullanıcı tam liste istiyorsa daha dar fields ile `compact_full` oku.
2. Kayıt sayısı çoksa stabil sort + offset ile sayfala.
3. Uzun alan gerekiyorsa tekil detay oku.
4. Toplu mutation gerekiyorsa manuel batch üretme; `directus_update_by_query_plan` kullan.

---

## 9. ID tahmini / sequential scan yasağı

Directus id değerleri ardışık kabul edilemez.

Yasak:

- `id=1..100` diye `directus_read_item` loop’u.
- Aradaki id boşluklarından kayıt tahmini.
- 403 veren id’yi tekrar tekrar deneme.
- Liste tamamlamak için read_item taraması.

Doğru:

- `directus_read_items` veya `directus_search_items` ile kayıtları al.
- Stabil sort + limit + offset kullan.
- Sadece tool sonucunda gerçekten dönen id’leri kullan.

---

## 10. Mutation genel güvenlik ilkesi

Yazma/silme işlemlerinde varsayılan akış:

```text
schema → hedef kayıt/scope doğrulama → dry_run:true → plan/bundle → kullanıcı onayı → apply → verify → cevap
```

Dry-run olmadan apply yapma.

Kullanıcı “hızlıca”, “acil”, “direkt yap” dese bile önce dry-run plan oluştur. Kullanıcı ilk mesajında açık onay vermediyse apply yapma.

Apply sonucu gelmeden “kaydedildi / güncellendi / uygulandı” deme.

---

## 11. Tekil update

Kullanıcı tek kayıt güncellemek isterse ve key biliniyorsa `directus_update_item` kullan.

`verify_fields` tercih et; MCP mevcut kaydı okuyup verify objesini server-side oluşturur.

Örnek:

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

Eğer `VERIFY_REQUIRED` gelirse verify eklemeden aynı çağrıyı tekrar etme. `verify_fields` kullan veya mevcut kaydı okuyup gerçek verify değeriyle çağır.

Yanlış verify örneği:

```json
{
  "verify": {
    "content": true
  }
}
```

`verify`, alanın yazılabilir olduğunu göstermez; mevcut kayıttaki beklenen değeri doğrular.

Doğru verify örneği:

```json
{
  "verify": {
    "title": "Current title"
  }
}
```

---

## 12. Toplu update için en verimli yöntem

### Aynı data çok kayda uygulanacaksa

Öncelik: `directus_update_by_query_plan`

Bu araç server-side çalışır:

- query ile kayıtları bulur
- gerçek kayıtları kullanır
- verify_fields ile verify üretir
- chunk’lara böler
- planları oluşturur
- tek `bundle_id` döndürür

Örnek:

```json
{
  "collection": "tasks",
  "query": {
    "filter": {
      "status": {
        "_eq": "open"
      }
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

Bu, manuel `read_items → items_json üret → batch_update` akışından daha güvenli ve verimlidir.

### Ne zaman `directus_update_items_same_data`?

Az sayıda kesin key listesi varsa ve verify ihtiyacı basitse kullanılabilir. Ancak `MUTATION_REQUIRE_VERIFY=true` ortamında çoğu toplu update için `directus_update_by_query_plan` daha güvenlidir.

### Ne zaman `directus_batch_update_items`?

Her kayıt için farklı data yazılacaksa veya kullanıcı açıkça kesin item listesi verdiyse kullan.

Örnek:

```json
{
  "collection": "tasks",
  "items_json": [
    {
      "key": 1,
      "verify": {
        "title": "Task A"
      },
      "data": {
        "priority": "high"
      }
    },
    {
      "key": 2,
      "verify": {
        "title": "Task B"
      },
      "data": {
        "priority": "low"
      }
    }
  ],
  "dry_run": true
}
```

Batch item listesi yalnızca şu kaynaklardan üretilebilir:

- tool çıktısında tam ve açık görünen kayıtlar
- kullanıcı tarafından açıkça verilen kesin kayıtlar
- server-side plan tool çıktısı

Preview/truncated text’ten batch üretme.

---

## 13. Bundle apply akışı

`directus_update_by_query_plan` sonucu `bundle_id` dönerse onay sonrası `directus_apply_plan_bundle` kullan.

Dry-run sonrası cevap:

```text
Dry-run hazırlandı. Veri yazılmadı.
Etkilenecek kayıt: X
Bundle ID: bundle_...
Onay verirsen directus_apply_plan_bundle ile uygularım.
```

Onay sonrası:

```json
{
  "bundle_id": "bundle_...",
  "confirm": true,
  "stop_on_error": true,
  "verify_after_apply": true
}
```

Apply sonucunda:

- `STATUS`
- `WRITTEN`
- `APPLIED`
- `FAILED`
- `READ_BACK_STATUS`
- `VERIFICATION`

alanlarını kontrol et.

`WRITTEN:true` veya doğrulanmış idempotent başarı görmeden “uygulandı” deme.

---

## 14. PlanId apply akışı

Tek plan için:

```json
{
  "plan_id": "plan_...",
  "confirm": true
}
```

Çoklu plan için:

```json
{
  "plan_ids": ["plan_1", "plan_2"],
  "confirm": true,
  "stop_on_error": true
}
```

Ancak yeni toplu işlemlerde bundle varsa plan listesi yerine bundle tercih et.

Onay sonrası aynı mutation tool’unu tekrar `dry_run:false` ile çağırma. Plan/bundle apply kullan.

---

## 15. PLAN_ALREADY_APPLIED yorumu

`PLAN_ALREADY_APPLIED` güvenlik/koruma durumudur; körlemesine başarısızlık değildir.

Doğru davranış:

1. Aynı planı tekrar apply etme.
2. `directus_plan_bundle_status`, apply response veya verification ile hedef durumu kontrol et.
3. Hedef durum doğruysa:

```text
Plan daha önce uygulanmış görünüyor. Tekrar yazılmadı. Hedef durum doğrulandı.
```

4. Hedef durum doğru değilse yeni dry-run planı oluşturmak gerektiğini söyle.

---

## 16. Create işlemleri

Yeni kayıt oluşturma için:

- tek kayıt: `directus_create_item`
- çoklu kayıt: `directus_create_items`

Önce schema kontrolü yap:

- required fields
- readonly fields
- allowed fields
- field type

Dry-run varsa önce dry-run. Create sonrası kayıt id’sini ve kritik alanları doğrula.

Aynı kaydı duplicate oluşturma riskine karşı önce search/read ile varlık kontrolü yap. Özellikle kullanıcı “ekle” dediğinde kayıt zaten var mı araştır.

---

## 17. Delete işlemleri

Silme en riskli işlemdir.

Kurallar:

1. Hedef scope kesin değilse delete planlama.
2. Önce read/search ile hedef kayıtları göster.
3. `directus_delete_items` dry-run yap.
4. Etkilenecek kayıt sayısını söyle.
5. Kullanıcı açıkça onay verirse apply.
6. Delete sonrası doğrulama yap.

Belirsiz filtreyle delete yapma.

---

## 18. Verification araçları

### Boşaltma/temizleme

`directus_verify_fields_empty` kullan.

Boş kabul:

- `null`
- `undefined`
- `""`
- whitespace string
- `[]`
- `{}`

### Belirli değere set

`directus_verify_fields_value` kullan.

Örnek:

```json
{
  "collection": "tasks",
  "expected": {
    "status": "archived"
  },
  "query": {
    "filter": {
      "status": {
        "_eq": "archived"
      }
    },
    "fields": ["id", "title", "status"],
    "limit": 100
  }
}
```

Array/object karşılaştırmaları deep equality ile yapılır. `["test"]` ile `["TEST"]` aynı değildir.

### Apply response verification

Apply response içinde `readBackStatus` veya `verification` varsa bunları yorumla. Şüpheli durumda ek verification çağır.

---

## 19. JSON / array / object alanları

Array/object alanlarında filtreye tek başına güvenme. `_nnull` veya `_nempty` bazı veri tiplerinde beklediğin semantiği vermeyebilir.

Boş/dolu kararını verification ile destekle.

`*_json` fallback kullanılabilir:

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

Schema hatasında aynı payload’u ısrarla tekrar etme. En fazla normal alan ve `*_json` fallback dene; olmazsa dur.

---

## 20. Hata sınıflandırma ve davranış

### Schema / payload hataları

- `Received tool input did not match expected schema`
- `INVALID_DATA_TYPE`
- `INVALID_QUERY`
- `UNKNOWN_FIELD`
- `READONLY_FIELD`

Davranış:

- Payload’u düzelt.
- Field adlarını schema_detail ile doğrula.
- Aynı hatalı çağrıyı tekrar etme.

### Permission / RBAC hataları

- `403`
- `FORBIDDEN`
- `permission`
- field access denied

Davranış:

- Aynı kaydı/field’ı tekrar tekrar deneme.
- Kullanıcıya erişim sorunu olduğunu söyle.
- Alternatif allowed field veya daha dar query dene.

### Verify hataları

- `VERIFY_REQUIRED`
- `VERIFY_FAILED`

Davranış:

- `verify_fields` kullan.
- Verify mevcut kayıt değeriyle eşleşmeli.
- `VERIFY_FAILED` durumunda key ve verify aynı kayda ait olmayabilir; tahmini batch’i at.

### Plan hataları

- `APPLY_REQUIRES_PLAN`
- `CONFIRM_TRUE_REQUIRED`
- `PLAN_NOT_FOUND`
- `PLAN_EXPIRED`
- `PLAN_ALREADY_APPLIED`
- `PLAN_ALREADY_IN_PROGRESS`
- `PLAN_CANCELLED`
- `PLAN_CHECKSUM_MISMATCH`
- `READBACK_MISMATCH`

Davranış:

- Plan durumunu yorumla.
- Gerekirse yeni dry-run oluştur.
- Apply sonucunu görmeden başarı deme.

---

## 21. External content ile Directus update

Bu skill web/scrape aracı değildir. Ancak başka bir ajan/tool dış kaynak içeriği sağlayıp Directus alanı güncellemeni isterse, update dry-run’dan önce kaynak ve hedef kaydı doğrula.

Zorunlu generic kapı:

1. Hedef Directus kaydını oku:
   - primary key
   - display field (`name`, `title`, `company`, `code` vb.)
   - varsa `website` veya kaynak referans alanı
   - güncellenecek alanın mevcut değeri
2. Dış kaynak URL/metadata/content hedef kayıtla uyumlu mu kontrol et.
3. İçerikte hedef kayıtla ilgisiz baskın marka/konu varsa reddet.
4. Önceki kayıttan kopyalanmış veya başka entity’ye ait içerik şüphesi varsa update planı oluşturma.
5. Rich text/markdown alan güncellenecekse kaynaklar bölümünü ekle.
6. Sadece kaynakta açıkça doğrulanan bilgileri yaz.
7. `directus_update_item` için `verify_fields` kullan ve `dry_run:true` ile plan oluştur.
8. Kullanıcıya onay öncesi kısa kaynak doğrulama özeti ver.

Kaynak doğrulaması geçmezse:

```text
Kaynak hedef Directus kaydıyla güvenli şekilde eşleşmedi. Update dry-run oluşturmuyorum.
```

---

## 22. `include_system` kuralı

Normal içerik koleksiyonları için `include_system:false`.

`include_system:true` yalnızca kullanıcı açıkça Directus sistem koleksiyonları, permission/debug, user/role/policy analizi isterse kullanılabilir.

---

## 23. Para birimi / birim varsayımı yapma

`price`, `amount`, `stock`, `quantity`, `total` gibi alanlarda birim veya para birimi görünmüyorsa varsayma.

Doğru ifade:

```text
price alanı 120 görünüyor; para birimi alanı bu çıktıda görünmüyor.
```

Yanlış:

```text
120 TL / 120 USD
```

---

## 24. En verimli yöntem seçimi

| Kullanıcı isteği | En uygun araç |
|---|---|
| Koleksiyonları gör | `directus_schema_overview` |
| Koleksiyon fieldlarını öğren | `directus_schema_detail` |
| Kelimeyle kayıt bul | `directus_search_items` |
| Kısa tam liste ver | `directus_read_items` + `purpose:list` + `output_mode:compact_full` |
| ID/key bilinen kaydı aç | `directus_read_item` |
| Tek kayıt güncelle | `directus_update_item` + `verify_fields` |
| Aynı değişikliği filtreye uyan çok kayda uygula | `directus_update_by_query_plan` |
| Farklı datalarla batch update | `directus_batch_update_items` |
| Query plan apply | `directus_apply_plan_bundle` |
| Tek plan apply | `directus_apply_plan` |
| Çoklu plan apply | `directus_apply_plans` |
| Alanlar boş mu doğrula | `directus_verify_fields_empty` |
| Alanlar belirli değerde mi doğrula | `directus_verify_fields_value` |

---

## 25. Cevap formatları

### Listeleme sonrası

```text
Bulunan kayıt: X
Liste tam mı: evet/hayır
Kullanılan alanlar: ...
Sonuç:
...
```

Eğer `SAFE_FOR_FULL_LIST_ANSWER:false`:

```text
Bu çıktı tam liste cevabı için güvenli değil. Görünen kayıtları paylaşabilirim veya daha dar alanlarla tam listeyi tekrar çekebilirim.
```

### Dry-run sonrası

```text
Dry-run hazırlandı. Veri yazılmadı.
Koleksiyon: ...
Etkilenecek kayıt: X
Plan/Bundles: ...
Değişecek alanlar: ...
Onay verirsen uygularım.
```

### Apply sonrası

```text
Uygulama sonucu:
Applied: X/Y
Failed: 0
Warnings: 0
Read-back: OK
Verification: OK
```

### Hata/durma

```text
İşlem tamamlanmadı.
Durduğum nokta: ...
Sebep: ...
Güvenli sonraki adım: ...
```

---

## 26. Mutlak yasaklar

- Aynı read/search query’yi tekrar tekrar çağırma.
- Truncated/hidden text’ten görünmeyen kayıtları tahmin etme.
- Sequential id scan yapma.
- 403 veren id/field için loop’a girme.
- Şema okumadan mutation yapma.
- Dry-run olmadan apply yapma.
- Kullanıcı onayı olmadan apply yapma.
- Apply sonucu gelmeden başarı deme.
- Toplu mutation için preview text’ten batch üretme.
- Toplu işlem sonrası doğrulama yapmadan “tümü tamam” deme.
- Kullanıcı istemeden uzun field çekme.
- Özel şirket/iş akışı varsayma.
- MCP core dışında Directus CRUD workaround yapma.
- `allow_partial_apply:true` kullanma, kullanıcı açıkça istemedikçe.
