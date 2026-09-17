# SCF Round #41 — RFP Track: los 4 RFPs restantes (DeFi Positions, C-Address, Reverse Engineering, Hummingbot)

> Evaluación tipo jurado **a ciegas** (sin leer el estado del award) de los clusters restantes de SCF #41, contrastada con el resultado real. Complementa los análisis de Block Explorer y Prices API.

| Campo                 | Valor                                                                                          |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| Ronda                 | SCF #41 (Ended; Q1 2026) · rec-id `recTLIVf9LOTBtkld`                                          |
| Fecha                 | 14-jun-2026                                                                                    |
| RFPs cubiertos aquí   | DeFi Positions API, C-Address Tooling, Soroban Reverse Engineering Tool, Hummingbot            |
| Submissions evaluadas | 18 (incluye 2 multi-RFP ya cubiertos en el análisis de Prices)                                 |
| Método                | Verificación independiente + puntuación a ciegas (agentes sin estado), contraste solo al final |

Rúbrica del RFP Track (6 dim; `Composite = suma(raw×peso)/57.5×100`; FUND ≥ 75, FWC 60–74, DNF < 60). Guardrails: no penalizar trabajo futuro agendado; distinguir "descrito" de "ya construido"; Tranche #0 = 10%.

---

## A. DeFi Positions API

Spec (resumen): servicio de agregación + API que normaliza la exposición DeFi total de un usuario a través de protocolos Stellar (Blend, Aquarius, Soroswap, FxDAO), con valor/depósito/deuda/health-factor por posición, input G o C-address, alta disponibilidad y baja latencia.

| Proyecto                           | Equipo                                           | Ask     | Composite (ciego) | Recom. | Resultado real         |
| ---------------------------------- | ------------------------------------------------ | ------- | :---------------: | ------ | ---------------------- |
| OctoPos – DeFi Position API        | Untangled Finance (Quan Le, Manrui Tang; ex-PwC) | $120K   |     **89.6**      | FUND   | **AWARDED $120K** ✅   |
| Orion – Position Aggregation Layer | daccred (Andrew Miracle et al.)                  | $122.2K |     **77.4**      | FUND   | **AWARDED $122.2K** ✅ |
| StellarScope                       | Rohit Aggarwal, Chittara (ERC-7066 author)       | $90K    |       52.2        | DNF    | NO ✅                  |
| SoroTrack                          | Gemy / NibrasD (solo)                            | $50K    |       29.6        | DNF    | NO ✅                  |
| (CelerFi, multi-RFP)               | CelerFi                                          | $105K   |      60.0\*       | FWC    | NO ✅                  |
| (SorobanHooks, multi-RFP)          | SorobanHooks                                     | $95K    |      50.4\*       | DNF    | NO ✅                  |

\*De los análisis de Prices API (mismo equipo, scope dividido).

**Contraste: predicción perfecta.** Los dos financiados (OctoPos, Orion) fueron los dos FUND a ciegas; el resto DNF/FWC no se financió. SDF financió **dos** (patrón de hedge en infra fundacional). Notas: OctoPos lideró por equipo (firma RWA-DeFi con award SCF previo, producto Stellar en vivo) y completitud de spec (G+C, 5 protocolos, manejo de divergencia de precios); Orion por rigor técnico (determinismo ledger-pinned) respaldado por un indexer Soroban real e inspeccionable. Los perdedores: StellarScope (equipo Web3 capaz pero **sin track record Stellar**, sin código), SoroTrack (el caso más claro de **sobre-declaración**: vende una API multi-protocolo pero el código es un SPA de una sola commit con direcciones de contrato falsas).

---

## B. C-Address Tooling & Onboarding

Spec (resumen): aproximación + implementación de referencia para fondear una C-address (smart account Soroban) **sin** pasar por una G-address: bridge G-to-C, wallet C-address a paridad de Freighter, onboarding kit open-source, estándar Smart Account de OpenZeppelin, diseñado con input de wallets del ecosistema.

| Proyecto                        | Equipo                                                                    | Ask   | Composite (ciego) | Recom.            | Resultado real       |
| ------------------------------- | ------------------------------------------------------------------------- | ----- | :---------------: | ----------------- | -------------------- |
| Smart Account Onboarding G2C    | The Aha Company (Ostrowski, Wyndham; mantienen Soroban CLI/Loam/Scaffold) | $150K |     **88.7**      | FUND              | **AWARDED $150K** ✅ |
| KMP Stellar SDK                 | Soneso (Christian Rogobete; mantiene 4 SDKs Stellar)                      | $14K  |     **81.7**      | FUND              | **AWARDED $14K** ✅  |
| Latch: C-Address Onboarding     | 3000 Labs (Frankie, Kachi, Lexie)                                         | $120K |     **78.3**      | FUND              | **AWARDED $120K** ✅ |
| C-Address Toolkit               | Jose Toscano (Strooper Wallet, EntryX)                                    | $120K |       72.2        | FWC               | NO ✅                |
| JS-Capacitor Smart Account Kit  | Argo Navis Dev (PHP Anchor SDK)                                           | $10K  |       76.5        | FUND (borderline) | NO ❌                |
| StellarPasskey (Cloud Passkeys) | Nearx (Caio de Mattos)                                                    | $112K |       63.5        | FWC               | NO ✅                |
| SmoothSend                      | imtani / ivedmohan (Aptos/EVM)                                            | $120K |       55.7        | DNF               | NO ✅                |

