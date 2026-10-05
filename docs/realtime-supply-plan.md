# 实时数据驱动改造方案（基于当前仓库实际代码审计）

审计日期 2026-10-05，基线 commit `ae33e4f`。以下所有文件路径、函数名、字段名均来自
`git grep` / 实际读取，未使用旧版本假设。

---

## 1. 当前真实架构

### 1.1 交易主链路（已完整，**不需要重写**）

```text
apps/web/src/app/page.tsx            HomePage          → api.destinations() / api.collection()
apps/web/src/app/search/page.tsx     SearchPage        → api.search()
apps/web/src/app/products/[slug]/page.tsx  ProductPage → api.product() + api.availability(90d)
apps/web/src/components/BookingPanel.tsx   BookingPanel → /checkout?...
apps/web/src/components/CheckoutFlow.tsx   CheckoutFlow → api.createOrder() → api.payOrder()

apps/web/src/lib/api.ts:742 api.search        → GET  /api/v1/search
apps/web/src/lib/api.ts:763 api.product       → GET  /api/v1/products/:slug
apps/web/src/lib/api.ts:766 api.availability  → GET  /api/v1/products/:slug/availability
apps/web/src/lib/api.ts:833 api.cart          → GET  /api/v1/cart
apps/web/src/lib/api.ts:844 api.addCartItem   → POST /api/v1/cart/items
apps/web/src/lib/api.ts:898 api.checkoutCart  → POST /api/v1/cart/checkout
apps/web/src/lib/api.ts:821 api.createOrder   → POST /api/v1/orders
apps/web/src/lib/api.ts:947 api.payOrder      → POST /api/v1/orders/:id/pay

routes/search.routes.ts     searchRoutes  → /search, /search/categories, /destinations,
                                       /collections/:slug, /search/connections, /search/airports,
                                       /search/flights/live, /search/flights/:callsign/live
routes/products.routes.ts  productRoutes → /products/:slug, /products/:slug/availability,
                                       /products/:slug/availability/:ticketTypeId,
                                       /products/:slug/nearby
routes/cart.routes.ts       cartRoutes    → /cart, /cart/items, /cart/items/:id, /cart/bundle, /cart/checkout
routes/orders.routes.ts     orderRoutes   → /orders(POST+GET), /orders/:id, /orders/:id/pay,
                                       /orders/:id/cancel, /orders/:id/cancellation-quote,
                                       /orders/lookup, /webhooks/payment
routes/ticketing.routes.ts  ticketRoutes  → /tickets, /tickets/:number, /tickets/:number/scan
routes/social.routes.ts     socialRoutes  → /products/:slug/reviews (GET/POST), /reviews/:id/helpful

modules/search/service.ts    searchProducts()  → Postgres FTS / OpenSearch
modules/pricing/engine.ts    computeQuote()    → 纯函数，rules 折叠 + markup + tax + fee
modules/inventory/engine.ts  placeHold() / consumeHold() / releaseHold() /
                             releaseExpiredHolds() / getAvailabilityCalendar() /
                             placeStayHold() / returnSoldUnits() / markSoldOutIfEmpty()
modules/booking/engine.ts    createPendingOrder() → confirmPaidOrder() → initiatePayment()
                             → cancelOrder() / quoteCancellation() / expireOrder()
modules/payments/gateway.ts  getPaymentGateway()  (mock | hyperswitch)
modules/ticketing/issuer.ts  generateTicketArtifacts()
modules/realtime/notify.ts   emitOrderCreated / emitPaymentEvent / emitOrderEvent /
                             emitInventoryAlert / createInAppNotification
```

### 1.2 实时数据层（**已存在但是空壳**）

```text
modules/supply/source.ts        SupplySource        导入型接口：写 Product/Destination，不写钱
modules/supply/import.ts        importAirportsFrom  OurAirports → Destination(level=AIRPORT)
modules/supply/ourairports.ts   OurAirportsSource   已 wire，~4,000 机场
modules/supply/realtime-flight.ts RealtimeFlightFinder  ADS-B 位置链（adsb.lol → OpenSky）
modules/supply/live-content.ts  liveAirTrafficNear()  产品详情页"附近空域"面板（仅 FLIGHT）
modules/supply/live.ts          LiveRateFinder       ★ 接口 + 缓存 + pickOffer 已完整实现
modules/supply/live-adapters.ts liveRateSources      ★ = [NoCommercialRateSource]，永远返回 []
```

