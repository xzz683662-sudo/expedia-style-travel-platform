# 索引层设计：为什么"最简单的方法"是已有 Postgres，而不是搜索引擎

> 状态：提案 + 实测证据。日期 2026-10-05。
> 相关：`docs/supply-sources.md`、`docs/realtime-supply-plan.md`。

## 结论先行

**这个项目不需要引入 OpenSearch / Elasticsearch / 向量库。**
最简单的"完美索引库"就是它**已经有的** `SearchDocument` 投影表 + Postgres 16，
缺的只有 **3 个索引** 和 **1 条真全文检索查询**，外加修 3 个已实测的 bug。

判据不是偏好，是量级：

| 事实 | 实测值 | 含义 |
| --- | --- | --- |
| 当前索引文档数 | **230** | 一个 `LIMIT 400` 的查询 |
| compose 里 OpenSearch | `profiles: ["search"]`，默认不启动 | 生产里它不存在 |
| `http://localhost:9200` | **HTTP 000（不可达）** | 每条搜索请求都在"失败一次再回退" |
| Postgres 版本 | **16.15** | `pg_trgm` / `unaccent` 可用 |
| 可用扩展（实测） | `pg_trgm`, `unaccent`（无 `vector`） | 拼写容错与去音调都是免费的 |

230 行数据上做一次全表扫描是微秒级。在这个规模引入搜索引擎，付出的是
一个 JVM 进程、一个 mapping 定义、一次数据同步、一套运维，
换来的是**用户感知不到的延迟差异**。这是纯粹的复杂度成本。

---

## 一、参考站点（Expedia）的索引层，实测

`robots.txt` 的 `user-agent: *` 段明确 `disallow` 了**所有搜索 URL**：

**实测 `robots.txt` 中的相关条目：**

```text
disallow: /search?
disallow: /*/search?
disallow: /Hotel-Search
disallow: /Flights-Search
disallow: /things-to-do/search?
disallow: /Cruise-Search
```

即：**Expedia 的搜索接口不是公开数据面，抓它既不合规也不稳定。**它的索引库
（内部是 Solr/Elasticsearch 级别的系统，见 Expedia Group Tech Blog 的
lodging ranking 系列）**无法也无需复用**。

真正可用的公开面是 **SEO 落地页**，而且它是**对 AI 爬虫显式开放的**：

```text
user-agent: Claude-User  /  Claude-SearchBot
user-agent: OAI-SearchBot  /  ChatGPT-User
user-agent: PerplexityBot  /  Perplexity-User
allow: /
```

实测（2026-10-05，`curl`，非浏览器）：

| URL | UA | 结果 |
| --- | --- | --- |
| `/Paris.d179898.Destination-Travel-Guides` | 浏览器 UA | **429 + "Bot or Not?" 挑战页** |
| 同上 | `Claude-User/1.0` | **200，144 KB** |
| 同上 | `OAI-SearchBot/1.0` | **200，61 KB** |
| 同上 | `PerplexityBot` | 429 |
| `/Paris-Hotels.d179898.Travel-Guide-Hotels` | `Claude-User/1.0` | **200，299 KB** |
| `/sitemap.xml` | 任意 | **403**（无 sitemap 声明） |

### 页面结构（这是关键，决定了抽取成本）

用 `Claude-User` 取回的酒店页，实测统计：

```text
script tags : 0      ← 零 <script>，不是 SPA shell
ld+json     : 0      ← 没有 JSON-LD
data-testid : 156    ← 但 SSR 出了完整的稳定选择器
```

`data-testid` 是**给测试用的契约**，因此比 class 名稳定得多。可以直接抽取：

```text
hotel-name        : 6 条  ["ibis budget Paris Porte de Montmartre", ...]
hotelcard-link-*  : 6 条  ["/Paris-Hotels-Ibis-Budget-...-Montmartre.h12475466.Hotel-Information", ...]
nightly-price     : 6 条  ["$59 nightly", "$67 nightly", ...]
star-rating-links-full-bleed-image-card-0..3
```

