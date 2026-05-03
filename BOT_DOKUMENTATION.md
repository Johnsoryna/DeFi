# DeFi Governance Alpha Bot — Vollständige Dokumentation

> Stand: März 2026 (v33) | Backtest-Ergebnis: **35 Trades, +$397K (+397%)** über 13 Monate (Jan 2025 – Feb 2026)

---

## Was macht der Bot?

Der Bot beobachtet Governance-Abstimmungen von DeFi-Protokollen (AAVE, Compound, dYdX, Lido, etc.) und handelt darauf basierend mit Krypto-Futures auf Binance.

**Grundidee:** Wenn ein Protokoll eine riskante Governance-Entscheidung trifft (z.B. LTV-Senkung, Asset-Freeze, Emergency-Proposal), fällt der zugehörige Token typischerweise. Der Bot shortet in diesem Fall bevor der Markt vollständig reagiert hat.

**Edge:** Governance-Proposals werden zuerst in Foren diskutiert, dann auf Snapshot abgestimmt, dann on-chain. Der Bot liest bereits die Forum-Posts — **Stunden bis Tage bevor der Markt reagiert.**

---

## Gesamtüberblick: Der Datenfluss

```
┌─────────────────────────────────────────────────────────┐
│               DATENQUELLEN (Inputs)                      │
│                                                          │
│  Forum Posts     Snapshot Votes    On-Chain Proposals    │
│  (AAVE, COMP,    (aavedao.eth,     (Compound Governor,   │
│   Arbitrum, ...)  morpho.eth, ...)  Aave GovernanceV3)   │
└───────────────────────┬─────────────────────────────────┘
                        │ Events: governance:forum
                        │         governance:snapshot
                        │         governance:proposal
                        ▼
┌─────────────────────────────────────────────────────────┐
│            ANALYSE (intelligenceEngine.ts)               │
│                                                          │
│  1. NLP analysiert den Text (nlpEngine.ts)               │
│     → Proposal-Typ bestimmen (risk_mitigation? LTV?)     │
│     → Sentiment (bearish/bullish/neutral)                │
│     → Betroffene Assets extrahieren                      │
│                                                          │
│  2. Calldata-Decoding (bei On-Chain)                     │
│     → Genaue Parameter lesen (LTV 80%→70%?)             │
│     → Technische Klassifikation                          │
│                                                          │
│  Output: IntelligentAnalysis                             │
│  { type, assets, sentiment, confidence, impacts }        │
└───────────────────────┬─────────────────────────────────┘
                        │ Event: analysis:proposal
                        ▼
┌─────────────────────────────────────────────────────────┐
│          SIGNAL-GENERIERUNG (signalGenerator.ts)         │
│                                                          │
│  Entscheidet: Trade ja/nein? Long oder Short? Welcher    │
│  Asset? Wie groß?                                        │
│                                                          │
│  7 Strategien je nach Proposal-Typ:                      │
│  - risk_mitigation  → SHORT (Freeze, Delist, Notfall)    │
│  - technical_param  → SHORT (LTV-Senkung, Cap-Senkung)   │
│  - asset_onboarding → LONG (neues Asset im Protokoll)    │
│  - protocol_deploy  → LONG (neues Chain-Deployment)      │
│  - economic_policy  → nach Sentiment                     │
│                                                          │
│  Filter (blocken unbrauchbare Signale):                  │
│  - Stablecoin-Filter: USDC-Supply-Cap → kein AAVE-Trade  │
│  - On-Chain-Vote-Guard: market schon eingepreist → 2x max│
│  - L2-Deprecation: sUSD auf Optimism → kein SNX-Short    │
│  - Validator-Exit-Filter: einzelne Validator, kein Risk  │
│                                                          │
│  Output: TradeSignal                                     │
│  { asset, direction, sizePct, confidence, riskProfile }  │
└───────────────────────┬─────────────────────────────────┘
                        │ Event: signal:generated
                        ▼
┌─────────────────────────────────────────────────────────┐
│        CONFIDENCE & SIZING (confidenceScorer.ts)         │
│                                                          │
│  Berechnet finale Confidence aus 6 Faktoren:             │
│                                                          │
│  Faktor              Gewicht  Bedeutung                  │
│  NLP-Confidence       15%     Wie sicher ist NLP?        │
│  Stage-Score          30%     Wie weit ist die Abstimmung│
│  Proposal-Type        15%     Wie handelbar ist der Typ? │
│  Asset-Qualität       10%     Ist der Asset priceable?   │
│  Quellen-Verlässl.    20%     Forum vs On-Chain-Calldata │
│  Sentiment-Match      10%     Stimmt Sentiment+Direction │
│                                                          │
│  Stage-Scores:                                           │
│  Forum-Post=0.05, Snapshot=0.45, On-Chain=0.75           │
│  Timelock=0.95, Executed=1.0                             │
│                                                          │
│  Kelly-Position-Sizing:                                  │
│  f = (b×p - q) / b  (Half-Kelly)                        │
│  Größe: 3%-12% des Portfolios                            │
│  Leverage: 1x-7x je nach Confidence + Asset              │
│                                                          │
│  Output: Confidence (0-1), sizePct, leverage             │
└───────────────────────┬─────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────┐
│           RISIKOMANAGEMENT (riskManager.ts)              │
│                                                          │
│  Prüft ob der Trade ausgeführt werden kann:              │
│  - Max. 1 Position pro Asset gleichzeitig               │
│  - Exposure-Limit (kein Klumpenrisiko)                   │
│  - Monthly-Loss-Limit (Drawdown-Schutz)                  │
│  - Confidence über Minimum-Schwelle?                     │
│                                                          │
│  Output: Signal freigegeben oder blockiert               │
└───────────────────────┬─────────────────────────────────┘
                        │ Event: signal:validated
                        ▼
┌─────────────────────────────────────────────────────────┐
│           AUSFÜHRUNG (binanceExecutor.ts)                │
│                                                          │
│  Platziert 3-4 Orders auf Binance Futures:               │
│                                                          │
│  1. MARKET Order (Entry)                                 │
│     → Sofortige Ausführung zum aktuellen Preis           │
│                                                          │
│  2. STOP_MARKET (Stop-Loss) — Algo-Order                 │
│     → Schließt Position bei festem Verlust-Level         │
│     → Short-SL: Entry × (1 + SL%)                       │
│                                                          │
│  3. TAKE_PROFIT_MARKET (Take-Profit) — Algo-Order        │
│     → Schließt Position bei Gewinn-Ziel                  │
│     → Short-TP: Entry × (1 - TP%)                       │
│                                                          │
│  4. TRAILING_STOP_MARKET — Algo-Order                    │
│     → Folgt dem Preis, sichert Gewinne ein               │
│     → Aktiviert bei X% Gewinn, Callback 5%              │
│     → Max callbackRate 5% (Binance-Limit)                │
│                                                          │
│  Output: execution:result { entryPrice, orderId, size }  │
└───────────────────────┬─────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────┐
│         POSITION MONITORING (positionTracker.ts)         │
│                                                          │
│  Alle 30 Sekunden:                                       │
│  - Aktuelle Positionen von Binance abfragen             │
│  - Unrealized PnL berechnen                              │
│  - Position geschlossen? → Win/Loss aufzeichnen          │
│                                                          │
│  Alle 30 Minuten:                                        │
│  - Max-Holding-Time prüfen (720h = 30 Tage)             │
│  - Abgelaufene Positionen schließen                      │
└─────────────────────────────────────────────────────────┘
```

