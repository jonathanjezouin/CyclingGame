import { describe, it, expect } from 'vitest'
import {
  aiDecide,
  shouldAttack,
  baseEffortMode,
  AI_STATES,
  AI_PROFILES,
  createAIRider,
  createRider,
  simulateTick,
} from '../src/simulation/engine.js'

// ─── Helpers ─────────────────────────────────────────────────────────────────
const mkRoute = ({ gradient = 0, totalLength = 12000 } = {}) => ({
  getGradientAt: () => gradient,
  totalLength,
})

function mkRider(aiProfile, { wRatio = 1, exploded = false, aiState = AI_STATES.FOLLOWING, splinePos = 0 } = {}) {
  const r = createAIRider({ aiProfile, splinePos })
  r.energy.wPrime.current = wRatio * r.energy.wPrime.max
  r.energy.exploded = exploded
  r.aiState = aiState
  return r
}

// ─── Croisière (FOLLOWING) — baseEffortMode par profil ──────────────────────
describe('baseEffortMode — stratégie de croisière par profil (TDD v0.5 §12.2)', () => {
  it('grimpeur : Maintien en montée', () => {
    expect(baseEffortMode({ aiProfile: 'grimpeur' }, 3, 5000)).toBe('maintien')
  })

  it('grimpeur : Éco sur le plat/descente', () => {
    expect(baseEffortMode({ aiProfile: 'grimpeur' }, 0, 5000)).toBe('eco')
    expect(baseEffortMode({ aiProfile: 'grimpeur' }, -5, 5000)).toBe('eco')
  })

  it('rouleur : Éco en montagne', () => {
    expect(baseEffortMode({ aiProfile: 'rouleur' }, 6, 5000)).toBe('eco')
  })

  it('rouleur : Maintien sur plat/faux-plat', () => {
    expect(baseEffortMode({ aiProfile: 'rouleur' }, 1, 5000)).toBe('maintien')
  })

  it('sprinteur : Éco loin de l\'arrivée', () => {
    expect(baseEffortMode({ aiProfile: 'sprinteur' }, 0, 5000)).toBe('eco')
  })

  it('sprinteur : Maintien dans les 2 derniers km', () => {
    expect(baseEffortMode({ aiProfile: 'sprinteur' }, 0, 1500)).toBe('maintien')
  })

  it('équipier : Éco en montagne, Maintien sur le plat (calque rouleur en attendant le modèle d\'équipe)', () => {
    expect(baseEffortMode({ aiProfile: 'equipier' }, 5, 5000)).toBe('eco')
    expect(baseEffortMode({ aiProfile: 'equipier' }, 0, 5000)).toBe('maintien')
  })
})

// ─── shouldAttack — seuils d'attaque par profil ─────────────────────────────
describe('shouldAttack — seuils d\'attaque (TDD v0.5 §12.2)', () => {
  it('grimpeur attaque si gradient ≥ 5% et W\' ≥ 60%', () => {
    expect(shouldAttack({ aiProfile: 'grimpeur' }, 6, 5000, 0.65)).toBe(true)
  })

  it('grimpeur ne tente rien si W\' insuffisant malgré la pente', () => {
    expect(shouldAttack({ aiProfile: 'grimpeur' }, 6, 5000, 0.50)).toBe(false)
  })

  it('grimpeur ne tente rien si la pente est trop faible malgré le W\'', () => {
    expect(shouldAttack({ aiProfile: 'grimpeur' }, 3, 5000, 0.90)).toBe(false)
  })

  it('rouleur attaque sur le plat si W\' ≥ 70%', () => {
    expect(shouldAttack({ aiProfile: 'rouleur' }, 1, 5000, 0.75)).toBe(true)
  })

  it('rouleur n\'attaque pas en montée même avec W\' plein', () => {
    expect(shouldAttack({ aiProfile: 'rouleur' }, 4, 5000, 1.0)).toBe(false)
  })

  it('sprinteur attaque dans les 500 derniers mètres, quel que soit W\'', () => {
    expect(shouldAttack({ aiProfile: 'sprinteur' }, 0, 400, 0.05)).toBe(true)
    expect(shouldAttack({ aiProfile: 'sprinteur' }, 0, 600, 1.0)).toBe(false)
  })

  it('équipier n\'attaque jamais (TDD v0.5 §12.2)', () => {
    expect(shouldAttack({ aiProfile: 'equipier' }, 6, 5000, 1.0)).toBe(false)
    expect(shouldAttack({ aiProfile: 'equipier' }, 0, 100, 1.0)).toBe(false)
  })
})

// ─── aiDecide — machine d'états ─────────────────────────────────────────────
describe('aiDecide — déclenchement d\'attaque', () => {
  it('grimpeur en col, W\' suffisant → attaque, état ATTACKING', () => {
    const rider = mkRider('grimpeur', { wRatio: 0.65 })
    const mode = aiDecide(rider, { route: mkRoute({ gradient: 6 }) })
    expect(mode).toBe('attaque')
    expect(rider.aiState).toBe(AI_STATES.ATTACKING)
  })

  it('grimpeur en col, W\' trop bas → reste en Maintien, FOLLOWING', () => {
    const rider = mkRider('grimpeur', { wRatio: 0.50 })
    const mode = aiDecide(rider, { route: mkRoute({ gradient: 6 }) })
    expect(mode).toBe('maintien')
    expect(rider.aiState).toBe(AI_STATES.FOLLOWING)
  })

  it('rouleur sur le plat, W\' élevé → attaque', () => {
    const rider = mkRider('rouleur', { wRatio: 0.80 })
    const mode = aiDecide(rider, { route: mkRoute({ gradient: 0 }) })
    expect(mode).toBe('attaque')
    expect(rider.aiState).toBe(AI_STATES.ATTACKING)
  })
})

