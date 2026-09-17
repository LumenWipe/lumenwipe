# SCF Round #41 — RFP Track "Prices API": análisis comparativo

> Análisis tipo jurado (a ciegas) de los proyectos que compitieron por el reto RFP **Prices API** en SCF #41, contrastado con el resultado real de la ronda.

| Campo              | Valor                                                                                                |
| ------------------ | ---------------------------------------------------------------------------------------------------- |
| Ronda              | SCF #41 (Ended; Q1 2026)                                                                             |
| Rec-id de la ronda | `recTLIVf9LOTBtkld`                                                                                  |
| Fecha del análisis | 14-jun-2026                                                                                          |
| Cluster Prices API | 3 (1 dedicado + 2 multi-RFP)                                                                         |
| Resultado real     | Financió 1: CTX ($138K)                                                                              |
| Método             | Verificación independiente + puntuación **a ciegas** (sin leer el estado del award), luego contraste |

---

## 0. Nota de método sobre la evaluación a ciegas

A petición explícita, esta evaluación se hizo **sin leer el estado (Awarded/Not Awarded)** de cada submission, porque conocerlo sesga el juicio. Implementación: a los agentes verificadores se les instruyó ignorar cualquier estado o monto adjudicado y puntuar solo por mérito; las llamadas de lectura de cada propuesta pidieron explícitamente omitir el estado. El contraste con el resultado real se hace únicamente al final (§5). Salvedad de honestidad: al scrapear la ronda para el análisis previo del block explorer ya se habían visto incidentalmente algunos estados de esta ronda; por eso el rigor del "ciego" recae en la disciplina de puntuar por mérito y en los agentes, que sí fueron ciegos.