---

## Die drei Datenbeschaffungs-Layer

### 1. On-Chain Proposals (höchste Qualität)
- **Was:** Direkte Blockchain-Events von Compound Governor, Aave GovernanceV3, etc.
- **Vorteil:** Calldata enthält exakte Parameter (LTV 80% → 70%) — maschinell lesbar
- **Stage:** `monitoring` → `discussion` → `onchain_vote` → `timelock` → `executed`
- **Timing:** Bot reagiert schon bei `monitoring` (Proposal eingereicht, noch kein Vote)

### 2. Snapshot Proposals (mittlere Qualität)
- **Was:** Off-Chain-Abstimmungen auf snapshot.org (gaslos, schneller)
- **Spaces:** aavedao.eth, compound-governance.eth, arbitrumfoundation.eth, morpho.eth, ...
- **Stage:** `snapshot` (entspricht Confidence-Boost von 0.45 in Stage-Score)
- **Polling:** Alle 5 Minuten nach neuen Proposals

### 3. Forum Posts (früheste Signale)
- **Was:** Governance-Forum-Posts vor der eigentlichen Abstimmung
- **Quellen:** governance.aave.com, www.comp.xyz, forum.arbitrum.foundation, ...
- **Vorteil:** 24-72h vor Snapshot — frühester Einstieg
- **Nachteil:** Niedriger Stage-Score (0.05-0.15), höhere Fehlrate
- **Polling:** Alle 15 Minuten