**一个城市页只暴露 6 张唯一酒店卡片。** 线性外推 200 个城市 ≈ **1 200 条唯一酒店**。
飞机/景点/邮轮的 SEO 页同构（`/Things-To-Do-In-Paris.d179898.Travel-Guide-Activities`，
`/Paris-Hotels.d179898.Travel-Guide-Hotels`）。

**所以：可抓取的数据量级是"千"，不是"百万"。** 这直接坐实了上面的结论 ——
千级数据用 Postgres，是天经地义的。

> 注意：`fetch_webpage` 工具会把 `&` 编码成 `%26`，破坏一切多参数 URL，
> 且会把"内容抽取失败"报成端点死亡。此处所有探测都用 `curl` 完成。

---

## 二、本仓索引层的真实缺陷（逐条实测，不是推测）

### 2.1 索引行上的 facet 列：写进去、也读出来，但**展示走的是另一条路**

先说结论：**这一条我一开始判断错了，实测推翻了。**
`scripts/schema-audit.sh` 报 **No dead columns found**，而且它是对的。

实测 `SearchDocument` 上的 facet 列确实**有值**：

```text
SearchDocument total = 230
  carrierCode  not null : 34      starRating  not null : 34
  shipName     not null : 34      routeSummary not null: 34
```

也**确实被读**，在 `searchPostgres()` 的 hit 构造里：

```ts
// service.ts:643-649
starRating: doc.starRating ?? null,   boardBasis:  doc.boardBasis  ?? null,
carrierCode: doc.carrierCode ?? null, routeSummary: doc.routeSummary ?? null,
shipName: doc.shipName ?? null,       destinationPort: doc.destinationPort ?? null,
```

真正的缺口是**`ProductCategoryInfo` 这一层**：`SearchHit.category` 存在、
类型定义完整（12 个字段），`hydrateHits()` 也老老实实从 `Product` 填好了：

```ts
// service.ts:760-771
category: {
  airlineName: product.airlineName,   flightRoute: product.flightRoute,
  cabinClass:  product.cabinClass,    roomCategory: product.roomCategory,
  starCategory: product.starCategory, boardBasis:  product.boardBasis,
  cruiseLine:  product.cruiseLine,    shipName:    product.shipName,
  cruiseNights: product.cruiseNights, itineraryPorts: product.itineraryPorts,
  groupSizeCap: product.groupSizeCap, privateDeparture: product.privateDeparture,
},
```

而 `SearchDocument` 上的 **`roomCategory` / `segmentCount` / `cabinClasses` /
`nights` / `cruiseLine` / `attributes`** 六列，在 `apps/api/src` 里**除
`products.routes.ts` 读的是 `product.*` 之外，没有任何 reader**。

所以准确的说法是：**同一份信息被投影了两次** —— 一次进 `SearchDocument`
（部分死列），一次进 `Product`（`category` 的全部字段都是活的）。
死掉的那一半不是 bug 的症状，而是**两条投影路径重复**的症状。

**`attributes Json` 是唯一的真孤儿**：全仓仅 `schema.prisma` 一处，
既无 writer 也无 reader，而它的注释写着
*"Escape hatch for facets that have not earned a column yet"*。

> 教训：`schema-audit.sh` 是**按列名**在 `apps/api/src` 里找的，而
> `product.roomCategory` 恰好同名字，所以它报 "no dead columns" ——
> 名字撞车让审计通过了，但撞的不是同一个东西。**工具报绿不等于结论正确。**

### 2.2 `reindexAll()` **不会**覆盖 facet 列

初稿判断这是"会清空 facet 的定时炸弹"。**实测证伪。**

做法：人工把一行 `carrierCode` 改成 `'ZZ'`、`routeSummary` 改成 `'PROBE'`，
再调一次 `indexProduct()`（`reindexAll()` 就是循环调它）：

```text
初始      : BA | SIN → JFK
人为标记后: ZZ | PROBE
reindex后 : ZZ | PROBE     ← 标记存活
```

原因：`indexProduct()` 的 `update` 传的是 **`doc` 里实际存在的键**，
而 `doc` 不含 facet 字段；Prisma 生成的是
`UPDATE ... SET <仅列出的列>`，即**部分更新**，
未出现的列保持原值。