describe('aiDecide — persistance et sortie d\'attaque', () => {
  it('une attaque en cours se maintient même si la pente change, tant que W\' ≥ 15%', () => {
    const rider = mkRider('grimpeur', { wRatio: 0.20, aiState: AI_STATES.ATTACKING })
    // gradient retombé à 0 : shouldAttack serait faux, mais l'attaque se poursuit
    const mode = aiDecide(rider, { route: mkRoute({ gradient: 0 }) })
    expect(mode).toBe('attaque')
    expect(rider.aiState).toBe(AI_STATES.ATTACKING)
  })

  it('une attaque s\'arrête quand W\' tombe sous 15% → RECOVERING / Éco', () => {
    const rider = mkRider('grimpeur', { wRatio: 0.10, aiState: AI_STATES.ATTACKING })
    const mode = aiDecide(rider, { route: mkRoute({ gradient: 6 }) })
    expect(mode).toBe('eco')
    expect(rider.aiState).toBe(AI_STATES.RECOVERING)
  })
})

describe('aiDecide — récupération (RECOVERING)', () => {
  it('entrée en récupération si W\' < 15% en FOLLOWING', () => {
    const rider = mkRider('rouleur', { wRatio: 0.10, aiState: AI_STATES.FOLLOWING })
    const mode = aiDecide(rider, { route: mkRoute({ gradient: 0 }) })
    expect(mode).toBe('eco')
    expect(rider.aiState).toBe(AI_STATES.RECOVERING)
  })

  it('reste en récupération tant que W\' < 40% (hystérésis)', () => {
    const rider = mkRider('rouleur', { wRatio: 0.30, aiState: AI_STATES.RECOVERING })
    const mode = aiDecide(rider, { route: mkRoute({ gradient: 0 }) })
    expect(mode).toBe('eco')
    expect(rider.aiState).toBe(AI_STATES.RECOVERING)
  })

  it('sort de récupération une fois W\' ≥ 40%, reprend la stratégie de croisière', () => {
    const rider = mkRider('rouleur', { wRatio: 0.45, aiState: AI_STATES.RECOVERING })
    const mode = aiDecide(rider, { route: mkRoute({ gradient: 0 }) })
    expect(rider.aiState).toBe(AI_STATES.FOLLOWING)
    expect(mode).toBe('maintien') // rouleur sur le plat, W' 0.45 < 0.70 → pas d'attaque
  })
})

describe('aiDecide — sprint final outrepasse la récupération', () => {
  it('un sprinteur épuisé joue quand même son sprint dans les 500 derniers mètres', () => {
    const rider = mkRider('sprinteur', { wRatio: 0.05, aiState: AI_STATES.RECOVERING, splinePos: 11700 })
    const mode = aiDecide(rider, { route: mkRoute({ gradient: 0, totalLength: 12000 }) })
    expect(mode).toBe('attaque')
    expect(rider.aiState).toBe(AI_STATES.ATTACKING)
  })

  it('le même sprinteur, loin de la flamme rouge, reste en récupération', () => {
    const rider = mkRider('sprinteur', { wRatio: 0.05, aiState: AI_STATES.RECOVERING, splinePos: 5000 })
    const mode = aiDecide(rider, { route: mkRoute({ gradient: 0, totalLength: 12000 }) })
    expect(mode).toBe('eco')
    expect(rider.aiState).toBe(AI_STATES.RECOVERING)
  })
})

describe('aiDecide — explosion', () => {
  it('un coureur explosé reste en Éco, état EXPLODED, quel que soit le profil', () => {
    const rider = mkRider('grimpeur', { wRatio: 1, exploded: true, aiState: AI_STATES.ATTACKING })
    const mode = aiDecide(rider, { route: mkRoute({ gradient: 8 }) })
    expect(mode).toBe('eco')
    expect(rider.aiState).toBe(AI_STATES.EXPLODED)
  })
})

describe('aiDecide — coureur joueur', () => {
  it('un coureur sans aiProfile (joueur) n\'est pas affecté', () => {
    const player = createRider({ aiProfile: null, effortMode: 'attaque', aiState: undefined })
    const mode = aiDecide(player, { route: mkRoute({ gradient: 6 }) })
    expect(mode).toBe('attaque') // inchangé, c'est le choix du joueur
    expect(player.aiState).toBeUndefined() // jamais touché
  })
})

// ─── Intégration — cycle complet attaque/récupération ───────────────────────
describe('Intégration — cycle attaque/récupération sur plusieurs ticks', () => {
  it('un grimpeur plein de jambes en col attaque, puis récupère, sans rester bloqué', () => {
    const rider = mkRider('grimpeur', { wRatio: 1 })
    const route = mkRoute({ gradient: 6, totalLength: 1_000_000 }) // col interminable
    const states = []

    for (let i = 0; i < 400; i++) {
      rider.effortMode = aiDecide(rider, { route })
      states.push(rider.aiState)
      simulateTick(rider, route, 1)
    }

    expect(states).toContain(AI_STATES.ATTACKING)
    expect(states).toContain(AI_STATES.RECOVERING)
    // pas d'explosion sur ce laps de temps : le cycle attaque/récup est soutenable
    expect(rider.energy.exploded).toBe(false)
  })
})
