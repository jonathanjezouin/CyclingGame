import { describe, it, expect } from 'vitest'
import {
  draftReduction,
  computeScreenCount,
  updateGroups,
  createRidersFromRoster,
  computeSpeed,
  createRider,
} from '../src/simulation/engine.js'

// ─── draftReduction — courbe (refonte : sans facteur vitesse) ───────────────
describe('draftReduction — réduction de CdA (refonte, indépendante de la vitesse)', () => {
  it('0 écran → pas d\'abri', () => {
    expect(draftReduction(0, 40)).toBe(0)
    expect(draftReduction(0, 15)).toBe(0)
  })

  it('valeurs de base (table revue)', () => {
    expect(draftReduction(1)).toBeCloseTo(0.28, 5)
    expect(draftReduction(2)).toBeCloseTo(0.38, 5)
    expect(draftReduction(3)).toBeCloseTo(0.44, 5)
    expect(draftReduction(5)).toBeCloseTo(0.51, 5)
    expect(draftReduction(7)).toBeCloseTo(0.54, 5)
  })

  it('indépendant de la vitesse : même valeur à 40, 22 ou 15 km/h', () => {
    expect(draftReduction(2, 40)).toBeCloseTo(draftReduction(2, 22), 9)
    expect(draftReduction(2, 22)).toBeCloseTo(draftReduction(2, 15), 9)
  })

  it('plafonne à 7 écrans : 7, 8, 50 identiques', () => {
    const at7 = draftReduction(7)
    expect(draftReduction(8)).toBe(at7)
    expect(draftReduction(20)).toBe(at7)
    expect(draftReduction(50)).toBe(at7)
  })

  it('rendement marginal décroissant (la courbe est concave)', () => {
    const d = [0,1,2,3,4,5,6,7].map(n => draftReduction(n))
    const gains = []
    for (let i = 1; i < d.length; i++) gains.push(d[i] - d[i-1])
    for (let i = 1; i < gains.length; i++) {
      expect(gains[i]).toBeLessThanOrEqual(gains[i-1] + 1e-9)
    }
  })

  it('borne supérieure : ne dépasse jamais 0.54', () => {
    for (let n = 0; n < 30; n++) {
      expect(draftReduction(n)).toBeLessThanOrEqual(0.54 + 1e-9)
    }
  })

  it('effet montagne ÉMERGENT : à puissance égale, le gain de vitesse s\'effondre en côte', () => {
    // L'effondrement n'est plus dans draftReduction (constant) mais émerge de
    // la physique : en montée l'aéro est minoritaire, donc l'abri gagne peu.
    const df = 1 - draftReduction(7)
    const flatGain  = computeSpeed(250, 0, 0, df) - computeSpeed(250, 0, 0, 1)
    const climbGain = computeSpeed(250, 9, 0, df) - computeSpeed(250, 9, 0, 1)
    expect(climbGain).toBeLessThan(flatGain * 0.25)
  })
})

// ─── computeScreenCount — géométrie du cône ─────────────────────────────────
describe('computeScreenCount — cône frontal', () => {
  const mk = (id, splinePos, lateralOffset, group = 'peloton') =>
    ({ id, splinePos, lateralOffset, group })

  it('coureur seul → 0 écran', () => {
    const r = mk('a', 0, 0)
    expect(computeScreenCount(r, [r])).toBe(0)
  })

  it('un coureur juste devant et aligné → 1 écran', () => {
    const me   = mk('me', 0, 0)
    const lead = mk('lead', 5, 0)
    expect(computeScreenCount(me, [me, lead])).toBe(1)
  })

  it('coureur derrière ne compte pas', () => {
    const me   = mk('me', 10, 0)
    const back = mk('back', 5, 0)
    expect(computeScreenCount(me, [me, back])).toBe(0)
  })

  it('coureur côte à côte (même splinePos) ne compte pas', () => {
    const me   = mk('me', 5, 0.4)
    const side = mk('side', 5, -0.4)
    expect(computeScreenCount(me, [me, side])).toBe(0)
  })

  it('coureur devant mais hors portée (> 10m) ne compte pas', () => {
    const me   = mk('me', 0, 0)
    const far  = mk('far', 15, 0)
    expect(computeScreenCount(me, [me, far])).toBe(0)
  })

  it('coureur devant mais trop décalé latéralement (hors cône) ne compte pas', () => {
    // ahead 1m, latéral 2m → angle ~63° > 30°
    const me   = mk('me', 0, 0)
    const wide = mk('wide', 1, 2)
    expect(computeScreenCount(me, [me, wide])).toBe(0)
  })

  it('autre groupe ne compte pas', () => {
    const me   = mk('me', 0, 0, 'peloton')
    const esc  = mk('esc', 5, 0, 'echappee')
    expect(computeScreenCount(me, [me, esc])).toBe(0)
  })

  it('file indienne : le dernier voit plusieurs écrans', () => {
    const riders = [0, 2, 4, 6].map((p, i) => mk(`r${i}`, p, 0))
    const last = riders[0] // splinePos 0, 3 devant à 2/4/6m
    expect(computeScreenCount(last, riders)).toBe(3)
  })
})