**关键事实：`liveRates.resolve()` / `liveRates.resolveAvailability()` 在整个
`apps/api/src` 中零调用点**（`grep liveRates` 仅命中 `live-adapters.ts` 与
`prisma/live-rate-probe.ts`）。`live.ts` 已实现的 `LiveFreshness`（search/detail/
availability/checkout）、TTL 分层、currency 过滤、`sellable===0` 判定全部是死代码。

### 1.3 Prisma schema 承载能力（`apps/api/prisma/schema.prisma`，70 模型）

| 需求 | 现有字段 | 判定 |
| --- | --- | --- |
| 实时价进定价引擎 | `TicketType.basePriceCents` `compareAtCents` `costCents` `currency` `taxBps` `feeBps` | **够用**。实时净价必须作为 `computeQuote` 的 `basePriceCents` 入参，不得落库 |
| 实时可售 | `InventoryRecord.{capacityTotal,capacityHeld,capacitySold,status,version}` + `dimensionKey` + `InventoryMode.{PER_DATE,PER_NIGHT,PER_SLOT}` | **够用**。`dimensionKey` 正是 Phase 0 为 hotel roomType / cabin / sailing 预留的维度键 |
| 平台加价 | `config.booking.markupBps`（默认 1200）已在 `computeQuote` 内 | **够用**，无需改动 |
| 价格不可变 | `OrderItem.{baseUnitPriceCents,unitPriceCents,ruleTrace,taxCents,feeCents,markupCents,lineTotalCents,netAmountCents}` 全快照 | **够用**，live 层不得回写 |
| 幂等 | `Payment.idempotencyKey`、`PaymentEvent.{eventId,provider}`、`InventoryHold.holdToken`、`InventoryRecord.version` 乐观锁 | **够用** |
| 内容类扩展 | `ProductStay.roomTypes/policies`（Json）、`ProductFlight.segments/fareFamilies/cabins`（Json）、`ProductSailing.ports/cabinCategories`（Json）、`FlightSegment` 表 | **够用**，实时内容按需回填这些 Json，无需新表 |
| 缺什么 | **没有** `LiveOffer` / `PriceSnapshot` / `AvailabilitySnapshot` 持久表 | **不需要**。`live.ts` 已明确只走 Redis 缓存，落库即写死价格 |

`SearchDocument.attributes Json @default("{}")` 是既有的"逃生舱"，实时标签可写入。

---

## 2. 可以直接复用的部分

### 2.1 完全不需要改（禁止触碰）

| 路径 | 原因 |
| --- | --- |
| `modules/booking/engine.ts` 全部状态机 | `createPendingOrder` 已服务端重定价、`placeHold` 已原子占位、`confirmPaidOrder` 已幂等。实时层作为**入参**接入，不改引擎 |
| `modules/payments/gateway.ts` | 无关 |
| `modules/ticketing/issuer.ts` | 无关 |
| `modules/realtime/*` | 已完成 |
| `utils/{money,ids,jwt,crypto,date,errors,csv}.ts` | 无关 |
| `prisma/schema.prisma` | **不新增任何模型/字段**（`audit:schema` 基线 "No dead columns found"，新增即引入死列风险） |
| `routes/{cart,orders,ticketing,loyalty,social,support,promo,notifications,realtime,admin}.routes.ts` | 无关 |
| `apps/web` 的 `/cart` `/checkout` `/orders` `/tickets` 页面 | 无关 |

### 2.2 只需要"接入"（加 1–3 行调用，不改逻辑）

| 路径 | 接入点 |
| --- | --- |
| `modules/search/service.ts::resolveAvailabilityAndPrice()` | 在返回 `minPriceCents` 前，用 live 净价覆盖（`search` freshness），**不写库** |
| `routes/products.routes.ts::GET /products/:slug` 的 ticketTypes map | 同上，`detail` freshness |
| `routes/products.routes.ts::GET /products/:slug/availability` | 叠加 live availability，`availability` freshness |
| `modules/booking/engine.ts::createPendingOrder()` 的 `computeQuote` 调用 | 唯一写路径，`checkout` freshness（TTL=0），价格变化抛 `AppError.priceChanged` |
| `apps/web/src/lib/api.ts` 的 `SearchHit` / `ProductDetail` 类型 | 加 `live?: {...}` 可选块 |

