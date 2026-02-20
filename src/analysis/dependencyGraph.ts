/**
 * Cross-protocol dependency graph.
 * Models relationships between DeFi assets/protocols as a directed graph.
 * Used for cascade impact analysis when governance changes affect one node.
 */
import { getReadClient } from '../clients/rpc.js'
import { aavePoolAbi } from '../config/abis/aavePool.js'
import { compoundCometAbi } from '../config/abis/compoundComet.js'
import { curveGaugeControllerAbi } from '../config/abis/curveGaugeController.js'
import { AAVE_V3, COMPOUND_V3, CURVE } from '../config/addresses.js'
import { decodeAaveReserveConfig } from '../lib/bignum.js'
import { createLogger } from '../lib/logger.js'
import type {
  DependencyNode,
  DependencyEdge,
  ParamChange,
} from '../types/protocol.js'
import type { CascadeImpact } from '../types/governance.js'

const log = createLogger('dep-graph')

// ─── Graph Data Structure ───────────────────────────────────────────

class ProtocolGraph {
  nodes = new Map<string, DependencyNode>()
  edges: DependencyEdge[] = []

  addNode(node: DependencyNode): void {
    this.nodes.set(node.id, node)
  }

  addEdge(edge: DependencyEdge): void {
    this.edges.push(edge)
  }

  getNode(id: string): DependencyNode | undefined {
    return this.nodes.get(id)
  }

  /**
   * Find all nodes affected by a change at the source node.
   * Uses BFS to traverse outgoing edges.
   */
  findCascadeImpacts(nodeId: string, paramChange: ParamChange): CascadeImpact[] {
    const impacts: CascadeImpact[] = []
    const visited = new Set<string>()
    const queue: Array<{ nodeId: string; depth: number }> = [{ nodeId, depth: 0 }]

    visited.add(nodeId)

    while (queue.length > 0) {
      const current = queue.shift()!
      if (current.depth > 3) continue // Max cascade depth

      // Find outgoing edges
      const outgoing = this.edges.filter((e) => e.from === current.nodeId)

      for (const edge of outgoing) {
        if (visited.has(edge.to)) continue
        visited.add(edge.to)

        const affectedNode = this.nodes.get(edge.to)
        if (!affectedNode) continue

        const impact = simulateCascadeImpact(
          current.nodeId,
          edge.to,
          edge,
          paramChange,
          affectedNode,
        )

        if (impact) {
          impacts.push(impact)
          queue.push({ nodeId: edge.to, depth: current.depth + 1 })
        }
      }
    }

    return impacts
  }
}

// ─── Singleton Instance ─────────────────────────────────────────────

let graph: ProtocolGraph | null = null

export function getGraph(): ProtocolGraph {
  if (!graph) {
    graph = new ProtocolGraph()
  }
  return graph
}

// ─── Graph Building ─────────────────────────────────────────────────

/**
 * Build the dependency graph from on-chain data.
 * Queries Aave reserves, Compound assets, and Curve gauges.
 */