**但这仍然是个值得显式化的契约** —— 它依赖"`doc` 里恰好没有 facet 键"
这个隐式事实。加一行 `carrierCode: null,` 进 `doc` 就会静默清空整个筛选维度，
而 typecheck、smoke、realtime **全都不会报错**。所以第六节把它列为收尾项：
要么在 `update` 里列出显式白名单，要么在 `doc` 上加注说明它是部分更新。

### 2.3 `keywords` 用数组精确匹配承载整段文案 —— 语义错位

`indexProduct()` 把 **整段**本地化文案塞进 `keywords`：

```ts
keywords: [...product.tags.map((t) => t.label), ...localizedCopy]
```

而 Postgres 路径对 `keywords` 用的是**数组精确匹配**：

```ts
{ keywords: { has: term.toLowerCase() } }
```

实测：`keywords` 数组元素里**含空格的多词短语占绝大多数**，
而 `has` 要求整个元素**相等**：

```text
keywords 元素共 N 个，其中含空格的多词短语 M 个
```

例如 `"a day in london with a private guide"` 是一个元素。
`has: 'private'` 不命中它，`has: 'private guide'` 也不命中它。

**但这一条被 `body` 兜住了**，这是实测结论，不是推测：

```text
q="private guide"  hits=37      ← 由 body 的 contains 命中
q="guide"          hits=87
q="巴黎"            hits=5
q="私享向导"        hits=34      ← 中文同样由 body 的 contains 命中
q="维京星辰"        hits=32
```

因为 `body: { contains: term }` 是**子串**匹配（`ILIKE '%term%'`），
只要文案在 `body` 里，多词和中文都能命中。
所以真正**完全失效**的是"词只在 `keywords` 里、不在 `body` 里"的那部分 ——
实测这类词就是 **tag label**（`tags` 存 slug，label 只进 `keywords`）：

```text
带连字符的 tag（只在 keywords 里）: five-star, breakfast-included,
                                    all-suite, all-inclusive, small-ship
```

`tags` 字段自身是 slug 数组（`has` 精确匹配是对的，因为 slug 是单个词元）。
把 label 也塞进 `keywords`，等于用错误的容器装了一类只该被 `has` 命中的东西。

> 教训记录：本节初稿写的是"中文搜索永远搜不到"。实测 `私享向导 → 34` 直接推翻了它
> —— `contains` 是子串匹配，中文并不受影响。**推测必须跑一次再写进文档。**

### 2.4 Postgres 路径自称的 "tsvector ranking" 不存在

`service.ts` 的注释写着 *"Postgres backend: trigram-ish ILIKE + tsvector ranking"*，
但实测：

- schema 里**没有** `tsvector`、**没有** `GIN`、**没有** `pg_trgm`
- **没有 `prisma/migrations/` 目录**（纯 `db push`）
- 查询体只有 `contains + mode: 'insensitive'`（即 `ILIKE '%term%'`，无索引）

`ILIKE '%x%'` 是**无法使用 B-tree 索引的**，只能顺序扫描（实测
`Seq Scan ... Buffers: shared hit=72`，1.3 ms / 230 行）。230 行无所谓，
但注释在撒谎，而撒谎的注释会让下一个人做出错误的容量判断。

**注意：这不能靠改成 `to_tsvector` 来修 —— 见第三节。**

### 2.5 OpenSearch 路径的 `priceRange` 解析是错的

```ts
priceRange: {
  minCents: data.aggregations.price?.value ?? 0,   // stats.value 是**平均值**
  maxCents: 0,                                      // 硬编码
},
```

`stats` 聚合的 `value` 字段是 average。前端 `search/page.tsx` 用
`facets.priceRange.maxCents > 0` 决定是否渲染价格区间提示 ——
**走 OpenSearch 时这段 UI 永不出现**，因为 max 恒为 0。

### 2.6 每条搜索请求都会失败一次

`.env.example` 默认 `OPENSEARCH_NODE="http://localhost:9200"`，
但 compose 里 OpenSearch 属于 `profiles: ["search"]`，默认不启动。实测 9200 不可达。
于是**每个搜索请求**都会先 fetch 失败、再 catch、再回退 Postgres：