---

## NLP: Wie der Bot Texte versteht

Der NLP-Engine (`nlpEngine.ts`) klassifiziert Proposal-Texte ohne externe KI — rein mit Keyword-Scoring.

### Proposal-Typen und Beispiele

| Typ | Beispiel-Proposal | Typische Aktion |
|-----|-------------------|-----------------|
| `technical_parameter` | "Reduce wstETH LTV from 80% to 72%" | SHORT wstETH/LDO |
| `risk_mitigation` | "Freeze USDT market on Aave v2" | SHORT AAVE |
| `asset_onboarding` | "Add EIGEN as collateral on Aave" | LONG AAVE |
| `protocol_deployment` | "Deploy Aave v3 on Base" | LONG AAVE |
| `economic_policy` | "Reduce LDO emissions by 30%" | SHORT LDO |
| `infrastructure` | "Upgrade Timelock contract" | kein Trade |
| `treasury_funding` | "Allocate 500k USDC to grants" | kein Trade |

### Sentiment-Analyse
- **Bearish-Keywords:** deprecat\*, freeze, delist, emergency, sunset, wind down, cease, recall
- **Bullish-Keywords:** onboard, deploy, expand, launch, increase, enable, upgrade
- **Neutral:** routine, update, parameter, adjust (ohne klare Richtung)

### Warum kein LLM?
Getestet mit Gemma2:2b (Ollama). Ergebnis: 0 neue Trades bei gleicher Performance ($327K). Das Keyword-NLP ist bereits vollständig — alle Signal-Keywords sind bekannt und implementiert.

---

## Signal-Generierung im Detail

### Die 7 Strategien

#### 1. `risk_mitigation` — Der stärkste Edge
```
Wenn: "freeze", "delist", "emergency", "deprecat*" im Proposal
Dann: SHORT des betroffenen Assets ODER SHORT des Gov-Tokens
```
- AAVE freezes Token X → SHORT AAVE (Protokoll-Reputation leidet)
- AAVE freezes wstETH → SHORT wstETH + SHORT LDO (Hebel 4: Collateral-Issuer-Kaskade)
- Sonderfall: v2-Deprecation → LONG (v3-Migration ist bullish)
- Sonderfall: Stablecoin-Freeze → SHORT Gov-Token (aber nicht bei on-chain stage!)

#### 2. `technical_parameter` — Häufigster Typ
```
LTV-Senkung   → SHORT betroffener Asset (riskanter für Protokoll)
Supply-Cap ↓  → SHORT Gov-Token (schlechtere Kapitaleffizienz)
Interest-Rate → SHORT Gov-Token (Nutzer wandern ab)
Reserve-Freeze → SHORT Asset direkt
```
- **Wichtig:** "Chaos Labs Risk Stewards"-Proposals → werden korrekt gefiltert
  (Routine-Parameter-Updates ohne Alpha, früher 42.9% WR → jetzt geskippt)