### 2.3 可以直接复用（已实现、已验证、只需调用）

- `modules/supply/live.ts::LiveRateFinder` —— **完整可用**，含缓存分层 / `pickOffer` 三重过滤 / `degraded` 语义
- `modules/supply/live-adapters.ts::liveRateSources` 数组 —— 追加 adapter 即可，**零调用点改动**
- `utils/errors.ts::AppError.priceChanged` —— 已有 `PRICE_CHANGED` 409，**但全仓无调用点**，本次首次启用
- `LiveOffer.sellable === 0` 的售罄语义 —— 已实现
- `modules/supply/realtime-flight.ts` —— Flight 实时位置已验证 200
- `prisma/live-rate-probe.ts` —— 现成的源可达性探针 CLI

---

## 3. 必须修改的文件

| # | 路径 | 函数 / 模块 | 修改原因 | 修改内容 |
| --- | --- | --- | --- | --- |
| M1 | `apps/api/src/modules/supply/live.ts` | `LiveRateFinder` | 批量解析缺失：搜索/详情需要**一次调用解析多个变体**，现有 `resolve()` 单条 | 新增 `resolveMany(queries[], freshness): Promise<Map<key, LiveResult>>`，复用同一 `sources` 链与 `pickOffer`；`resolve()` 改为调用它（保持签名不变） |
| M2 | `apps/api/src/modules/supply/live.ts` | `cacheKey` / `TTL_BY_FRESHNESS` | 详情/可用性按 **ticketTypeId**（变体）而非 slug 区分；现有 key 无 ticketType，会让同商品不同变体串价 | `LiveRateQuery` 增加 `ticketTypeId?: string`，并入 cache key |
| M3 | `apps/api/src/modules/supply/live.ts` | 新增 `LiveCategory` 映射 | `ProductType` → `LiveCategory` 转换在三处重复 | 导出 `liveCategoryFor(productType)`，单一映射点 |
| M4 | `apps/api/src/modules/supply/live-adapters.ts` | `liveRateSources` | 需要真实 adapter | 追加 `OpenWeatherRateSource`（酒店/邮轮派生价，见 §6.3）与 `PlatformFloorRateSource`（保底，`[]` 永不变）；顺序 = 回退顺序 |
| M5 | `apps/api/src/modules/search/service.ts` | `resolveAvailabilityAndPrice()` | 搜索价必须是**平台定价后**的价，且走短 TTL | 在 `result.set(...)` 前，对 `FLIGHT/HOTEL_ROOM/CRUISE` 且 `SUPPLY_LIVE_ENABLED=true` 时调用 `liveRates.resolveMany(..., 'search')`；`quote !== null` 时以 `quote.netPriceCents` 作为 `minPriceCents` 入 `computeQuote`；`sellable === 0` 的商品从结果剔除；**全部在内存，不写 `SearchDocument.basePriceCents`** |
| M6 | `apps/api/src/modules/search/service.ts` | `SearchHit` type | 前端需要知道这是实时价 | 加 `priceLive?: { sourceId: string; fetchedAt: number; fromCache: boolean; netPriceCents: number }`（可选，live 关闭时不存在） |
| M7 | `apps/api/src/routes/products.routes.ts` | `GET /products/:slug` → ticketTypes map | 详情页价格必须实时 | `computeQuote` 的 `basePriceCents` 入参改为 `liveNet ?? ticketType.basePriceCents`，`freshness='detail'`；返回体每个 ticketType 增 `live: { sourceId, fetchedAt, netPriceCents, sellable }`；`sellable===0` 的变体标 `soldOut: true` 但**仍返回**（前端置灰） |
| M8 | `apps/api/src/routes/products.routes.ts` | `GET /products/:slug/availability` | 可用性优先实时 | 调 `liveRates.resolveAvailability(..., 'availability')`，命中时以 live `capacityTotal` 与 `InventoryRecord` 的 `capacityHeld/capacitySold` 取 `min`；`LiveAvailability` 为 `[]` 时行为完全不变 |
| M9 | `apps/api/src/routes/products.routes.ts` | `GET /products/:slug/availability/:ticketTypeId` | 同上 | 同一路径接入，返回体加 `liveSource` 字段 |
| M10 | `apps/api/src/modules/booking/engine.ts` | `createPendingOrder()` 内 `computeQuote` 调用 | **Checkout 必须重新验证 price + availability + expiry** | 在 `for (const line of input.lines)` 循环内、现有 `computeQuote` 之前：`freshness='checkout'` 解析 live 价与可售；① `sellable !== null && sellable < line.quantity` → `throw AppError.inventoryUnavailable('...', {available, requested})`；② live 净价导致 `quote.totalPerUnitCents` 与 `ticketType.basePriceCents` 基准差 > `PRICE_TOLERANCE_BPS` → `throw AppError.priceChanged(msg, {previousUnitPriceCents, currentUnitPriceCents, currency})`。**其余引擎逻辑、快照、幂等一行不改** |
| M11 | `apps/api/src/config/env.ts` | `config.supply.live` | 需要超时、批量上限、价格容差 | 新增 `timeoutMs`(默认 4000)、`maxBatch`(默认 60)、`priceToleranceBps`(默认 0，即"价格必须完全一致") |
| M12 | `apps/api/src/utils/errors.ts` | `AppError` | 需要"价格已变"的机器码（已有 `PRICE_CHANGED`，补一个 sold-out 之外的可售校验码） | 复用 `inventoryUnavailable`（已是 409 + `INVENTORY_UNAVAILABLE`），**不新增 error code** |
| M13 | `apps/api/src/index.ts` | `GET /ready` | 实时层降级要可见 | `checks.liveSupply = !liveRates.degraded \|\| liveRates.enabled === false`；并把 `liveRates.enabled` 放进返回体 |
| M14 | `apps/api/src/lib/logger.ts` / `modules/supply/live.ts` | 日志 | 实时价必须可审计 | live 解析成功时 `logger.info('live.rate_resolved', {slug, sourceId, net, sellable, freshness, fromCache})` |
| M15 | `apps/web/src/lib/api.ts` | `SearchHit` / `ProductDetail` / `TicketType` 类型 | 前端消费新字段 | 加 `priceLive?` / `TicketType.live?` / `TicketType.soldOut?` |
| M16 | `apps/web/src/components/BookingPanel.tsx` | 变体选择器 | 实时售罄要置灰 | `soldOut` 变体 `<option disabled>`；`priceLive` 显示"实时价 · 来源 X · 更新于 …"徽标 |
| M17 | `apps/web/src/components/CheckoutFlow.tsx` | `createOrder()` catch | `PRICE_CHANGED` / `INVENTORY_UNAVAILABLE` 要给可执行提示 | `ApiError.code` 分支：`PRICE_CHANGED` → 显示"价格已更新，请返回重新选择"并给回链；`INVENTORY_UNAVAILABLE` → "刚刚售罄" |
| M18 | `apps/web/src/lib/i18n/dictionaries.ts` | `en`（源）+ `zh` | 新文案 | 新增 `live.priceFrom` / `live.updatedAt` / `live.soldOut` / `checkout.priceChanged` / `checkout.soldOut`。**`en` 不加 `as const`，`zh` 不加类型注解** |
| M19 | `.env.example` | — | 新增 env 需可发现 | 补 `SUPPLY_LIVE_*` 全部键 + 注释 |
| M20 | `docs/supply-sources.md` | Real-time sources 表 | 记录新源与探测结果 | 追加本轮实测的上游、HTTP 码、许可与限制（§6.3） |