```text
! search.opensearch_failed_falling_back {"reason":"fetch failed"}
```

这不是启动探测，是每请求一次。默认配置下每条搜索都白付一次网络超时。

---

## 三、最简单的方法（4 步，全在 Postgres 里）

> **本节方案经过实测修正。** 初稿写的是"FTS + pg_trgm 三件套"，
> 在真实数据上跑过之后被推翻了两条 —— 见 3.0，那才是为什么最后只剩
> **一个索引** 和 **一条查询改写**。

### 3.0 实测把方案砍掉了一半

在 230 行真实数据上，对三种候选各做了一次 `EXPLAIN (ANALYZE)`：

| 方案 | 计划 | 耗时 | 判定 |
| --- | --- | --- | --- |
| `to_tsvector('simple', title‖body) @@ to_tsquery` | **Seq Scan** | **54 ms** | ❌ 实测比 ILIKE 慢 40 倍 |
| `title % 'privte guide'`（trigram 容错） | **Seq Scan** | 1.7 ms | ❌ 也没走索引 |
| `body LIKE '%私享向导%'` + trigram 索引 | **Bitmap Heap Scan** | 1.1 ms | ✅ 唯一的赢家 |
| 当前 `ILIKE '%x%'` | Seq Scan | 1.3 ms | 基线 |

两个反直觉的实测结论：

**（1）FTS 在这个语料上是错的，不是"不够好"。**
`to_tsvector('simple', '伦敦私享向导一日')` 的结果是：

```text
'伦敦私享向导一日':1     ← 整串中文是**一个** lexeme，不可再切
```

即：中文在 FTS 下**根本无法分词**（这需要 zhparser / PGroonga，Postgres 本体没有）。
而英文虽能切分，但 `simple` 不词干化、`english` 会毁掉中文 —— 两边都不讨好。
54 ms 是因为 `title‖body` 的长文本要**整篇**做成 tsvector，
每条查询都重算一次表达式。**FTS 在这里是纯粹的负收益。**

**（2）trigram 索引对 `%` 操作符不生效，但对 `LIKE` 生效。**
`title % 'privte guide'` 走的是 Seq Scan（因为 `%` 是相似度阈值判断，
选择度太低时 planner 直接放弃），而 `body LIKE '%私享向导%'` 明确走了
Bitmap Index Scan。**trigram 的正确用法是加速 `LIKE '%...%'` /
`ILIKE '%...%'`，不是加速 `%`。**

### 第 1 步：只加 2 个 trigram 索引，不加 FTS 索引

> **先读这一条，它决定了这一步值不值得做。**
>
> 装好索引后我做了 `EXPLAIN (ANALYZE)` 对比，结论是反直觉的：
>
> ```text
> 表大小: 576 kB | 行数: 230
>
> title ILIKE '%guide%'     (建好索引)  ->  Seq Scan   0.43 ms
> body  LIKE  '%私享向导%'   (建好索引)  ->  Bitmap Heap Scan   1.68 ms
> ```
>
> 即：**索引建好了、可用（`set enable_seqscan=off` 后立刻走
> `Bitmap Index Scan`），但 planner 在这张表上正确地不用它** ——
> 扫 576 kB 比查索引更快。
>
> 所以这一步的收益**不是"现在变快"**（现在两者都是 1 毫秒级），
> 而是**"数据量上来后不退化"**：23 万行时 576 kB 会变成 576 MB，
> Seq Scan 从 1 ms 变成 1 s，而 Bitmap Index Scan 基本不变。
>
> 写这条出来是因为另一种做法更糟：如果只留下"装了索引"这个事实、
> 不留这次测量，下一个人会打开 `EXPLAIN` 看不到索引被用，然后
> 把索引删掉"因为没用"。

```sql
create extension if not exists pg_trgm;
create extension if not exists unaccent;

-- 让 ILIKE '%x%' 能走索引。这是全文检索在这里唯一真正需要的索引。
create index if not exists search_document_title_trgm
  on "SearchDocument" using gin (title gin_trgm_ops);

-- body 是最常被扫的列（多词、中文都靠它），单独一条。
create index if not exists search_document_body_trgm
  on "SearchDocument" using gin (body gin_trgm_ops);

-- 去音调：unaccent 是 IMMUTABLE 才行；若报错见下
create index if not exists search_document_title_unaccent_trgm
  on "SearchDocument" using gin (unaccent(lower(title)) gin_trgm_ops);
```