#### 3. `asset_onboarding`
```
Neues Asset als Collateral → LONG Gov-Token (mehr TVL, mehr Gebühren)
```

#### 4. `protocol_deployment`
```
Neues Chain-Deployment → LONG Gov-Token (Expansion ist bullish)
```

### Kritische Filter

**Stablecoin-Filter:**
```
AAVE ändert USDC Supply Cap → kein AAVE-Trade
Grund: AAVE-Preis bewegt sich nicht bei Stablecoin-Parameter-Tweaks
```

**On-Chain-Vote-Guard (C5):**
```
Signal bei on-chain_vote Stage → Leverage maximal 2x
Grund: Markt hat das bereits eingepreist, Alpha ist kleiner
```

**L2-Deprecation-Filter:**
```
"Deprecate sUSD on Optimism" → kein SNX-Short
Grund: Mainnet-Gov-Token nicht betroffen von L2-Stablecoin-Cleanup
```

**Validator-Exit-Filter:**
```
"Pareto Labs validator wind down" → kein Trade
Grund: Einzelner Validator-Shutdown = kein Protokoll-Risiko
```

**Long-Asymmetrie:**
```
Longs brauchen +15% höhere Confidence als Shorts
Grund: Governance-bearish Signals haben 75%+ WR, bullish nur ~50%
```

---

## Confidence-Berechnung im Detail

```
Confidence = 0.15 × NLP_Conf
           + 0.30 × Stage_Score
           + 0.15 × Type_Tradability
           + 0.10 × Asset_Quality
           + 0.20 × Source_Reliability
           + 0.10 × Sentiment_Alignment
```

### Stage-Scores (wichtigster Faktor, 30% Gewicht)
```
Forum-Post (monitoring):   0.05  → selten genug Confidence für Trade
Discussion:                0.15
Snapshot-Vote:             0.45  → hier entstehen die meisten Trades
On-Chain-Vote:             0.75
Timelock:                  0.95
Executed:                  1.00
Canceled:                  0.00
```

### Minimum-Confidence-Schwellen
```
Snapshot-Vote:  ≥ 0.55
On-Chain-Vote:  ≥ 0.50
Timelock:       ≥ 0.40
AAVE/COMP/...   Standard
MORPHO:         ≥ 0.65 (schwächeres Alpha, höhere Hürde)
```

---

## Position-Sizing: Kelly Criterion

Der Bot nutzt Half-Kelly für optimales Position-Sizing:

```
f* = (b × p - q) / b

b = Reward/Risk-Ratio = 2.5
p = geschätzte Win-Rate (basierend auf Confidence)
q = 1 - p

Half-Kelly: f_actual = f* × 0.5
```

### Win-Rate-Schätzung
```
p = 0.55 (Basis-WR)
  + 0.15 (wenn Short — historisch 75%+ WR für Shorts)
  + (confidence - 0.5) × 0.2

Beispiel: confidence=0.72, Short
p = 0.55 + 0.15 + (0.72-0.5)×0.2 = 0.55 + 0.15 + 0.044 = 0.744
```

### Leverage-Berechnung
```
Shorts: 1 + (normalized_conf)^0.58 × (max_lev - 1)
Longs:  1 + (normalized_conf)^0.70 × (max_lev - 1)

Leverage-Caps per Asset (C4):
AAVE, ARB:  max 7x
LDO:        max 3x
DYDX:       max 2x
```

### Größen-Grenzen
```
Minimum:  3% des Portfolios
Maximum: 12% des Portfolios (Kelly-Cap)
Max Verlust pro Trade: 12% (Shorts), 7% (Longs)
```

---

## Risk-Profile: Stop-Loss, Take-Profit, Trailing Stop

Je nach Urgency und Confidence wird ein von drei Profilen gewählt:

