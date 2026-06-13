import { describe, it, expect } from 'vitest'
import {
  aiDecide,
  createAIRider,
  createRider,
  AI_STATES,
  AI_LOG_MAX_ENTRIES,
} from '../src/simulation/engine.js'

const mkRoute = ({ gradient = 0, totalLength = 12000 } = {}) => ({
  getGradientAt: () => gradient,
  totalLength,
})

function mkGrimpeur(wRatio) {
  const r = createAIRider({ aiProfile: 'grimpeur', splinePos: 0 })
  r.energy.wPrime.current = wRatio * r.energy.wPrime.max
  return r
}

describe('aiDecide — journal de raisonnement (rider.aiLog, B1)', () => {
  it('rider.aiLog démarre vide', () => {
    const r = createAIRider({ aiProfile: 'grimpeur' })
    expect(r.aiLog).toEqual([])
  })

  it('première décision : toujours consignée, même sans changement d\'état', () => {
    const r = mkGrimpeur(0.5) // wRatio insuffisant pour attaquer (seuil 60%)
    aiDecide(r, { route: mkRoute({ gradient: 0 }), simSec: 0 })
    expect(r.aiLog).toHaveLength(1)
    expect(r.aiLog[0].aiState).toBe(AI_STATES.FOLLOWING)
    expect(r.aiLog[0].simSec).toBe(0)
    expect(r.aiLog[0].reason).toContain('Suivi (grimpeur)')
  })

  it('décisions identiques consécutives : pas de doublon dans le journal', () => {
    const r = mkGrimpeur(0.5)
    const route = mkRoute({ gradient: 0 })
    aiDecide(r, { route, simSec: 0 })
    aiDecide(r, { route, simSec: 1 })
    aiDecide(r, { route, simSec: 2 })
    expect(r.aiLog).toHaveLength(1) // toujours la même décision (FOLLOWING/eco)
  })

  it('déclenchement d\'attaque (grimpeur, pente forte + W\' suffisant) : nouvelle entrée', () => {
    const r = mkGrimpeur(0.7) // ≥ 60%
    const route = mkRoute({ gradient: 6 }) // ≥ 5% (seuil grimpeur)

    aiDecide(r, { route, simSec: 10 }) // décision initiale → ATTACKING dès le 1er tick

    expect(r.aiState).toBe(AI_STATES.ATTACKING)
    expect(r.aiLog).toHaveLength(1)
    expect(r.aiLog[0].effortMode).toBe('attaque')
    expect(r.aiLog[0].reason).toContain('Attaque (grimpeur)')
    expect(r.aiLog[0].reason).toContain('pente 6.0%')
  })

  it('attaque maintenue (hystérésis) : aucune nouvelle entrée tant que W\' ≥ seuil de sortie', () => {
    const r = mkGrimpeur(0.7)
    const route = mkRoute({ gradient: 6 })

    aiDecide(r, { route, simSec: 0 })  // entre en ATTACKING
    r.energy.wPrime.current = 0.50 * r.energy.wPrime.max // toujours ≥ 15%
    aiDecide(r, { route, simSec: 1 })
    r.energy.wPrime.current = 0.20 * r.energy.wPrime.max
    aiDecide(r, { route, simSec: 2 })

    expect(r.aiState).toBe(AI_STATES.ATTACKING)
    expect(r.aiLog).toHaveLength(1) // toujours la décision initiale
  })

  it('fin d\'attaque (W\' < 15%) → RECOVERING : nouvelle entrée "Fin d\'attaque"', () => {
    const r = mkGrimpeur(0.7)
    const route = mkRoute({ gradient: 6 })

    aiDecide(r, { route, simSec: 0 }) // → ATTACKING

    r.energy.wPrime.current = 0.10 * r.energy.wPrime.max // < 15%
    aiDecide(r, { route, simSec: 30 })

    expect(r.aiState).toBe(AI_STATES.RECOVERING)
    expect(r.aiLog).toHaveLength(2)
    expect(r.aiLog[1].effortMode).toBe('eco')
    expect(r.aiLog[1].reason).toContain("Fin d'attaque")
    expect(r.aiLog[1].simSec).toBe(30)
  })

  it('sortie de récupération : la raison combine "Sortie de récupération" et le raisonnement de suivi', () => {
    const r = mkGrimpeur(0.7)
    const route = mkRoute({ gradient: 6 })

    aiDecide(r, { route, simSec: 0 })  // → ATTACKING
    r.energy.wPrime.current = 0.10 * r.energy.wPrime.max
    aiDecide(r, { route, simSec: 30 }) // → RECOVERING (Éco)

    // W' remonte au-dessus du seuil de sortie (40%), mais pas assez pour
    // ré-attaquer (60%) → repli sur le suivi normal (Maintien en col).
    r.energy.wPrime.current = 0.45 * r.energy.wPrime.max
    aiDecide(r, { route, simSec: 90 })

    expect(r.aiState).toBe(AI_STATES.FOLLOWING)
    expect(r.aiLog).toHaveLength(3)
    const reason = r.aiLog[2].reason
    expect(reason).toContain('Sortie de récupération')
    expect(reason).toContain('Suivi (grimpeur)')
    expect(r.aiLog[2].effortMode).toBe('maintien')
  })

  it('le journal est plafonné à AI_LOG_MAX_ENTRIES (FIFO)', () => {
    const r = mkGrimpeur(0.7)
    const attackRoute = mkRoute({ gradient: 6 })

    // Alterne attaque (W' haut) / fin d'attaque (W' bas) à chaque tick :
    // chaque appel produit une transition d'état → une entrée de journal.
    const N = AI_LOG_MAX_ENTRIES + 10
    for (let i = 0; i < N; i++) {
      r.energy.wPrime.current = (i % 2 === 0 ? 0.70 : 0.10) * r.energy.wPrime.max
      aiDecide(r, { route: attackRoute, simSec: i })
    }

    expect(r.aiLog.length).toBe(AI_LOG_MAX_ENTRIES)
    // FIFO : les entrées les plus anciennes ont été évincées.
    expect(r.aiLog[0].simSec).toBe(N - AI_LOG_MAX_ENTRIES)
    expect(r.aiLog[r.aiLog.length - 1].simSec).toBe(N - 1)
  })

  it('explosion : entrée "explosion" avec aiState EXPLODED et effortMode eco', () => {
    const r = mkGrimpeur(0.5)
    r.energy.exploded = true
    aiDecide(r, { route: mkRoute(), simSec: 5 })

    expect(r.aiState).toBe(AI_STATES.EXPLODED)
    expect(r.aiLog).toHaveLength(1)
    expect(r.aiLog[0].effortMode).toBe('eco')
    expect(r.aiLog[0].reason).toContain('explosion')
  })

  it('coureur joueur (aiProfile null) : aiLog reste vide, pas d\'appel à la machine d\'état', () => {
    const r = createRider({ effortMode: 'maintien' })
    const mode = aiDecide(r, { route: mkRoute(), simSec: 0 })

    expect(mode).toBe('maintien')
    expect(r.aiLog).toEqual([])
  })
})