export async function buildDependencyGraph(): Promise<ProtocolGraph> {
  const g = getGraph()
  const client = getReadClient()

  log.info('Building cross-protocol dependency graph...')

  // 1. Aave V3 reserves
  try {
    const reserves = await client.readContract({
      address: AAVE_V3.pool as `0x${string}`,
      abi: aavePoolAbi,
      functionName: 'getReservesList',
    }) as string[]

    for (const reserve of reserves) {
      try {
        const data = await client.readContract({
          address: AAVE_V3.pool as `0x${string}`,
          abi: aavePoolAbi,
          functionName: 'getReserveData',
          args: [reserve as `0x${string}`],
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any

        const configDecoded = decodeAaveReserveConfig(data.configuration)

        const nodeId = `aave:${reserve.toLowerCase()}`
        g.addNode({
          id: nodeId,
          protocol: 'aave',
          asset: reserve,
          tvl: 0n, // Would need price data to compute
          currentParams: {
            ltv: configDecoded.ltv,
            liquidationThreshold: configDecoded.liquidationThreshold,
            liquidationBonus: configDecoded.liquidationBonus,
            borrowCap: configDecoded.borrowCap.toString(),
            supplyCap: configDecoded.supplyCap.toString(),
            isFrozen: configDecoded.isFrozen,
          },
        })
      } catch (err) {
        log.debug({ reserve, err }, 'Failed to read Aave reserve data')
      }
    }

    log.info({ count: reserves.length }, 'Added Aave V3 reserve nodes')
  } catch (err) {
    log.error({ err }, 'Failed to load Aave reserves')
  }

  // 2. Compound V3 assets
  for (const [label, address] of Object.entries(COMPOUND_V3)) {
    try {
      const numAssets = await client.readContract({
        address: address as `0x${string}`,
        abi: compoundCometAbi,
        functionName: 'numAssets',
      }) as number

      for (let i = 0; i < numAssets; i++) {
        try {
          const info = await client.readContract({
            address: address as `0x${string}`,
            abi: compoundCometAbi,
            functionName: 'getAssetInfo',
            args: [i],
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          }) as any

          const nodeId = `compound:${label}:${info.asset.toLowerCase()}`
          g.addNode({
            id: nodeId,
            protocol: 'compound',
            asset: info.asset,
            tvl: 0n,
            currentParams: {
              borrowCollateralFactor: info.borrowCollateralFactor.toString(),
              liquidateCollateralFactor: info.liquidateCollateralFactor.toString(),
              supplyCap: info.supplyCap.toString(),
              comet: address,
            },
          })

          // Cross-protocol edge: if asset exists in both Aave and Compound
          // Check if edge already exists to prevent duplicates
          const aaveNodeId = `aave:${info.asset.toLowerCase()}`
          if (g.nodes.has(aaveNodeId)) {
            const edgeKey1 = `${aaveNodeId}->${nodeId}`
            const edgeKey2 = `${nodeId}->${aaveNodeId}`
            
            if (!g.edges.some(e => `${e.from}->${e.to}` === edgeKey1)) {
              g.addEdge({
                from: aaveNodeId,
                to: nodeId,
                type: 'collateral',
                weight: 0.5,
                description: 'Same asset listed on both Aave and Compound',
              })
            }
            
            if (!g.edges.some(e => `${e.from}->${e.to}` === edgeKey2)) {
              g.addEdge({
                from: nodeId,
                to: aaveNodeId,
                type: 'collateral',
                weight: 0.5,
                description: 'Same asset listed on both Compound and Aave',
              })
            }
          }
        } catch (err) {
          log.debug({ label, assetIndex: i, err }, 'Failed to read Compound asset')
        }
      }

      log.info({ comet: label, assets: numAssets }, 'Added Compound V3 asset nodes')
    } catch (err) {
      log.debug({ label, err }, 'Failed to load Compound assets')
    }
  }

  // 3. Curve gauge weights (optional — can be slow)
  try {
    const nGauges = await client.readContract({
      address: CURVE.gaugeController as `0x${string}`,
      abi: curveGaugeControllerAbi,
      functionName: 'n_gauges',
    }) as bigint

    const gaugeCount = Math.min(Number(nGauges), 20) // Limit to top 20 for speed

    for (let i = 0; i < gaugeCount; i++) {
      try {
        const gaugeAddr = await client.readContract({
          address: CURVE.gaugeController as `0x${string}`,
          abi: curveGaugeControllerAbi,
          functionName: 'gauges',
          args: [BigInt(i)],
        }) as string

        const weight = await client.readContract({
          address: CURVE.gaugeController as `0x${string}`,
          abi: curveGaugeControllerAbi,
          functionName: 'gauge_relative_weight',
          args: [gaugeAddr as `0x${string}`],
        }) as bigint

        const nodeId = `curve:gauge:${gaugeAddr.toLowerCase()}`
        g.addNode({
          id: nodeId,
          protocol: 'curve',
          asset: gaugeAddr,
          tvl: 0n,
          currentParams: {
            relativeWeight: weight.toString(),
          },
        })
      } catch (err) {
        log.debug({ gaugeIndex: i, err }, 'Failed to read Curve gauge')
      }
    }

    log.info({ count: gaugeCount }, 'Added Curve gauge nodes')
  } catch (err) {
    log.debug({ err }, 'Failed to load Curve gauges')
  }

  log.info(
    { nodes: g.nodes.size, edges: g.edges.length },
    'Dependency graph built',
  )

  return g
}

// ─── Cascade Impact Simulation ──────────────────────────────────────

function simulateCascadeImpact(
  sourceNodeId: string,
  affectedNodeId: string,
  edge: DependencyEdge,
  paramChange: ParamChange,
  _affectedNode: DependencyNode,
): CascadeImpact | null {
  // Determine cascade severity based on edge type and param change
  let severity: 'low' | 'medium' | 'high' | 'critical' = 'low'
  let estimatedEffect = ''

  switch (edge.type) {
    case 'collateral':
      if (paramChange.param === 'liquidationThreshold' || paramChange.param === 'ltv') {
        severity = 'high'
        estimatedEffect = `LT/LTV change on ${sourceNodeId} may affect borrowing against same asset on ${affectedNodeId}`
      }
      break

    case 'liquidity':
      if (paramChange.param === 'supplyCap' || paramChange.param === 'borrowCap') {
        severity = 'medium'
        estimatedEffect = `Cap change may redirect liquidity flow`
      }
      break

    case 'gauge':
      severity = 'medium'
      estimatedEffect = `Gauge weight redistribution may affect yield`
      break

    case 'oracle':
      severity = 'critical'
      estimatedEffect = `Oracle change cascades through all dependent price feeds`
      break

    case 'recursive':
      severity = 'high'
      estimatedEffect = `Recursive leverage positions may be force-unwound`
      break
  }

  if (!estimatedEffect) return null

  return {
    sourceNode: sourceNodeId,
    affectedNode: affectedNodeId,
    impactType: edge.type,
    estimatedEffect,
    severity,
  }
}

/**
 * Refresh the dependency graph with latest on-chain data.
 */
export async function refreshGraph(): Promise<void> {
  graph = new ProtocolGraph()
  await buildDependencyGraph()
}
