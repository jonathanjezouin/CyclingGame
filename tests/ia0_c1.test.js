import { describe, it, expect } from 'vitest'
import {
  upcomingClimbs,
  upcomingFlats,
  gapToGroupAhead,
  getNextDecisiveMoment,
  actionToZone,
  computeEnduranceDrain,
  computeWPrimeDrain,
  projectCost,
  createRider,
  createAIRider,
  EFFORT_MODES,
} from '../src/simulation/engine.js'

// ─── Fixture route ───────────────────────────────────────────────────────────
// Reprend la structure de src/data/track_poc.json (segments/keyPoints déjà
// en mètres = splinePos, comme exposés par routeAdapter dans App.vue).
const mkRoute = (overrides = {}) => ({
  totalLength: 12000,
  getGradientAt: () => 0,
  segments: [
    { from: 0,    to: 2000,  type: 'flat',     road_width_m: 8 },
    { from: 2000, to: 5000,  type: 'climb',    road_width_m: 6 },
    { from: 5000, to: 7000,  type: 'descent',  road_width_m: 7 },
    { from: 7000, to: 9000,  type: 'flat',     road_width_m: 8 },
    { from: 9000, to: 12000, type: 'hc_climb', road_width_m: 5 },
  ],
  keyPoints: [
    { km: 4.6, type: 'summit', name: 'Col du Breuil', splinePos: 4600 },
    { km: 9.0, type: 'sprint', name: 'Sprint',         splinePos: 9000 },
    { km: 12.0, type: 'finish', name: 'Arrivée',       splinePos: 12000 },
  ],
  ...overrides,
})

// ═══════════════════════════════════════════════════════════════════════════
// IA0 — Dérivation route (PBI v1.1 §0)
// ═══════════════════════════════════════════════════════════════════════════

describe('upcomingClimbs', () => {
  const route = mkRoute()

  it('depuis le départ : renvoie climb puis hc_climb, avec distanceM jusqu\'au début', () => {
    const climbs = upcomingClimbs(route, 0)
    expect(climbs.map(c => c.type)).toEqual(['climb', 'hc_climb'])
    expect(climbs[0].distanceM).toBe(2000)
    expect(climbs[1].distanceM).toBe(9000)
  })

  it('depuis le milieu de la descente : seul le hc_climb restant', () => {
    const climbs = upcomingClimbs(route, 6000)
    expect(climbs).toHaveLength(1)
    expect(climbs[0].type).toBe('hc_climb')
    expect(climbs[0].distanceM).toBe(3000)
  })

  it('depuis l\'arrivée : aucune montée restante', () => {
    expect(upcomingClimbs(route, 12000)).toHaveLength(0)
  })

  it('route sans segments : tableau vide, pas d\'erreur', () => {
    expect(upcomingClimbs({}, 0)).toEqual([])
  })
})

describe('upcomingFlats', () => {
  const route = mkRoute()

  it('depuis le départ : le plat courant (distanceM=0) puis celui après le col', () => {
    const flats = upcomingFlats(route, 0)
    expect(flats).toHaveLength(2)
    expect(flats[0].distanceM).toBe(0)     // déjà sur le plat 0-2000
    expect(flats[1].distanceM).toBe(7000)  // plat 7000-9000
  })

  it('depuis le milieu de la montée : le plat 0-2000 n\'est plus "à venir"', () => {
    const flats = upcomingFlats(route, 3000)
    expect(flats).toHaveLength(1)
    expect(flats[0].from).toBe(7000)
    expect(flats[0].distanceM).toBe(4000)
  })
})

describe('gapToGroupAhead', () => {
  it('groupe de tête : aucun groupe devant → Infinity', () => {
    const groups = [
      { name: 'echappee', riders: [{ splinePos: 1000 }] },
      { name: 'peloton',  riders: [{ splinePos: 950 }, { splinePos: 940 }] },
    ]
    expect(gapToGroupAhead({ group: 'echappee' }, groups)).toBe(Infinity)
  })

  it('groupe poursuivant : écart = arrière du groupe devant - avant de son groupe', () => {
    const groups = [
      { name: 'echappee', riders: [{ splinePos: 1000 }] },
      { name: 'peloton',  riders: [{ splinePos: 950 }, { splinePos: 940 }] },
    ]
    expect(gapToGroupAhead({ group: 'peloton' }, groups)).toBe(50) // 1000 - 950
  })

  it('un seul groupe (peloton entier) : Infinity', () => {
    const groups = [{ name: 'peloton', riders: [{ splinePos: 100 }] }]
    expect(gapToGroupAhead({ group: 'peloton' }, groups)).toBe(Infinity)
  })

  it('groupe introuvable ou liste vide : Infinity, pas d\'erreur', () => {
    expect(gapToGroupAhead({ group: 'inconnu' }, [{ name: 'peloton', riders: [{ splinePos: 0 }] }])).toBe(Infinity)
    expect(gapToGroupAhead({ group: 'peloton' }, [])).toBe(Infinity)
  })
})