---

## 4. 必须新增的文件

| 路径 | 作用 |
| --- | --- |
| `apps/api/src/modules/supply/live-http.ts` | 唯一的带超时/UA/重试的 `fetchJson()` 工具。`realtime-flight.ts` 现存一份私有副本，**不合并**（避免改动已验证模块），新 adapter 一律用这个 |
| `apps/api/src/modules/supply/adapters/open-weather-rate.ts` | 酒店/邮轮**天气派生净价** adapter（§6.3）。实现 `LiveRateSource`，`categories: ['HOTEL_ROOM','CRUISE']` |
| `apps/api/src/modules/supply/adapters/synthetic-floor-rate.ts` | 保底 adapter：由 `TicketType.costCents` + 季节/提前期系数生成净价，`categories: ['FLIGHT','HOTEL_ROOM','CRUISE']`。**这是唯一能让"实时价"在无供应商凭证下真正跑起来的路径**，且价格完全由平台自己算 |
| `apps/api/src/modules/supply/live-images.ts` | 统一图片 URL 解析：Wikimedia Commons / Wikidata `P18` → `upload.wikimedia.org` 缩略图 URL，24h Redis 缓存。**只返回 URL，不落 `ProductMedia`**（除 Phase 3 显式写库） |
| `scripts/live-supply-check.sh` | 新增到 `pnpm verify` 之前的手工门禁：跑 `supply:probe` + 断言 `/products/:slug` 的 `live` 块存在、`sellable===0` 时置灰 |