**Contraste: casi perfecto. SDF financió 3 = el top-3 a ciegas** (G2C, KMP, Latch). El corte cayó entre #3 (Latch, financiado) y #4. La única discrepancia: **JS-Capacitor** puntuó 76.5 (FUND borderline) pero no se financió; el propio agente lo marcó como borderline (equipo probadísimo y ask trivial de $10K, pero cubre solo ~15% del spec del RFP). SDF aparentemente quiso amplitud de spec sobre una pieza estrecha. Notas: G2C ganó por el equipo más probado (mantenedores de Soroban CLI/Loam/Scaffold + ex-SDF) y stack completo; **KMP/Soneso es el caso revelador** — scope estrecho (Spec solo 2) pero financiado por valor excepcional + mantenedor probadísimo a $14K; Latch por la mejor cobertura literal del spec (incluye el wishlist multi-wallet + móvil) con PoC desplegado. Perdedores: SmoothSend (sobre-declaración: repos Soroban/relayer inexistentes, SDK publicado sin features de C-address, equipo Aptos/EVM sin track record Stellar/Soroban).

---

## C. Soroban Specialized Reverse Engineering Tool

Spec (resumen): herramienta que toma un WASM de contrato Soroban y produce WAT/Rust legible y preciso (≥90% reconstrucción vía AST), con conocimiento interno de Soroban; deep-tech que vive o muere por credenciales de WASM/compiladores/PL.

| Proyecto                             | Equipo                                                           | Ask   | Composite (ciego) | Recom.              | Resultado real           |
| ------------------------------------ | ---------------------------------------------------------------- | ----- | :---------------: | ------------------- | ------------------------ |
| Soroban Disassembler                 | Inferara (compilador WASM propio; Soroban Security Portal)       | $100K |     **89.6**      | FUND                | **AWARDED $100K** ✅     |
| Soroban Reverse Engineering Tool     | Soliman et al. (lidera el compilador Solidity→Soroban de Solang) | $120K |     **80.0**      | FUND                | **AWARDED $120K** ✅     |
| Specialized Reverse Engineering Tool | Stefan/Robert (CrossChainLabs, NEAR)                             | $25K  |       53.0        | DNF                 | NO ✅                    |
| Intuitive WASM Debugger              | Runtime Verification (Komet, Simbolik)                           | $150K |       73.0†       | DNF (spec-mismatch) | AWARDED $150K (otro RFP) |

†El agente identificó correctamente que el WASM Debugger **no apunta a este RFP** (es un debugger, no un decompilador): Spec=1 contra esta spec. En la realidad fue financiado, pero bajo otra categoría/track, no como reverse-engineering tool. Buen catch: la categorización a ciegas distinguió el out-of-cluster.

**Contraste: predicción perfecta.** Los dos financiados como reverse-eng (Inferara, Soliman) fueron los dos FUND a ciegas. El deep-tech se decidió por **evidencia de capacidad de compiladores/WASM**: Inferara tiene un compilador WASM propio + tooling WAT + el Soroban Security Portal; Soliman lidera el compilador Solidity→Soroban que la herramienta debe invertir. El barato ($25K, Specialized RE) cayó (DNF): plan on-spec pero credenciales WASM no corroboradas (org NEAR, sin artefactos de compilador). Otra confirmación del patrón: en RFPs deep-tech, la **capacidad demostrada domina**, no el precio.

---

## D. Hummingbot integration

Spec (resumen): connector Stellar para Hummingbot (framework de trading algorítmico open-source), con soporte de orderbook SDEX, gestión de órdenes, channel accounts, e **inclusión oficial en el repo de Hummingbot** + mantenimiento a largo plazo.

| Proyecto                       | Equipo                          | Ask     | Composite (ciego) | Recom. | Resultado real |
| ------------------------------ | ------------------------------- | ------- | :---------------: | ------ | -------------- |
| Stellar Hummingbot Integration | Tharun Ekambaram, Daniel Zilper | $121.4K |       57.4        | DNF    | NO ✅          |

**Contraste: el RFP quedó sin financiar.** La única submission puntuó DNF a ciegas y no se financió. Buen encuadre técnico (channel-account pool para concurrencia, RPC sobre Horizon, XRPL como referencia), pero: repo enlazado **vacío** (sobre-declara un architecture doc inexistente), equipo no verificable, sin track record Stellar/XDR, y **ningún entendimiento del gobierno HBOT-token-gated** de Hummingbot que hace dura la "inclusión oficial" (el requisito más distintivo del RFP). Un RFP con un solo entrante débil = SDF no financió nada (patrón: el hedge escala con la profundidad/calidad del campo).