describe('getNextDecisiveMoment', () => {
  const route = mkRoute()

  it('grimpeur au départ : sommet de la prochaine montée (plus proche que l\'arrivée)', () => {
    const rider = createAIRider({ aiProfile: 'grimpeur', splinePos: 0 })
    const moment = getNextDecisiveMoment(rider, route)
    expect(moment.type).toBe('summit')
    expect(moment.splinePos).toBe(5000) // climb.to
    expect(moment.distanceM).toBe(5000)
  })

  it('rouleur déjà sur le plat : moment décisif immédiat (distanceM=0)', () => {
    const rider = createAIRider({ aiProfile: 'rouleur', splinePos: 0 })
    const moment = getNextDecisiveMoment(rider, route)
    expect(moment.type).toBe('flat')
    expect(moment.distanceM).toBe(0)
  })

  it('rouleur en montée : prochain plat (km 7-9)', () => {
    const rider = createAIRider({ aiProfile: 'rouleur', splinePos: 3000 })
    const moment = getNextDecisiveMoment(rider, route)
    expect(moment.type).toBe('flat')
    expect(moment.splinePos).toBe(7000)
    expect(moment.distanceM).toBe(4000)
  })

  it('sprinteur loin du sprint : point clé "sprint"', () => {
    const rider = createAIRider({ aiProfile: 'sprinteur', splinePos: 0 })
    const moment = getNextDecisiveMoment(rider, route)
    expect(moment.type).toBe('sprint')
    expect(moment.splinePos).toBe(9000)
  })

  it('sprinteur après le sprint : repli sur l\'arrivée', () => {
    const rider = createAIRider({ aiProfile: 'sprinteur', splinePos: 10000 })
    const moment = getNextDecisiveMoment(rider, route)
    expect(moment.type).toBe('finish')
    expect(moment.distanceM).toBe(2000)
  })

  it('joueur (aiProfile null) : toujours l\'arrivée', () => {
    const rider = createRider({ splinePos: 4000 })
    const moment = getNextDecisiveMoment(rider, route)
    expect(moment.type).toBe('finish')
    expect(moment.distanceM).toBe(8000)
  })

  it('à l\'arrivée : distanceM = 0 quel que soit le profil', () => {
    const rider = createAIRider({ aiProfile: 'grimpeur', splinePos: 12000 })
    expect(getNextDecisiveMoment(rider, route).distanceM).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// C1 — projectCost (TDD v0.7 §11.2)
// ═══════════════════════════════════════════════════════════════════════════

describe('actionToZone', () => {
  it('renvoie le ftpFactor du mode d\'effort correspondant', () => {
    expect(actionToZone('eco', 0)).toBe(EFFORT_MODES.eco.ftpFactor)
    expect(actionToZone('maintien', 0)).toBe(EFFORT_MODES.maintien.ftpFactor)
    expect(actionToZone('attaque', 0)).toBe(EFFORT_MODES.attaque.ftpFactor)
  })

  it('action inconnue : repli sur Maintien', () => {
    expect(actionToZone('inconnu', 0)).toBe(EFFORT_MODES.maintien.ftpFactor)
  })
})

describe('computeEnduranceDrain', () => {
  // ENDURANCE_AEROBIC_RATES = [0, 0.2, 0.5, 1.0] — index = zone (1, 2, 3).
  it('Z1 : 0.2 J gameplay/sec', () => {
    expect(computeEnduranceDrain(100, 1, 60)).toBeCloseTo(0.2 * 60, 6)
  })

  it('Z2 : 0.5 J gameplay/sec', () => {
    expect(computeEnduranceDrain(200, 2, 60)).toBeCloseTo(0.5 * 60, 6)
  })

  it('Z3 : 1.0 J gameplay/sec', () => {
    expect(computeEnduranceDrain(240, 3, 60)).toBeCloseTo(1.0 * 60, 6)
  })

  it('Z4-Z6 : taux constant de 2 J gameplay/sec', () => {
    expect(computeEnduranceDrain(300, 4, 60)).toBeCloseTo(2 * 60, 6)
    expect(computeEnduranceDrain(350, 5, 60)).toBeCloseTo(2 * 60, 6)
    expect(computeEnduranceDrain(400, 6, 60)).toBeCloseTo(2 * 60, 6)
  })
})

describe('computeWPrimeDrain', () => {
  it('Z1-Z3 : récupération passive (coût négatif)', () => {
    expect(computeWPrimeDrain(150, 2, 60)).toBeCloseTo(-50 * 60, 6)
  })

  it('Z4 : drain 80 J/sec', () => {
    expect(computeWPrimeDrain(300, 4, 60)).toBeCloseTo(80 * 60, 6)
  })

  it('Z5 : drain 200 J/sec', () => {
    expect(computeWPrimeDrain(350, 5, 60)).toBeCloseTo(200 * 60, 6)
  })

  it('Z6 : drain 500 J/sec', () => {
    expect(computeWPrimeDrain(400, 6, 60)).toBeCloseTo(500 * 60, 6)
  })
})

describe('projectCost', () => {
  const flatRoute = mkRoute({ getGradientAt: () => 0 })

  it('Maintien sur le plat : Z3, coût Endurance positif, W\' récupère', () => {
    const rider = createRider({ splinePos: 0, screenCount: 0, speedKmh: 0 })
    const result = projectCost('maintien', rider, flatRoute, 1000)

    expect(result.zone).toBe(3)
    expect(result.durationSec).toBeGreaterThan(0)
    expect(result.endurancePct).toBeGreaterThan(0)
    expect(result.wPrimePct).toBeLessThan(0) // "W' stable" / récupère

    // Cohérence interne avec les helpers
    const expectedEndurance = computeEnduranceDrain(0, 3, result.durationSec) / rider.energy.endurance.max
    expect(result.endurancePct).toBeCloseTo(expectedEndurance, 6)
  })

  it('Attaque sur le plat : Z5, coût W\' positif (entame la réserve)', () => {
    const rider = createRider({ splinePos: 0, screenCount: 0, speedKmh: 0 })
    const result = projectCost('attaque', rider, flatRoute, 1000)

    expect(result.zone).toBe(5)
    expect(result.wPrimePct).toBeGreaterThan(0)
  })

  it('distanceToNextKeyPoint = 0 : durée et coûts nuls', () => {
    const rider = createRider({ splinePos: 0, screenCount: 0, speedKmh: 0 })
    const result = projectCost('maintien', rider, flatRoute, 0)

    expect(result.durationSec).toBe(0)
    expect(result.endurancePct).toBe(0)
    expect(result.wPrimePct).toBeCloseTo(0, 12) // -0 (récupération nulle) ≈ 0
  })

  it('plus d\'écrans (draft) : effectivePower plus faible → coût W\' projeté réduit', () => {
    // vFactor=1 dans les deux cas (speedKmh >= 40) pour isoler l'effet du screenCount
    const noDraft = createRider({ splinePos: 0, screenCount: 0, speedKmh: 45 })
    const drafted = createRider({ splinePos: 0, screenCount: 7, speedKmh: 45 })

    const a = projectCost('attaque', noDraft, flatRoute, 1000)
    const b = projectCost('attaque', drafted, flatRoute, 1000)

    expect(b.wPrimePct).toBeLessThan(a.wPrimePct)
  })

  it('pente positive (route.getGradientAt) : la projection reflète le terrain courant', () => {
    const flat = createRider({ splinePos: 0, screenCount: 0, speedKmh: 0 })
    const climb = createRider({ splinePos: 0, screenCount: 0, speedKmh: 0 })

    const onFlat  = projectCost('maintien', flat,  mkRoute({ getGradientAt: () => 0 }), 1000)
    const onClimb = projectCost('maintien', climb, mkRoute({ getGradientAt: () => 8 }), 1000)

    // À puissance cible égale, on roule moins vite en montée → durée plus longue
    expect(onClimb.durationSec).toBeGreaterThan(onFlat.durationSec)
  })
})
