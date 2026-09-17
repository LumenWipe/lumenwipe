# Patrones de decisión de SDF en el RFP Track: análisis cruzado

> Síntesis de evaluaciones tipo jurado contrastadas con resultados reales en **7 RFPs**: **Account Demolisher (SCF #44, sin decidir)** + **6 RFPs de SCF #41, ya decididos** (Block Explorer, Prices API, DeFi Positions API, C-Address Tooling, Reverse Engineering Tool, Hummingbot). Objetivo: extraer qué premia realmente SDF en RFPs de infraestructura, y qué tan bien lo predice una rúbrica mecánica.

Fecha: 14-jun-2026. Muestra: ~25 submissions evaluadas, ~13 awards en 6 RFPs decididos. Fuentes: los deliverables hermanos (`scf44-account-demolisher-comparison.md`, `scf41-block-explorer-comparison.md`, `scf41-prices-api-comparison.md`, `scf41-remaining-rfps-comparison.md`).

---

## 1. Los datos en una tabla

| RFP (ronda)              | Proyecto                           | Ask     | Composite (jurado) | Recom. | Resultado real             |
| ------------------------ | ---------------------------------- | ------- | :----------------: | ------ | -------------------------- |
| Block Explorer (#41)     | Prism / OBSRVR                     | $80K    |        87.8        | FUND   | **AWARDED**                |
| Prices API (#41)         | CTX                                | $138K   |        73.9        | FWC    | **AWARDED**                |
| Block Explorer (#41)     | Gemy                               | $75K    |        69.6        | FWC    | No                         |
| Block Explorer (#41)     | Rumble Fish                        | $131.2K |        62.6        | FWC    | **AWARDED**                |
| Prices API (#41)         | CelerFi                            | $105K   |        60.0        | FWC    | No                         |
| Prices API (#41)         | SorobanHooks                       | $95K    |        50.4        | DNF    | No                         |
| Block Explorer (#41)     | SorobanHooks                       | $95K    |        45.2        | DNF    | No                         |
| Account Demolisher (#44) | LumenWipe                          | $120K   |        81.7        | FUND   | _pendiente (Panel Review)_ |
| Account Demolisher (#44) | Account Demolisher (Salih Toruner) | $120K   |        80.9        | FUND   | _pendiente_                |
| Account Demolisher (#44) | Rather Labs                        | $92K    |        66.1        | FWC    | _pendiente_                |
| Account Demolisher (#44) | Orbitway                           | $120K   |        59.1        | DNF    | _pendiente_                |
| Account Demolisher (#44) | S.A.D                              | $60K    |        55.7        | DNF    | _pendiente_                |
| Account Demolisher (#44) | AlphaTechini                       | $117K   |        48.7        | DNF    | _pendiente_                |
| Account Demolisher (#44) | BlackHole                          | $16K    |        47.0        | DNF    | _pendiente_                |

En las dos rondas decididas, SDF financió 3 proyectos de 7 evaluados (Prism, Rumble Fish, CTX). Los tres comparten un rasgo (patrón 1).

---

## 2. Patrones de SDF que se repiten

### Patrón 1: SDF financia capacidad operacional demostrada por encima de propuestas pulcras pero no probadas

Los tres ganadores **ya operaban infraestructura real** en el dominio del RFP:

- **Prism / OBSRVR** mantiene stellarbeat/Radar (el monitor de red de Stellar) y un stack de ingestión de ledgers en producción.
- **Rumble Fish** es una software house establecida (cliente MakerDAO) con un EVM debugger real en otro ecosistema.
- **CTX** corre una API de pricing en producción (rates.ctx.com) desde ~2019.

Los no-financiados con propuestas competitivas o rigurosas perdieron por **falta de track record operacional**, no por mala propuesta: Gemy (dev solo, herramienta de viz client-side), CelerFi (early-stage, multi-chain), SorobanHooks (webhooks, sin pricing/explorer probado). La lección: en RFPs de infraestructura, la pregunta decisiva de SDF es **"¿este equipo puede operar y mantener esto a escala?"**, no "¿la propuesta es la más limpia o barata?".

### Patrón 2: la rúbrica mecánica (Spec ×3) sub-rata a los equipos probados y sobre-rata a los novatos pulcros

- En el block explorer la rúbrica **invirtió el medio**: puso a Gemy (69.6) sobre Rumble Fish (62.6); SDF financió a Rumble Fish y no a Gemy.
- En el prices API la rúbrica puso a CTX en FWC (73.9, justo bajo FUND) por penalizar su ask alto y timeline; SDF lo financió igual.

El sesgo es estructural: Spec Compliance pesa ×3 y premia propuestas exhaustivas en papel; un solista o un early-stage puede escribir una propuesta impecable que su track record no respalda. El propio RFP **telegrafía** que el prior work pesa más ("experiencia manteniendo bases de datos grandes", "infra de explorer en otros ecosistemas", "APIs performantes de baja latencia"), pero la rúbrica solo le asigna ×2.5 a Prior Work. **Corrección sugerida para predecir RFPs de infra: subir el peso de Prior Work / capacidad-de-entrega, o tratar Spec Compliance no construido como techo en función del track record.**

### Patrón 3: SDF reparte el riesgo en deliverables fundacionales, pero apuesta a un líder único cuando uno domina

- Block explorer: financió **dos** (Prism, infra nativa del ecosistema + Rumble Fish, casa establecida): hedge en un building block fundacional con dos perfiles complementarios.
- Prices API: financió **uno** (CTX), el único con pricing en producción; CelerFi era prometedor pero no probado, SorobanHooks no tenía capacidad de pricing demostrada. No diluyó el premio entre apuestas no probadas.

### Patrón 4: las propuestas "plataforma" multi-RFP rinden peor que las dedicadas

SorobanHooks (3 RFPs) y CelerFi (2 RFPs) perdieron en todas. Los ganadores (Prism, CTX, Rumble Fish) fueron submissions **dedicadas y enfocadas**. Dividir el scope diluye la profundidad del spec y señala falta de foco de entrega. SorobanHooks, evaluado contra dos RFPs distintos (explorer 45.2; prices 50.4), quedó DNF en ambos: el mismo equipo enfocado podría haber competido mejor en uno solo.

### Patrón 5: lo que gana es capacidad de entrega DEMOSTRADA (track record de equipo), no el stage del build (mainnet vs testnet)

Matiz importante (corrige una versión previa que sobre-pesaba "producto-en-mainnet"): el diferenciador no es mainnet vs testnet, es la **capacidad de entrega demostrada**, de la cual un producto vivo es solo una forma. Evidencia:

- SDF financió equipos con solo **testnet/PoC** cuando el track record era fuerte: Latch (PoC testnet, 16 subinvocations), Smart Account Onboarding G2C (PoC testnet), Inferara/Soliman (repos esqueleto, ganaron por track record de compiladores).
- Y rechazó a **Gemy pese a tener un decoder funcionando en MAINNET**, porque era un solo dev sin track record de DBs grandes/indexers.
- Los perdedores también tenían testnet/demos (S.A.D, BlackHole, SoroTrack, StellarScope): un build de testnet **solo** no limpia la barra; la limpia cuando viene de un equipo probado.
- Anónimos/no verificables pierden siempre (AlphaTechini repo=README; SorobanHooks fundadores no vinculables).

El moat es el **combo**: equipo con track record verificable + build creíble (en cualquier stage) + arquitectura sólida. Un producto en mainnet añade tracción on-chain (dimensión puntuada) y prueba de poder llevar _este_ producto a producción, pero no sustituye al track record.

### Patrón 6: el precio importa menos de lo que asume la rúbrica cuando la confianza de entrega es alta

Los asks más altos no perdieron por altos: Rumble Fish ($131.2K) y CTX ($138K) ganaron. La rúbrica penaliza el ask alto (Budget ×1), pero SDF paga premium por equipos probados. El precio pesa cuando la confianza de entrega es baja, no cuando es alta.

### Patrón 7: lo que se castiga no es la ausencia de features futuras, sino la sobre-declaración y la tracción no verificable

Casi todas las propuestas agendaron Soroban/DeFi/oráculos/etc. como trabajo futuro (correcto para un RFP). El castigo real recae en: (a) presentar lo no construido como ya construido (la única contradicción genuina del set: el "300+ tokens priced" de SorobanHooks); (b) claims de tracción escondidos en Drives privados o sin corroboración pública. (Nota metodológica: una revisión inicial confundió "agendado" con "sobre-declarado" en el análisis del #44; se corrigió. La ausencia de trabajo futuro NO se penaliza.)

---

## 3. Calibración: ¿qué tan bien predijo la rúbrica a ciegas? (6 RFPs decididos)

| RFP (#41)           | Financiados reales     | Top-N a ciegas                               | Veredicto                                             |
| ------------------- | ---------------------- | -------------------------------------------- | ----------------------------------------------------- |
| DeFi Positions      | 2 (OctoPos, Orion)     | 2 FUND idénticos                             | ✅ exacto                                             |
| C-Address           | 3 (G2C, KMP, Latch)    | top-3 idéntico                               | ✅ (1 falso positivo en #4: JS-Capacitor)             |
| Reverse Engineering | 2 (Inferara, Soliman)  | 2 FUND idénticos                             | ✅ exacto (WASM Debugger bien marcado out-of-cluster) |
| Hummingbot          | 0                      | sole entry DNF                               | ✅ exacto                                             |
| Prices API          | 1 (CTX)                | CTX arriba y único sobre el corte            | ✅ (sub-rató a CTX a FWC; real: financiado)           |
| Block Explorer      | 2 (Prism, Rumble Fish) | Prism #1 ✓; pero invirtió Gemy > Rumble Fish | ⚠️ 1 inversión en el medio                            |

**La rúbrica a ciegas predijo correctamente el conjunto financiado en 5 de 6 RFPs.** La única inversión real fue Block Explorer (Gemy 69.6 sobre Rumble Fish 62.6; SDF financió a Rumble Fish). Conclusión refinada respecto a la versión anterior: **la rúbrica está bien calibrada en la mayoría de los casos**, porque los equipos probados suelen escribir también las mejores propuestas (Spec ×3 y Prior Work ×2.5 apuntan al mismo lado). El punto ciego aparece solo en el **caso de divergencia**: cuando un equipo probado presenta una propuesta más débil que un novato pulcro (Rumble Fish facade-Horizon vs Gemy criterios impecables). El ajuste sigue siendo: **subir el peso de la capacidad de entrega/operación probada** para cubrir ese caso.

Sesgo direccional útil: cuando la rúbrica falla, tiende a **sub-ratar** a los equipos probados (CTX a FWC; Rumble Fish bajo Gemy), no a sobre-ratarlos. Es decir, un FUND de la rúbrica para un equipo probado es muy fiable; un FWC para un equipo probado puede ser en realidad un FUND.

---

## 4. Implicaciones para LumenWipe en el Account Demolisher (#44)

El #44 aún no se decide (Panel Review). LumenWipe está bien posicionado, pero **ya no es el front-runner solitario**: con el deadline pasado apareció un competidor casi a la par, **Account Demolisher de Salih Toruner (80.9)**, a 0.8 puntos de LumenWipe (81.7).

- **Patrón 1 y 5:** el activo que más pesa es el **track record del equipo**, no el stage del build. LumenWipe lo tiene fuerte (two-time SCF Build Award de Miguel: Elixir SDK + Chaincerts, confirmado; + Sebastian/Akkuea/Cougr). PERO Salih también lo tiene (grant SCF #29 verificado + prototipo testnet con los 4 adapters DeFi ya construidos). Corrijo la versión previa: **sí hay un rival con el combo equipo-probado + build-creíble** ("ofrecer mainnet y listo"), y es Salih. Los otros cuatro (Orbitway EVM, S.A.D repo joven, AlphaTechini anónimo, BlackHole solo sin track record) no lo tienen.
- **Dónde LumenWipe edge a Salih:** equipo de 2 (vs solo), credencial más fuerte (dos Build Awards vs un Activation #29), MVP en mainnet (vs testnet), tests escritos, y dos diseños distintivos que Salih no tiene (**fees patrocinados CAP-15** + **fast-path fusionado**) más API/SDK y LOI de Pollar. **Dónde Salih edge a LumenWipe:** más DeFi ya construido en testnet — los 4 adapters de exit + la detección por lectura directa de contratos, que en LumenWipe es trabajo futuro. (Matiz: los tiers OctoPos/Orion de su cascada no están vivos — Orion sin publicar, OctoPos mainnet-only —, así que la "integración" con esas APIs está empatada: interfaz pendiente de mainnet para ambos.)
- **Patrón 4 a favor de ambos:** los dos son dedicados y enfocados, frente a entrantes difusos (Orbitway "checkup").
- **Patrón 2 matizado:** la rúbrica sub-rata a los equipos probados, así que ambos FUND son fiables; el orden LumenWipe > Salih es estrecho y podría invertirse con ±1 punto en una dimensión.
- **Patrón 3 (hedge):** si SDF financia dos demolishers (como hizo en 4 de 6 RFPs de #41), **el segundo asiento más probable es Salih**, no Rather Labs: Salih supera a Rather Labs en track record Stellar (grant SCF #29 + producto Stellar vs agencia sin producto Stellar). El escenario realista es LumenWipe + Salih ambos financiados.

**Conclusión:** SDF financia "quién puede entregar y mantener esto". LumenWipe es **co-líder** del cluster, con ventaja por equipo + edges de diseño + mainnet; Salih es un par cercano. La competencia real de #44 es entre estos dos, y un hedge a ambos es plausible.

---

## 5. Caveats

- El #44 sigue abierto; sus resultados son predicciones, no hechos.
- Las razones internas de SDF no son públicas; los patrones se infieren de los awards reales + los criterios escritos de cada RFP.
- Los composites son juicios de revisor aplicando una rúbrica; los proyectos en banda media son sensibles a ±1 punto (de ahí algunas inversiones vs. la realidad).
- Muestra pequeña (2 rondas decididas, 3 RFPs, 7 proyectos con resultado). Los patrones son consistentes y se alinean con los criterios escritos, pero no son una ley estadística.