**不新增**：Prisma 模型、`LiveOffer`/`PriceSnapshot`/`AvailabilitySnapshot` 持久表、
微服务、消息队列、供应商凭证配置。

---

## 5. 数据流（三条）

### 5.1 Flight

```text
GET /api/v1/search?types=FLIGHT&date=D
 └─ searchProducts() → Postgres 候选 (SearchDocument)
    └─ resolveAvailabilityAndPrice(ids, [D])                      [M5]
       ├─ Prisma: TicketType + InventoryRecord → 可售过滤（现有逻辑，不动）
       ├─ liveRates.resolveMany(FLIGHT × ticketType, 'search')     TTL 300s
       │   └─ synthetic-floor-rate.getRates() → costCents × lead/season 系数
       └─ computeQuote({ basePriceCents: live ?? seeded }) → priceCents + priceLive
 └─ SearchHit[] → ProductCard → /products/:slug

GET /api/v1/products/:slug?date=D&quantity=N                         [M7]
 ├─ liveAirTrafficNear(slug)  ← ADS-B（已存在，advisory:true，不影响价）
 ├─ ticketTypes.map → liveRates.resolveMany('detail')  TTL 60s
 │   └─ basePriceCents = live.netPriceCents ?? seeded
 └─ live: { sourceId, fetchedAt, netPriceCents, sellable }, soldOut

POST /api/v1/orders                                                 [M10]
 └─ createPendingOrder()
    ├─ liveRates.resolve(..., 'checkout')   TTL 0 → 强制穿透缓存
    ├─ sellable < quantity → INVENTORY_UNAVAILABLE 409
    ├─ |Δprice| > tolerance → PRICE_CHANGED 409（details 带前后价）
    ├─ computeQuote(...)  ← 现有引擎，唯一不变之处
    ├─ placeHold() → OrderItem 全量快照 → Order
    └─ (后续完全不变) initiatePayment → confirmPaidOrder → consumeHold
       → generateTicketArtifacts → Ticket
```

### 5.2 Hotel

```text
GET /api/v1/search?types=HOTEL_ROOM&date=…&stars=4,5
 └─ resolveAvailabilityAndPrice()                                  [M5]
    ├─ InventoryRecord.dimensionKey = roomType.code，capacityTotal- Held- Sold
    ├─ liveRates( HOTEL_ROOM, 'search' ) → open-weather-rate
    │   ├─ Destination(level=CITY) → lat/lng
    │   ├─ live-weather: 目的地当日气象（occupancy 代理指标）
    │   └─ netPriceCents = seedBase × (1 + seasonalIdx(weather))，受 MARKUP_BPS 之后由 computeQuote 加价
    └─ computeQuote → SearchHit

GET /api/v1/products/:slug?date=IN&quantity=…
 ├─ ProductStay.roomTypes(JSON) 提供 dimensionKey 候选
 └─ ticketTypes.map → liveRates('detail') → live/soldOut           [M7]

GET /api/v1/products/:slug/availability?days=90                    [M8]
 └─ getAvailabilityCalendar()（现有，per-night）
    + liveRates.resolveAvailability('availability') TTL 30s
      → min(live capacity, 本地剩余) 覆盖 availableQty

POST /api/v1/cart/checkout  或  POST /api/v1/orders                [M10]
 └─ nights = differenceInDays(checkIn, checkOut)
    └─ live 校验（checkout）→ placeStayHold()（现有）→ OrderItem(nights/nightlyPriceCents 快照)
       → Payment → Ticket（现有）
```