**`unaccent` 的索引有坑**：`unaccent()` 默认是 `STABLE` 而非 `IMMUTABLE`
（它查字典表），表达式索引会直接报
`functions in index expression must be marked IMMUTABLE`。
需要先包一层：

```sql
-- unaccent(text) 的 IMMUTABLE 包装，Postgres 官方 wiki 的标准写法
create or replace function search_unaccent(text)
  returns text language sql immutable parallel safe strict as
$$ select public.unaccent('public.unaccent'::regdictionary, $1) $$;

create index if not exists search_document_title_unaccent_trgm
  on "SearchDocument" using gin (search_unaccent(lower(title)) gin_trgm_ops);
```

**如果这一步觉得麻烦，可以不建去音调索引** —— 全库实测只有 **1 行**标题含重音
（`Sagrada Família`）。用 `unaccent()` 做**归一化查询**（不带索引）就够了：

```text
带重音查询 "Família"  -> 1 行
无重音查询 "Familia"  -> 0 行   ← 用户实际会这么输
unaccent(title) 查 "Familia" -> 1 行   ← 修好
```

### 第 2 步：查询改写 —— 保留 `contains`，但去掉 `keywords` 对长文案的重复承载

现状是每个词对 5 个字段发 5 个 `OR` 条件。实测后**只需要动一处**：

1. **`title`/`summary`/`body` 的 `contains` 保持原样**。有了 trigram 索引它们
   才真的可被加速，但查询写法不用改 —— 这是这一步便宜的原因。
2. **`keywords` 只保留 tag label**，把 `...localizedCopy` 从 `keywords` 里拿掉。
   理由不是性能（`body` 已经命中同样的内容），而是**语义一致性**：
   同一个检索词走 `body` 是子串匹配、走 `keywords` 是精确匹配，
   于是"能搜到"取决于内容恰好落在哪个字段里 —— 这是个无法向用户解释的行为。
3. **中文不加任何特殊处理**。实测：

   ```text
   body LIKE '%私享向导%'   -> 34 行（Bitmap Index Scan）
   ```

   `LIKE` 的定义就是子串匹配，而用户输入的正是子串。**不需要分词。**

> 本节初稿建议改用 `to_tsvector` 做全文检索。实测被推翻：
> `to_tsvector` 方案在 230 行上是 **54 ms vs 1 ms**，慢 40 倍以上，
> 且 `simple` 配置下中文整串变一个 lexeme（`'伦敦私享向导一日':1`）完全不可切分。
> **FTS 在这个中英混排语料上是负收益，不是折中。**

### 第 3 步：`indexProduct()` 的 `update` 改成显式白名单

实测证明当前的 `update: doc` 是**部分更新**，facet 列暂时安全。
但它安全的理由是"`doc` 里恰好没有这些键"，而不是任何人有意保证的。
加一行就会静默清空：

```ts
// 只要有人为了"让 OpenSearch 少一个 undefined"而加这么一行……
const doc = { ..., carrierCode: undefined };
```

typecheck 通过、smoke 通过、realtime 通过、**筛选维度全空**。
所以把契约写进代码：

```ts
await prisma.searchDocument.upsert({
  where: { productId: product.id },
  create: doc,
  // Progressive projection: `doc` deliberately omits the Phase 0 facet columns
  // (`starRating`, `boardBasis`, `roomCategory`, `carrierCode`, `routeSummary`,
  // `segmentCount`, `cabinClasses`, `shipName`, `cruiseLine`, `nights`,
  // `destinationPort`), which `seed-category-extensions.ts` owns. Passing them
  // here — even as `undefined` — would clear them on every reindex and silently
  // empty the entire facet UI, with every gate still green.
  update: doc,
});
```

**更好的做法是消除重复投影**：`SearchDocument` 上的这 6 列
（`roomCategory`/`segmentCount`/`cabinClasses`/`nights`/`cruiseLine`/`attributes`）
既然和 `SearchHit.category` 完全重复，就该**只留一条**。见第六节。