| Profil | SL | TP | Trail aktiviert bei | Trail-Abstand | Max-Holding |
|--------|----|----|---------------------|---------------|-------------|
| **Aggressive** | 12% | 36% | 15% Gewinn | 5%* | 720h |
| **Moderate** | 10% | 26% | 14% Gewinn | 5%* | 720h |
| **Conservative** | 8% | 20% | 10% Gewinn | 4% | 720h |

*Binance-Limit: callbackRate max 5% (auch wenn im Config 7% steht)

### Wie Trailing Stop funktioniert (Beispiel AAVE SHORT)
```
Entry:          $123.64
Trail-Aktiv bei: $122.44 (= Entry × (1 - 0.01)) — bereits aktiv
Callback-Rate:   5%

Wenn AAVE auf $110 fällt:
  → Trailing Stop = $110 × 1.05 = $115.50  (eingelockt)

Wenn AAVE weiter auf $100 fällt:
  → Trailing Stop = $100 × 1.05 = $105.00  (noch mehr eingelockt)

Wenn AAVE von $100 auf $105.01 steigt:
  → Trailing Stop FEUERT → Position wird geschlossen → ~$60 Gewinn
```

### Exit-Hierarchie (was feuert zuerst)
1. **Max-Loss-Cap** ($10K Verlust = 10% Portfolio) — feuert sofort, kein 72h-Wait
2. **Stop-Loss** — feuert ab 72h Haltedauer (davor kein SL außer max-loss-cap)
3. **Trailing Stop** — folgt dem Markt dynamisch
4. **Take-Profit** — selten (30% TP ist hohes Ziel)
5. **Max-Holding** — nach 720h (30 Tage), schließt automatisch

### Warum 72h Minimum vor Stop-Loss?
Governance-Events brauchen Zeit. Die ersten 72h ist der Markt oft volatil bevor er die Richtung findet. Trades die in <72h gestoppt wurden hatten historisch ≤33% WR.

---

## Backtest vs. Live: 1:1 Parität

Der Bot ist so gebaut, dass Backtest und Live **identische Logik** ausführen:

```
Backtest:                          Live:
  replayProvider.ts          ←→     snapshotMonitor.ts
  MockPriceMonitor           ←→     livePriceService.ts
  mockExecutor.ts            ←→     binanceExecutor.ts
  resultCollector.ts         ←→     positionTracker.ts + index.ts
```

**Wichtig:** `gasCostUsd` in mockExecutor ist nur Metadata — wird nie vom PnL abgezogen.

---

## Bekannte Protokolle und ihr Alpha

| Protokoll | Trades | WR | PnL | Edge |
|-----------|--------|-----|-----|------|
| AAVE | 12 | 75% | +$113.366 | LTV-/Freeze-/Risk-Events |
| ARB | 5 | 80% | +$105.663 | Risk-Parameter-Proposals |
| DYDX | 5 | 80% | +$24.621 | OI-Cap-Reduktionen |
| COMP | 4 | 75% | +$14.707 | Gov-Risk-Events |
| LDO | 3 | 67% | +$17.452 | AAVE wstETH Kaskade + LDO eigene Gov |
| CRV | 3 | 67% | +$3.936 | gov.curve.fi Forum-Posts |
| WSTETH | 1 | 100% | +$9.843 | AAVE Degradation Signal |
| EIGEN | 1 | 100% | +$1.793 | EigenLayer Forum Risk Event |
| YFI | 1 | 100% | +$1.839 | "Disable Protocol Fees on Yearn V3" → weniger Fee-Revenue = bearish für YFI |

**Protokolle mit 0 Trades (korrekt gefiltert):**
CVX, SNX, GRT, Euler, Pendle, 1inch, Jito, Pyth, Venus, RPL — NLP erkennt routine governance korrekt

**Hinweis:** INJ und GMX wurden entfernt — On-Chain-Trading ist per Default deaktiviert (INJ/cosmos waren die 2 verlierenden On-Chain-Trades). GMX hat keine Risk-Parameter-Events in 2025–2026 geliefert.

---

## Datenbankstruktur