### 5.3 Cruise

```text
GET /api/v1/search?types=CRUISE&destinationPort=…
 └─ resolveAvailabilityAndPrice()                                  [M5]
    ├─ InventoryRecord.dimensionKey = ProductSailing.cabinCategories[].code
    ├─ sailDate 过滤：ProductSailing.sailDate 必须等于请求日期
    ├─ liveRates( CRUISE, 'search' ) → open-weather-rate（出发港气象 → 季节指数）
    └─ computeQuote → SearchHit

GET /api/v1/products/:slug                                         [M7]
 ├─ ProductSailing.{sailDate,nights,ports,cabinCategories,embarkationClosesAt}
 └─ ticketTypes.map → liveRates('detail')

POST /api/v1/orders                                                 [M10]
 └─ 校验 embedationClosesAt 未过 + live sellable
    → placeHold() → Order → Ticket（现有，含登船信息快照）
```

---

## 6. 实时数据 Source 接口（最小设计）

### 6.1 已有接口 —— 不新增任何 source 接口

`modules/supply/live.ts` 已定义且**已实现**：

```ts
// 已存在，原样复用
type LiveCategory = 'FLIGHT' | 'HOTEL_ROOM' | 'CRUISE';

interface LiveOffer {
  sourceId: string; externalId: string;
  netPriceCents: number;        // 净成本，非零售价
  currency: string;             // 必须 === query.currency，否则被丢弃
  sellable: number | null;      // null=未知, 0=确认售罄
  fetchedAt: number;
}
interface LiveAvailability { sourceId: string; serviceDate: string; dimensionKey: string; capacityTotal: number }

interface LiveRateSource {
  readonly id: string;
  readonly license: string;
  readonly categories: readonly LiveCategory[];
  getRates(query: LiveRateQuery): Promise<LiveOffer[]>;
  getAvailability(query: LiveRateQuery): Promise<LiveAvailability[]>;
}
```

**唯一需要加的**（M1/M2）：

```ts
/** 一次解析多个变体，供搜索/详情批量使用。返回 key 与输入 key 一一对应。 */
resolveMany(queries: LiveRateQuery[], freshness?: LiveFreshness): Promise<Map<string, LiveResult>>

/** LiveRateQuery 增加变体维度（见 M2）。 */
interface LiveRateQuery { /* ...现有... */ ticketTypeId?: string }
```

### 6.2 三态语义（**不可 collapses**，是本仓已付过代价的规则）

| 返回 | 含义 | 调用方动作 |
| --- | --- | --- |
| `[]` | 本源不携带此类数据 | 试下一个源 |
| `null` | 上游没说 | 回退 `TicketType.basePriceCents` |
| `0` | 确认售罄 | 置灰 / checkout 拒绝 |

### 6.3 本轮实测可达的源（2026-10-05，curl 实证）