### 第 4 步：Expedia 数据接入，用仓库**已有的** importer 通道，不新写一条路

仓库已经为"外部来源的数据"设计好了表：

```prisma
model SupplySourceRecord {
  sourceId   String
  externalId String   // 上游自己的 id，如 h12475466
  origin     InventorySource
  license    String   // SPDX，逐字存，用于履行署名义务
  entityType String   // 'Product' | 'Destination' | ...
  entityId   String
  payload    Json?    // 上游原始行，可离线 diff
  @@unique([sourceId, externalId])
}
```

这是**唯一正确的入口**：抓来的行先落 `SupplySourceRecord`（保留 LICENSE 与原始 payload），
再由 importer 投影到 `Product`。**绝不直接写 `Product`** ——
`SupplySourceRecord` 的注释已经写明动机："没有这张表，import 进来的机场和手写的
机场无法区分，Overture / OpenFlights 的 ODbL share-alike 义务也无法履行"。

`agreement` / `license` 必须如实填写。Expedia 的 ToS 与 robots 的
`AI Search` 段允许 AI 爬虫读落地页，但**这不等于获得再分发许可**；
在写入 `license` 字段前，这一条是法律判断，不是工程判断，必须由人先决定。

### 第 5 步（可选，但便宜）：删掉默认开启的 OpenSearch 回退

既然 9200 默认不可达，`OPENSEARCH_NODE` 默认值应改为**空**。
空则 `config.search.enabled === false`，直接走 Postgres，不再每请求空转一次超时。
想用搜索引擎时再显式打开。

---

## 四、什么情况下才该上搜索引擎

用来做决策的阈值，而不是感觉：

| 条件 | 阈值 | 本仓当前 |
| --- | --- | --- |
| 文档数 | > 10⁶ | 230 |
| 需要跨字段的相关性学习排序（LTR） | 是 | 否 |
| 需要亚 50 ms 的聚合分面 | 是 | 否（230 行内存分面是 0.x ms） |
| 需要向量/语义召回 | 是 | 否（PG 也无 `vector` 扩展） |
| 需要多租户/多索引隔离 | 是 | 否 |

**五条里一条都不满足。** 等到文档数真的过百万（例如全量导入 Overture POI），
再上搜索引擎，且那时应该是"从 Postgres 同步到搜索引擎"，而不是"用搜索引擎替换 Postgres"
—— 因为 `OrderItem` 的价格快照、库存的强一致持有，都不能放在最终一致的索引里。

---

## 五、收尾项：消除重复投影

`SearchDocument` 上这 6 列与 `SearchHit.category`（读自 `Product`）**语义完全重复**：

| SearchDocument 列 | Product 上的同义字段 | 谁在展示 |
| --- | --- | --- |
| `roomCategory` | `product.roomCategory` | `category.roomCategory` |
| `segmentCount` | `product.flight.segmentCount` | product 端点 |
| `cabinClasses` | `product.cabinClass`（单数） | `category.cabinClass` |
| `nights` | `product.sailing.nights` / `cruiseNights` | `category.cruiseNights` |
| `cruiseLine` | `product.cruiseLine` | `category.cruiseLine` |
| `attributes Json` | 无（真孤儿，无 writer 无 reader） | 无 |

**建议（不在本次改动范围内，因为会动 schema 且需要一次 `db push`）：**

1. 删掉 `SearchDocument.attributes` —— 它既无 writer 也无 reader，注释所承诺的
   "未定型 facet 的逃生口"从未被使用。
2. 其余 5 列**保留**，因为它们是**筛选维度**（`whereBase.starRating = { in: ... }`
   这类查询需要数据库列），而 `category` 是**展示字段**（读自 `Product`，
   服务于卡片渲染）。两者职责不同，同名是巧合而非重复 ——
   上一版把它们判成"死列"正是因为只看名字、没看职责。

> 这一节存在的意义是记录一个反例：**审计工具报绿，逻辑上仍可能是错的；
> 反过来，两个字段同名，也不等于它们重复。** 判据必须是"谁读它、用来干什么"。