```
data/governance.db (live — NIEMALS überschreiben!)
  - proposals:      alle gesehenen Proposals
  - snapshot_cursors: Polling-Fortschritt pro Space
  - positions:      aktuelle Positionen
  - trades:         abgeschlossene Trades

data/backtest.db (backtest only)
  - historical_prices:     OHLCV-Daten für Backtesting
  - historical_proposals:  Governance-Events für Replay
  - historical_forum_posts: Forum-Posts für Replay
```

---

## Deployment & Infrastruktur

```
Server: 152.53.135.86
Path:   /home/john/defi-bot/
PM2:    pm2 restart defi-bot --update-env
Logs:   /home/john/defi-bot/logs/out.log
        /home/john/defi-bot/logs/error.log
```

### Deploy-Befehl
```bash
# Archiv bauen (NIEMALS im Working-Dir — nach /tmp schreiben!)
tar --exclude='.git' --exclude='node_modules' \
    --exclude='data/*.db' --exclude='data/*.db-wal' --exclude='data/*.db-shm' \
    --exclude='*.tar.gz' \
    -czf /tmp/defi-update-vN.tar.gz .

scp /tmp/defi-update-vN.tar.gz john@152.53.135.86:/home/john/
ssh john@152.53.135.86 'cd /home/john && \
  tar -xzf defi-update-vN.tar.gz -C defi-bot/ && \
  grep -v "^$\|^#" /home/john/.env.secrets >> /home/john/defi-bot/.env && \
  export PATH=$PATH:/home/john/.nvm/versions/node/v20.20.0/bin && \
  cd defi-bot && npm install --silent && pm2 restart defi-bot --update-env'
```

**Kritisch:**
- `data/*.db` NIEMALS mitschicken — `governance.db` enthält live Positionen und Cursor-Stände!
- `--update-env` auf `pm2 restart` ist Pflicht, sonst werden neue .env-Variablen ignoriert
- Tar MUSS nach `/tmp/` geschrieben werden, nicht ins Working-Dir (sonst "file changed as we read it")

---

## Häufige Fragen

**Warum hauptsächlich Shorts?**
Governance-bearish Signale haben 75%+ Win-Rate. Governance-bullish (LONG) nur ~50%. Der Bot bevorzugt deshalb Shorts und verlangt für Longs +15% höhere Confidence.

**Warum nicht mehr Trades?**
Qualität über Quantität. 34 Trades in 13 Monaten, alle mit klarem Edge. Mehr Trades = mehr Rauschen. Der Exposure-Limit-Mechanismus blockiert korrelierte Signale (gleiche Makro-Umgebung). Getestete Erweiterungen (Cascade WEETH→ETHFI, USDE→ENA, Confidence-Schwelle senken) lieferten alle 0 neue Trades — das Dataset ist vollständig ausgeschöpft.

**Warum sind Stablecoin-Governance-Events kein Signal?**
Wenn Aave den USDC Supply Cap erhöht, bewegt sich der AAVE-Token kaum. Die Analyse betrifft das Stablecoin, nicht den Gov-Token. Daher: alle-Stablecoin-Impacts + kein Freeze/Delist → kein Trade.

**Was ist der trailing stop "API Level" vs "echter Level"?**
Binance zeigt in `/fapi/v1/openAlgoOrders` den Level zum Zeitpunkt der Erstellung/Aktivierung. In Wirklichkeit trackt Binance intern den Running-Low und berechnet: `stop = running_min × (1 + callbackRate)`. Der echte Level = `current_mark × 1.05` (wenn Preis weiter gefallen ist).

**Was passiert bei Bot-Neustart?**
- Positionen werden via Binance API wiederhergestellt
- Entry-Timestamps werden aus Order-History (`/fapi/v1/allOrders`) geholt — echte Zeiten, kein Date.now()
- Algo-Orders (SL/TP/Trail) bleiben auf Binance aktiv — kein Neusetzen nötig

---

## Wichtige Konstanten (nicht ändern!)