| id | 用途 | endpoint | 实测 | 许可 / 限制 |
| --- | --- | --- | --- | --- |
| `open-weather` | HOTEL_ROOM / CRUISE 价格代理 + 详情文案 | `aviationweather.gov/api/data/metar?ids=` | **200**，含 `temp/dewp/wspd/wdir/obsTime` | NOAA 公共数据，无 key。⚠️ **它测的是机场气象，不是酒店所在地的城市气象**——只能作为航班/邮轮出发港与航线的真实信号；用于酒店城市需换 `open-meteo.com`（免费、无 key、CC-BY）。**P1 风险已记录，不假装解决** |
| `adsb-lol` | Flight 实时位置 | `api.adsb.lol/v2/point/{lat}/{lon}/{nm}` | **200**，返回 `ac[]` | 需自定义 UA（默认 `node` 被 403）。位置 ≠ 运价/座位 |
| `opensky-network` | Flight 位置 fallback | `/states/all?lamin=…` | **200**（`states: null` 当夜低空） | 匿名配额稀缺。**不支持 callsign 过滤**（已实测） |
| `wikidata` | 图片 / 描述 | `wikidata.org/w/api.php?action=wbgetclaims&entity=Q42&property=P18` | **200**，返回 `commonsMedia` 文件名 | CC0。需再查 Commons 取 URL |
| `commons-imageinfo` | 图片 URL + 缩略图 | `commons.wikimedia.org/w/api.php?action=query&prop=imageinfo&iiprop=url\|size&iiurlwidth=1024` | **200**，19KB，含 `thumburl` | CC BY-SA / 公有领域。**share-alike：写进 `ProductMedia.url` 前必须确认归属策略** → 本方案默认只运行时解析，不落库 |
| `nominatim` | 目的地地理 | `nominatim.openstreetmap.org/search?format=json` | **200** | ODbL。**严格 1 req/s 使用政策** → 必须 Redis 缓存 |
| `overpass-api` | POI 补充 | `overpass-api.de/api/interpreter` | **200**（该 bbox 无 `amenity=hotel` 节点） | ODbL。查询命中率低，仅作可选项 |
| `airplanes.live` | — | `api.airplanes.live/v2/point/…` | **403** 需邮件申请项目说明 | **禁止接入**（需人工审批，不可自动化） |
| `flightconnections.com/rss` | 航班时刻 | — | **202 空响应** | 无内容 |

### 6.4 明确的 P0 阻断：实时运价 / 实时房价 / 实时舱位

`docs/supply-sources.md` 已由前人实测确认：**运价、舱位、房量是可再分发的受管制商业资产，
没有免费、许可干净、可商用重分发的源。** 本轮复核无新发现。

因此本方案的落地形态是：

- **架构层**：`live.ts` 已具备的完整实时通道被真正接上（今天完全没调用）。
- **数据层**：`synthetic-floor-rate` 提供一个**平台自算的实时净价**（成本 + 季节/提前期/
  天气指数），它走的是实时通道、走缓存、走 checkout 复验，但**它不是供应商报价**——
  这点在代码注释与 UI 文案中必须写明，不得宣称"实时供应商价"。
- **真实供应商价**：一旦拿到合同，只需实现 `LiveRateSource` 并 append 到
  `liveRateSources`，**所有调用点零改动**。这是 §6.1 接口存在的全部意义。

---

## 7. 风险

### P0（阻断"实时价"这个说法成立）

| # | 风险 | 影响 | 处置 |
| --- | --- | --- | --- |
| P0-1 | **无免费可商用实时运价/房价/舱位源** | 无法真正拿到供应商实时价 | 已在 §6.4 明确标记。Phase 1 用 `synthetic-floor-rate` 让通道跑通并诚实标注；**禁止在 UI/文档里宣称"实时供应商价"** |
| P0-2 | `live.ts` 零调用点 = 整层死代码 | 当前 `SUPPLY_LIVE_ENABLED=true` 也不会改变任何输出 | Phase 1 的核心目标就是消除它 |
| P0-3 | checkout 无复验 | 现 `createPendingOrder` 只用 `TicketType.basePriceCents` | M10 接入 `freshness='checkout'`（TTL=0 强制穿透） |

### P1

| # | 风险 | 处置 |
| --- | --- | --- |
| P1-1 | `aviationweather` 只覆盖机场，不能代表酒店城市气象 | Hotel 定价指数改用 `open-meteo.com`（免费无 key）；或 Phase 1 只对 CRUISE 出发港 + FLIGHT 航线启用气象源 |
| P1-2 | 币种不匹配 | `pickOffer` 已过滤；但**不得**引入 FX 换算——跨币 offer 直接丢弃（现有行为，保持） |
| P1-3 | Nominatim 1 req/s 政策 | 强制 Redis 缓存（24h），且只在导入任务里用，不在请求路径 |
| P1-4 | Wikimedia 图片许可 share-alike | 默认**只运行时解析 URL，不写 `ProductMedia`**；若要落库须先确认归属 |
| P1-5 | 外部源故障拖慢接口 | 所有 live 调用 4s 超时 + 失败即 `[]`；**任何 live 源失败不得让请求失败**（与现有 `live-air` 行为一致） |
| P1-6 | `SearchDocument.basePriceCents` 被误当实时价回写 | M5 明确只改内存中的 `SearchHit`；`audit:schema` + 复核 `git grep basePriceCents` 确认 |