// ─── updateGroups — étagement & segmentation ────────────────────────────────
describe('updateGroups — groupes et rangs', () => {
  const mk = (id, splinePos) => ({ id, splinePos, group: '', rankInGroup: 0 })

  it('peloton compact → un seul groupe, rangs séquentiels', () => {
    const riders = [mk('a', 30), mk('b', 20), mk('c', 10)]
    const groups = updateGroups(riders)
    expect(groups.length).toBe(1)
    expect(groups[0].name).toBe('peloton')
    expect(riders.find(r => r.id === 'a').rankInGroup).toBe(1) // tête
    expect(riders.find(r => r.id === 'c').rankInGroup).toBe(3) // queue
  })

  it('cassure : écart > seuil → deux groupes', () => {
    const riders = [mk('a', 100), mk('b', 95), mk('c', 40), mk('d', 35)]
    const groups = updateGroups(riders)
    expect(groups.length).toBe(2)
    expect(groups[0].riders.length).toBe(2)
    expect(groups[1].riders.length).toBe(2)
  })

  it('petit groupe de tête détaché → nommé échappée', () => {
    const riders = [mk('a', 200), mk('b', 195), mk('c', 50), mk('d', 45), mk('e', 40)]
    const groups = updateGroups(riders)
    expect(groups[0].name).toBe('echappee')
    expect(groups[groups.length - 1].name).toBe('retardataires')
  })

  it('rangs repartent à 1 dans chaque groupe', () => {
    const riders = [mk('a', 100), mk('b', 95), mk('c', 40), mk('d', 35)]
    updateGroups(riders)
    expect(riders.find(r => r.id === 'c').rankInGroup).toBe(1)
    expect(riders.find(r => r.id === 'd').rankInGroup).toBe(2)
  })

  it('liste vide → aucun groupe', () => {
    expect(updateGroups([])).toEqual([])
  })

  it('tête de course = rang 1 du premier groupe', () => {
    const riders = [mk('a', 10), mk('b', 50), mk('c', 30)]
    updateGroups(riders)
    expect(riders.find(r => r.id === 'b').rankInGroup).toBe(1)
  })
})

// ─── Intégration draft → vitesse ────────────────────────────────────────────
describe('draft → vitesse (computeSpeed)', () => {
  it('à puissance égale, l\'abri augmente la vitesse sur le plat', () => {
    const solo  = computeSpeed(250, 0, 0, 1)            // pas d'abri
    const draft = computeSpeed(250, 0, 0, 1 - draftReduction(7, 40)) // abri max
    expect(draft).toBeGreaterThan(solo)
  })

  it('en col, le bénéfice d\'abri est négligeable', () => {
    const solo  = computeSpeed(250, 8, 0, 1)
    const draft = computeSpeed(250, 8, 0, 1 - draftReduction(7, 13))
    // écart de vitesse minime en montée (< 0.5 km/h)
    expect(draft - solo).toBeLessThan(0.5)
  })
})

// ─── createRidersFromRoster ─────────────────────────────────────────────────
describe('createRidersFromRoster — chargement N coureurs', () => {
  const roster = {
    id: 'r', riders: [
      { id: 'p',  name: 'Joueur', isPlayer: true,  ftpWatts: 280, role: 'climber', aiProfile: null },
      { id: 'a1', name: 'IA 1',   isPlayer: false, ftpWatts: 300, role: 'rouleur', aiProfile: 'rouleur' },
      { id: 'a2', name: 'IA 2',   isPlayer: false, ftpWatts: 290, role: 'climber', aiProfile: 'grimpeur' },
    ],
  }

  it('instancie autant de coureurs que le roster', () => {
    expect(createRidersFromRoster(roster).length).toBe(3)
  })

  it('un seul joueur, FTP repris du roster', () => {
    const riders = createRidersFromRoster(roster)
    const players = riders.filter(r => r.isPlayer)
    expect(players.length).toBe(1)
    expect(players[0].energy.ftpWatts).toBe(280)
  })

  it('étagement longitudinal : splinePos distincts au départ', () => {
    const riders = createRidersFromRoster(roster, { startSpacingM: 3 })
    const positions = riders.map(r => r.splinePos)
    expect(new Set(positions).size).toBe(positions.length) // tous distincts
  })

  it('le premier du roster démarre devant', () => {
    const riders = createRidersFromRoster(roster, { startSpacingM: 3 })
    expect(riders[0].splinePos).toBeGreaterThan(riders[2].splinePos)
  })

  it('chaque coureur porte screenCount initialisé', () => {
    for (const r of createRidersFromRoster(roster)) {
      expect(r.screenCount).toBe(0)
    }
  })

  it('roster vide → liste vide', () => {
    expect(createRidersFromRoster({ riders: [] })).toEqual([])
    expect(createRidersFromRoster({})).toEqual([])
  })

  it('les coureurs étagés produisent des écrans dès le départ', () => {
    const riders = createRidersFromRoster(roster, { startSpacingM: 3 })
    updateGroups(riders)
    // le coureur de queue doit voir au moins un écran devant
    const tail = [...riders].sort((a,b) => a.splinePos - b.splinePos)[0]
    expect(computeScreenCount(tail, riders)).toBeGreaterThan(0)
  })
})