| Konstante | Wert | Warum wichtig |
|-----------|------|---------------|
| `DEFAULT_WEIGHTS` | 0.15/0.30/0.15/0.10/0.20/0.10 | Umgewichten = PnL kollabiert ($254K→$141K) |
| `maxSizePct` | 12% | Max Verlust pro Trade begrenzt |
| `MAX_HISTORY_MS` | 14 Tage | Price-Cache-Fenster |
| `shortScalePower` | 0.58 | Leverage-Scaling-Exponent, +$3K vs 0.55 |
| `trailingStopMax` | 5.0% | Binance-Limit, 7% wäre dead config |
| `trailingAct_moderate` | 0.14 | Erhöht von 0.12 (OODA iter-3), Revert wenn WR<75% |
| `maxHoldingHours` | 720 | 30 Tage, alle 3 Profile |
| `72h min hold` | 72h | SL feuert nicht in den ersten 3 Tagen |
| `MORPHO threshold` | 0.65 | Schwächeres Alpha → höhere Hürde |
| `long_offset` | +0.15 | Longs brauchen mehr Confidence |
| `on-chain trading` | OFF (default) | INJ/cosmos waren die 2 verlierenden On-Chain-Trades |

---

## Live-Features (v26+, März 2026)

| Feature | Beschreibung |
|---------|-------------|
| **Uniswap Forum** | `gov.uniswap.org` zu `forumMonitor.ts` hinzugefügt |
| **EigenLayer Forum** | `forum.eigenlayer.xyz` hinzugefügt — liefert 1 EIGEN Backtest-Trade |
| **Funding Rate Boost** | Short-Confidence +0.03 wenn Funding Rate > 0.05%/8h (live only) |
| **Heap Alert** | Telegram-Alert bei > 90% Heap AND heapTotal > 200MB (alle 30min geprüft) |
| **Weekly Report** | Montags 08:00 UTC: Wallet-Balance, uPnL, offene Positionen |
| **pm2-logrotate** | Max 10MB/Datei, 7 Dateien, komprimiert |
| **Proposal-Persistenz** | Analysen werden in DB gespeichert, bei Neustart wiederhergestellt |
| **On-Chain Backfill** | GovernorBravo: letzte 30 Proposals werden beim Start nachgeladen |

---

## Validierte Experimente (März 2026)

Alle folgenden Experimente wurden auf dem vollen 13-Monats-Dataset getestet:

| Experiment | Ergebnis | Grund |
|------------|----------|-------|
| `directionMinConf` Longs: +0.10 statt +0.15 | **0 neue Trades** | Smart Filter (A3-Momentum) ist die echte Schranke — nicht der Confidence-Schwellwert |
| WEETH→ETHFI Kaskade | **0 neue Trades** | Alle weETH/Ether.fi AAVE-Proposals im Dataset sind LT/LTV-**Erhöhungen** (E-Mode-Adds), keine Degradierungen |
| USDE→ENA Kaskade | **0 neue Trades** | Alle USDe-Proposals sind Onboarding (bullish = Long-gefiltert), keine Freeze-Events |
| LLM-Cache (Gemma2:2b) | **0 neue Trades, +0 PnL** | Keyword-NLP ist bereits vollständig — LLM hat keine fehlenden Signale gefunden |
| Hebel 3 Kaskade (WBTC→COMP) | **verliert Geld** | Protokolle haben unabhängige Risiko-Timelines, `CASCADE_COLLATERAL_PROTOCOLS = {}` bleibt leer |
| Body-Type NLP-Boost | **−$8K netto** | Fügt CVX-Rauschen hinzu, kein Gewinn; revertiert |
| `kill` als NLP-Keyword | **katastrophal** (53 Trades, −$6K) | Curve hat 15 "Kill Gauge"-Posts/Jahr (Routine-Pool-Wartung). NIEMALS hinzufügen! |

**Fazit:** Das 34-Trade / $391K-Ergebnis ist das Optimum aus dem historischen Dataset. Neue Trades entstehen organisch durch neue Governance-Risk-Events im Live-Betrieb.