### P2

| # | 风险 | 处置 |
| --- | --- | --- |
| P2-1 | Next `images.remotePatterns` 需加 `upload.wikimedia.org` | Phase 3 才需要（`next.config.ts` 已注释说明） |
| P2-2 | 新增 `SearchHit.priceLive` 后 mobile-check 快照变化 | `scripts/mobile-check.sh` 需同步断言新字段（Phase 2） |
| P2-3 | `dictionaries.ts` `as const` 陷阱 | M18 严格遵守：`en` 无 `as const`，`zh` 无类型注解，`satisfies Record<LocaleCode, typeof en>` |
| P2-4 | `markSoldOutIfEmpty` / `returnSoldUnits` 未接 live | 本次**不接**：live 只影响"能否下单"，不改 `InventoryRecord` 计数器，避免与乐观锁打架 |

---

## 8. 实施顺序

每个 Phase 独立可完成、可验证（`pnpm verify` 必须 exit 0）。

### Phase 1 —— 接通已存在的实时通道（不新增任何数据源）

1. M1 `resolveMany` + M2 `ticketTypeId` + M3 `liveCategoryFor`
2. M11 `config.supply.live` 新增 `timeoutMs` / `maxBatch` / `priceToleranceBps`
3. M4 追加 `SyntheticFloorRateSource`（`categories` 三类齐全，`getRates` 由
   `TicketType.costCents` + 提前期/季节系数算出净价；`getAvailability` 返回 `[]`）
4. M14 日志
5. 验证：`SUPPLY_LIVE_ENABLED=false` 时 `pnpm verify` 逐字不变（默认关闭 → 行为等价）
6. 验证：`SUPPLY_LIVE_ENABLED=true` 时 `pnpm supply:probe` 能打印真实解析结果

**验收**：`liveRates` 不再是死代码；关闭开关时平台行为逐位不变。

### Phase 2 —— 读路径接入（搜索 / 详情 / 可用性）

1. M5 + M6 `search/service.ts`（内存覆盖，绝不落库）
2. M7 `products.routes.ts` ticketTypes + `live`/`soldOut`
3. M8 + M9 availability 两个端点
4. M13 `/ready` 暴露降级
5. M15–M18 前端类型、置灰、徽标、i18n
6. M19 `.env.example`
7. 验证：`pnpm typecheck && pnpm audit:schema && pnpm smoke && pnpm check:mobile` 全绿

**验收**：搜索卡片与详情页显示实时价 + 来源徽标；售罄变体置灰；
`pnpm audit:schema` 仍为 "No dead columns found"（无新列）。

### Phase 3 —— Checkout 复验（安全关键）

1. M10 `createPendingOrder` 内 checkout-freshness 复验
    - `sellable < quantity` → `INVENTORY_UNAVAILABLE`
    - 价格偏离 > `priceToleranceBps` → `PRICE_CHANGED`（`details` 带前后单价）
2. M17 `CheckoutFlow` 处理两个错误码
3. 新增 `scripts/live-supply-check.sh`：断言售罄变体在 checkout 被拒、
    改价后返回 `PRICE_CHANGED`、关闭开关时行为不变
4. 验证：`pnpm verify` 全绿；**新脚本纳入门禁**

**验收**：篡改 live 源价格/库存后，checkout 明确拒绝且不创建订单；
`OrderItem` 快照仍为成交价，后续改价不影响历史订单。

### Phase 4 —— 真实内容源（天气 / 图片）

1. `live-http.ts`
2. `adapters/open-weather-rate.ts`（先只服务 CRUISE 出发港 + FLIGHT 航线，
    Hotel 城市气象等 `open-meteo` 验证后再开）
3. `live-images.ts`（Wikidata P18 → Commons `thumburl`，24h 缓存，**不落库**）
4. M20 `docs/supply-sources.md` 补录本轮实测表
5. 验证：`pnpm supply:probe` 全项；`pnpm verify` 全绿

### Phase 5 —— 供应商接入位（预留，非本阶段交付）

当拿到商业合同，实现 `LiveRateSource` → append 到 `liveRateSources` →
`SUPPLY_LIVE_ENABLED=true`。**调用点、定价、库存、订单、支付、票务全部零改动。**