Misma rúbrica del RFP Track (6 dimensiones; `Composite = suma(raw×peso)/57.5×100`; FUND ≥ 75, FWC 60–74, DNF < 60). Guardrails de análisis previos aplicados (no penalizar trabajo futuro agendado; distinguir "descrito" de "ya construido"; Tranche #0 = 10%, así que tranches de entrega que suman ~90% es normal).

---

## 1. La especificación del RFP (Prices API)

Resumen parafraseado (spec Q1 2026):

**Scope.** API pública + servicio de indexación que provea datos de precio normalizados para todos los assets de Stellar (clásicos + tokens Soroban SEP-41).

**Requisitos.** Cobertura de todos los assets nativos + SEP-41; cobertura de oráculos (Chainlink, Redstone, Band, Reflector, otros); agregación = promedio ponderado a través de mercados on-chain y off-chain (Soroswap, Aquarius, SDEX, Blend); VWAP ajustable con umbral de volumen USD configurable para filtrar pares ilíquidos; endpoints en tiempo real e históricos (24h/7d/30d/1yr); volumen base y quote en USD; agregados OHLC para velas; timeframes 1h/24h/1w/1m/1y/All-Time con granularidades 1min-1month (1h+ retenido indefinidamente); alta disponibilidad, baja latencia, alto volumen de consultas, con explicación clara de qué pasa cuando los precios no están disponibles o las fuentes divergen; open source (Tranches I y II).

**Criterios de evaluación.** Calidad del diseño técnico; experiencia construyendo APIs performantes de baja latencia; seguridad (resistente a vectores de ataque); alineación con el ecosistema (indexar precios clásicos + Soroban); capacidad de entregar en ~2 meses; plan de integración coherente.

**Entregables.** Deployment de API production-ready en ~10 semanas desde el primer pago; documentación de referencia; onboarding self-service. Ejemplos: stellar.expert, steexp.com.

Nota: como en el block explorer, el RFP pesa fuertemente la **experiencia previa demostrada** (APIs de baja latencia, infra de pricing). Esto resulta decisivo (ver §5).

---

## 2. Fase 2 — Resumen por proyecto

**1. CTX ($138K, dedicado).** CTX.com opera ya un servicio de pricing en producción ("CTX Rates", rates.ctx.com) que agrega datos de exchanges reales. Propone extender esa infraestructura a Stellar: pricing real-time + histórico para todos los assets (clásico + Soroban), indexación de SDEX + AMMs Soroban (Soroswap, Aquarius, Blend), integración de oráculos (Chainlink, Redstone, Band, Reflector), VWAP/TWAP, OHLC con retención indefinida 1h+, todo open source y con nodos auto-hospedados. Es el ask más alto del cluster. Tiene el track record operacional de pricing más fuerte y verificable.

**2. CelerFi ($105K, Prices + DeFi Positions).** Equipo de ~10 personas construyendo un indexer Go (stellar-go/ingest) con PostgreSQL/Kafka/Redis, oráculos, procesadores de DEX, OHLC, VWAP, GraphQL+REST, SDKs en 4 lenguajes (MIT). Repo público real (stellar-indexer-go) con procesadores funcionando. Aceleradora YardHub. Pre-revenue. Apunta a 1,500 devs en Q1 2026 (mercados África/Asia). Prices API es su tranche líder (T1).

**3. SorobanHooks ($95K, Prices + DeFi + Explorer).** Plataforma de webhooks/alertas Stellar/Soroban real y en vivo, propone 3 productos; Prices API es su T1 ($32K). Tiene un endpoint de historial de precios real (thin), pero las features que definen el spec (oráculos, VWAP, OHLC, agregación multi-DEX) son net-new. Claims de tracción (100+ devs, 300+ tokens priced) no verificables públicamente; repos públicos delgados/vacíos.

---

## 3. Fase 3 — Evaluación tipo jurado (a ciegas)

### 3.1 CTX — Composite 73.9 → FUND WITH CONDITIONS (rozando FUND)

**Verificación.** [VERIFICADO] CTX.com es una empresa real con producto de pricing en vivo: rates.ctx.com sirve una API documentada que agrega datos de exchanges reales (Binance, Bitfinex, etc.). [PARCIAL] ">99.99% uptime / 16 fuentes" auto-reportado, con inconsistencia menor de fechas (2019 vs 2020). [CONTRADICHO, scope] El producto existente es estrecho (pares DASH/fiat principalmente), no un sistema multi-asset amplio; lo transferible es el motor y la disciplina ops, no la cobertura. [VERIFICADO] Ash Francis es real y activo en Stellar/Soroban (repos Soroban propios). [NO VERIFICADO] Certificaciones AWS / infra VoIP HA / staffing de "3 devs" (solo uno verificable). [VERIFICADO] Doc de arquitectura detallado y técnicamente creíble (SEP-40, direcciones de contratos Soroswap, Galexie, TimescaleDB, jerarquía de fallback VWAP→TWAP→stale); enmarca el trabajo Stellar como nuevo, honestamente.

| Dimensión                  | Raw | Ponderado | Evidencia                                                                                                                                                                                                                                                                        |
| -------------------------- | --- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spec Compliance (×3)       | 4   | 12.0      | El doc cubre casi todo: cobertura clásico+SEP-41, 4 oráculos con manejo native-vs-fallback correcto, VWAP ponderado multi-venue, umbral USD configurable, OHLC + granularidades + retención 1h+, historia de degradación/divergencia. Parámetros específicos diferidos a Fase 1. |
| Relevant Prior Work (×2.5) | 4   | 10.0      | API de pricing real en producción desde 2019 con agregación multi-fuente e infra auto-hospedada: la señal de Prior Work más fuerte del cluster. Descuentos: producto estrecho (DASH/fiat), sin código OSS de pricing existente, indexación Stellar/Soroban enteramente nueva.    |
| Developer Experience (×2)  | 4   | 8.0       | Compromete API pública, tier gratis rate-limited, keys ilimitadas para SDF/SCF, docs de referencia, imágenes de contenedor, scripts de self-hosting. rates.ctx.com ya demuestra docs limpias.                                                                                    |
| Maintenance Plan (×1.5)    | 3   | 4.5       | 6 meses de infra presupuestados; hardware propio baja costo y señala durabilidad; sin modelo de sostenibilidad post-grant claro; bus-factor de un principal.                                                                                                                     |
| Technical Approach (×1.5)  | 4   | 6.0       | Diseño moderno y sólido (agregación off-request + cache caliente + CDN, TimescaleDB, filtrado de divergencia estadístico, triangulación con gates de liquidez/frescura). Redundancia Soroban RPC sub-especificada.                                                               |
| Budget & Timeline (×1)     | 2   | 2.0       | $138K es el ask más alto; "3 devs" no sustanciado (solo uno verificable); 10 semanas para indexación multi-protocolo + 4 oráculos + HA + validación SLA + release OSS es agresivo.                                                                                               |

**Recomendación: FUND WITH CONDITIONS (73.9, justo bajo el umbral 75).** Strength: el raro caso con una API de pricing real en producción + infra propia + doc de arquitectura específico y alineado al spec. Concern: el producto existente es un agregador DASH/fiat estrecho sin código OSS; todo lo Stellar/Soroban está sin construir, al ask más alto y staffeado en papel por 3 devs cuando solo uno es verificable.

### 3.2 CelerFi — Composite 60.0 → FUND WITH CONDITIONS (fondo de banda)

**Verificación.** [VERIFICADO] github.com/celerfi/stellar-indexer-go es real (22 commits, 100% Go, stellar-go ingest, PostgreSQL via pgx, schemas para price_ticks/token_info/liquidity_pools). [PARCIAL] Procesadores de DEX: Stellar Classic DEX y Aquarius existen + handler Soroban genérico; **sin procesador Soroswap dedicado**; Blend/SDEX no presentes. [PARCIAL] Oráculos: solo **Reflector** implementado; Chainlink/Redstone/Band no en el código (agendados). [CONTRADICHO, menor] Kafka + Redis se reclaman pero no aparecen en go.mod; es un loop secuencial sin bus de streaming ni cache. [NO VERIFICADO] API GraphQL+REST: sin capa de serving aún. OHLC/VWAP/históricos: no en código (proposal-stage). [PARCIAL] celerfi.network es una plataforma **multi-chain** (Stellar es una de varias); el demo en vivo no verificable. [NO VERIFICADO] YardHub completado / pitch Stellar West Africa. [VERIFICADO] Fundadores reales (Divine-Favour Chinedu CEO; Eniola Olaleye CTO con pedigree ML real en Zindi). [NO VERIFICADO] Las credenciales del equipo extendido (que sostienen la experiencia en baja latencia).

| Dimensión                  | Raw | Ponderado | Evidencia                                                                                                                                                                                                                    |
| -------------------------- | --- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spec Compliance (×3)       | 3   | 9.0       | El plan cubre la mayoría; pero amplitud de oráculos (solo Reflector construido), agregación multi-venue y VWAP/divergencia descritos, no demostrados.                                                                        |
| Relevant Prior Work (×2.5) | 3   | 7.5       | Indexer real con stack de ingest correcto e historial de commits = fuerte para una propuesta. Pero la experiencia en APIs de baja latencia (criterio core del RFP) es aseverada vía bios no verificadas, no demostrada.      |
| Developer Experience (×2)  | 3   | 6.0       | T3 planea docs, onboarding self-service, API keys, SDKs en 4 lenguajes; todo futuro, nada existe hoy.                                                                                                                        |
| Maintenance Plan (×1.5)    | 3   | 4.5       | Gates de completitud concretos + MIT en T3; pre-revenue sin contratos; empresa multi-chain dispersa el foco.                                                                                                                 |
| Technical Approach (×1.5)  | 3   | 4.5       | Decisiones fundacionales correctas (stellar-go ingest, Postgres, Reflector). Pero el diseño actual (loop secuencial, goroutines sin backpressure, sin cache) no es la arquitectura Kafka/Redis de alto throughput reclamada. |
| Budget & Timeline (×1)     | 3   | 3.0       | $105K para dos APIs razonable; 10 semanas para Prices + Positions + SDKs en 4 lenguajes es agresivo; <100ms P95 no probado.                                                                                                  |

**Recomendación: FUND WITH CONDITIONS (60.0).** Strength: codebase de ingestión real y correctamente arquitecturado con el stack stellar-go que el RFP necesita, con procesadores de DEX y oráculo Reflector funcionando. Concern: brecha entre lo reclamado y lo construido (Kafka/Redis/GraphQL, multi-oráculo, OHLC/VWAP y el rendimiento <100ms son aspiracionales); la capacidad de API de baja latencia, criterio central del RFP, no está sustanciada.

### 3.3 SorobanHooks — Composite 50.4 → DO NOT FUND

**Verificación.** [CONTRADICHO] "300+ tokens con pricing real-time": el producto en vivo es una plataforma de webhooks/alertas; no hay docs/endpoints públicos de un servicio de pricing; el número solo aparece en la propuesta. [PARCIAL] Existe UN endpoint de historial de precios (`assetsPriceHistory` en el SDK npm), un lookup de serie temporal sin agregación. [CONTRADICHO, para "en profundidad"] Oráculos, VWAP, OHLC, agregación multi-DEX, divergencia, <400ms, HA: ninguno aparece en artefacto enviado; solo bullets. [NO VERIFICADO] "100+ developers" (métricas en Drive privado). [VERIFICADO, adverso] github.com/sorobanhooks: 5 repos, todos 0 stars, flagship vacío (README-only), core cerrado. [NO VERIFICADO] Identidad de fundadores.

| Dimensión                  | Raw | Ponderado | Evidencia                                                                                                                                                                |
| -------------------------- | --- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Spec Compliance (×3)       | 3   | 9.0       | La propuesta nombra cada requisito en papel, pero todo es net-new sin demostrar; solo existe un endpoint de historial delgado. Adecuado como plan, débil como evidencia. |
| Relevant Prior Work (×2.5) | 2   | 5.0       | Producto en vivo real + SDK npm = ejecución genuina, pero el prior work específico de pricing/indexing/oráculos es casi nulo; traction contradicha/no verificable.       |
| Developer Experience (×2)  | 3   | 6.0       | Tienen GitBook + SDK publicado (saben enviar tooling dev-facing); pero sin referencia de API de pricing.                                                                 |
| Maintenance Plan (×1.5)    | 2   | 3.0       | Servicios en vivo implican operación, pero sin plan de mantenimiento/SLA concreto para el prices API.                                                                    |
| Technical Approach (×1.5)  | 2   | 3.0       | El enfoque público son bullets; sin profundidad sobre VWAP/agregación/OHLC/divergencia; latencia/HA aseveradas sin diseño.                                               |
| Budget & Timeline (×1)     | 3   | 3.0       | $32K/~10 sem con prices front-loaded (T1) es estructuralmente normal, pero la relación scope-a-budget es ambiciosa para un build desde cero.                             |

**Recomendación: DO NOT FUND (50.4).** Strength: plataforma Stellar/Soroban real y operando con SDK publicado y un endpoint de historial de precios funcional (punto de partida no-cero). Concern: la capacidad específica de pricing es casi enteramente aspiracional, y los claims de tracción que la sostendrían están contradichos (300+ tokens) o escondidos en un Drive privado.

---

## 4. Fase 4 — Comparación

| Proyecto         | Ask   | Spec ×3 | Prior ×2.5 | DevEx ×2 | Maint ×1.5 | Tech ×1.5 | Budget ×1 | Composite | Recom. jurado      |
| ---------------- | ----- | :-----: | :--------: | :------: | :--------: | :-------: | :-------: | :-------: | ------------------ |
| **CTX**          | $138K |    4    |     4      |    4     |     3      |     4     |     2     | **73.9**  | FWC (rozando FUND) |
| **CelerFi**      | $105K |    3    |     3      |    3     |     3      |     3     |     3     | **60.0**  | FWC                |
| **SorobanHooks** | $95K  |    3    |     2      |    3     |     2      |     2     |     3     | **50.4**  | DNF                |

---

## 5. Contraste con el resultado real

| Proyecto     | Composite (ciego) | Recom. jurado | Resultado real    |
| ------------ | :---------------: | ------------- | ----------------- |
| CTX          |       73.9        | FWC           | **AWARDED $138K** |
| CelerFi      |       60.0        | FWC           | NO financiado     |
| SorobanHooks |       50.4        | DNF           | NO financiado     |

**Esta vez el ranking a ciegas coincidió con la realidad en orden y en el corte.** CTX quedó claramente arriba y fue el único financiado; CelerFi y SorobanHooks quedaron debajo y no se financiaron. La única matización: la rúbrica puso a CTX en FWC (73.9, justo bajo 75) por el riesgo de presupuesto/timeline, pero SDF lo financió de todos modos, igual que con los ganadores del block explorer. La razón es la misma señal recurrente: **CTX corre una API de pricing en producción**, exactamente la capacidad operacional demostrada que el RFP prioriza ("experiencia construyendo APIs performantes de baja latencia"). La rúbrica mecánica, al penalizar el ask alto (Budget ×1) y el timeline, sub-rató al ganador; SDF pesó más la capacidad de entrega probada.

A diferencia del block explorer (donde SDF financió dos), aquí financió **uno solo**: CTX era el único con producto de pricing probado; CelerFi era prometedor pero early-stage y multi-chain, y SorobanHooks no tenía capacidad de pricing demostrada. SDF no diluyó el premio entre apuestas no probadas.

---

## 6. Fuentes

Ronda: https://communityfund.stellar.org/awards/recTLIVf9LOTBtkld

| Proyecto     | Página SCF                                                      | Repo / sitio                                                            |
| ------------ | --------------------------------------------------------------- | ----------------------------------------------------------------------- |
| CTX          | https://communityfund.stellar.org/submissions/recaJkqF1MOWhu3Z5 | https://rates.ctx.com · https://github.com/ashfrancis                   |
| CelerFi      | https://communityfund.stellar.org/submissions/recN59E4E9bGTaxW3 | https://github.com/celerfi/stellar-indexer-go · https://celerfi.network |
| SorobanHooks | https://communityfund.stellar.org/submissions/rec5INTMTPBdNoQXp | https://github.com/sorobanhooks · https://sorobanhooks.xyz              |

---

## 7. Gaps de verificación

- Evaluación a ciegas (ver §0): estados de award no usados en la puntuación; contraste solo en §5.
- CTX: certificaciones AWS / infra VoIP / staffing de 3 devs no verificables (solo Ash Francis); uptime y "16 fuentes" auto-reportados; el producto existente es DASH/fiat, más estrecho que lo que implica el deliverable Stellar.
- CelerFi: demo en vivo, YardHub y credenciales del equipo extendido (experiencia en baja latencia) no verificadas; brecha entre arquitectura reclamada (Kafka/Redis/GraphQL) y código actual.
- SorobanHooks: métricas de tracción en Drive privado; identidad de fundadores no vinculable; core cerrado impide dimensionar el servicio de pricing real.