---

## E. Calibración: jurado a ciegas vs. realidad (4 RFPs)

| RFP                 | Financiados reales    | Top-N a ciegas             | ¿Coincide?                                |
| ------------------- | --------------------- | -------------------------- | ----------------------------------------- |
| DeFi Positions      | 2 (OctoPos, Orion)    | 2 FUND (OctoPos, Orion)    | ✅ exacto                                 |
| C-Address           | 3 (G2C, KMP, Latch)   | top-3 (G2C, KMP, Latch)    | ✅ (1 falso positivo en #4: JS-Capacitor) |
| Reverse Engineering | 2 (Inferara, Soliman) | 2 FUND (Inferara, Soliman) | ✅ exacto                                 |
| Hummingbot          | 0                     | 0 (sole entry DNF)         | ✅ exacto                                 |

A diferencia del block explorer (donde la rúbrica invirtió el medio), aquí la predicción fue **casi perfecta**. La razón: en estos clusters los equipos probados **también** escribieron las mejores propuestas, así que Spec Compliance (×3) y Prior Work (×2.5) apuntaban en la misma dirección. La inversión del block explorer fue la excepción (un equipo probado con propuesta más débil que un solista pulcro), no la regla.

**Patrones nuevos/confirmados en este lote:**

- **SDF financia piezas estrechas de alta calidad de mantenedores probados** (KMP/Soneso $14K, Spec solo 2 pero financiado por valor + track record). La capacidad de entrega probada vuelve a dominar.
- **El hedge escala con la calidad del campo:** 2-3 financiados en RFPs fundacionales con campo fuerte (positions, c-address, reverse-eng), 1 en prices (campo débil), 0 en hummingbot (un solo entrante débil).
- **La sobre-declaración es la señal de muerte fiable:** SoroTrack (direcciones de contrato falsas), SmoothSend (repos inexistentes), Hummingbot (repo vacío) — los tres con contradicciones genuinas, ninguno financiado.
- **El equipo EVM/otra-cadena sin track record Stellar pierde** consistentemente (StellarScope, SmoothSend).
- **En deep-tech, la evidencia de capacidad domina al precio** (Inferara/Soliman financiados; el $25K barato cayó).

---

## F. Fuentes

Ronda: https://communityfund.stellar.org/awards/recTLIVf9LOTBtkld

| Proyecto                                   | Página SCF                                                      |
| ------------------------------------------ | --------------------------------------------------------------- |
| OctoPos                                    | https://communityfund.stellar.org/submissions/recOh9tgSDRC3elBf |
| Orion                                      | https://communityfund.stellar.org/submissions/recPt6cTMzx8XmiNj |
| StellarScope                               | https://communityfund.stellar.org/submissions/rec9pXYIgOKhu4bhi |
| SoroTrack                                  | https://communityfund.stellar.org/submissions/recvzTEL6v9foUOA8 |
| Smart Account Onboarding G2C               | https://communityfund.stellar.org/submissions/recoFPcf15Bm06ynq |
| KMP Stellar SDK                            | https://communityfund.stellar.org/submissions/recj2Qhuxdci3iGk1 |
| Latch                                      | https://communityfund.stellar.org/submissions/recUrEbIUnLVTIbra |
| C-Address Toolkit                          | https://communityfund.stellar.org/submissions/recZjsmwFlcEYZ6hy |
| JS-Capacitor                               | https://communityfund.stellar.org/submissions/recWEvv9oexNQcxF9 |
| StellarPasskey                             | https://communityfund.stellar.org/submissions/reci8Kxk65U44bKvd |
| SmoothSend                                 | https://communityfund.stellar.org/submissions/recyqPV9zvKBFJwxz |
| Soroban Disassembler (Inferara)            | https://communityfund.stellar.org/submissions/recNoycw142XsaEvq |
| Soroban Reverse Engineering Tool (Soliman) | https://communityfund.stellar.org/submissions/recZfT9q0kYI6zjkE |
| Specialized RE Tool                        | https://communityfund.stellar.org/submissions/recfMNsVNBwXQIWCF |
| WASM Debugger (RV)                         | https://communityfund.stellar.org/submissions/recDYQJ63TqlNBacf |
| Hummingbot Integration                     | https://communityfund.stellar.org/submissions/recnnjV6Jghns0xJs |

---

## G. Gaps de verificación

- Evaluación a ciegas: agentes sin estado; contraste solo en §E (mismo caveat que el Prices API — los estados ya se habían visto incidentalmente al scrapear la ronda; el rigor recae en los agentes + disciplina).
- Verificabilidad: varios ganadores tienen artefactos no inspeccionables al 100% (OctoPos repo citado 404 + API host no resuelve + backend cerrado; Orion sitio stub; G2C PoC con 403). Las recomendaciones se apoyan en track record verificado del equipo + docs.
- WASM Debugger: marcado out-of-cluster por spec-mismatch; su award real fue bajo otra categoría.
- Muestra de cada cluster fetchada vía WebFetch; algunos repos/demos pueden haber cambiado tras el snapshot.
