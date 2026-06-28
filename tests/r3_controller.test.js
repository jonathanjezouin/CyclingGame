import { describe, it, expect } from 'vitest'
import {
  decidePowerTarget,
  createAIRider,
} from '../src/simulation/engine.js'

const flatRoute = (totalLength = 50000) => ({
  getGradientAt: () => 0,
  totalLength,
  segments: [{ from: 0, to: totalLength, type: 'flat' }],
})
const climbRoute = (totalLength = 50000) => ({
  getGradientAt: () => 6,
  totalLength,
  segments: [{ from: 0, to: totalLength, type: 'climb' }],
})

let _rid = 0
function mkRider(opts = {}) {
  const { splinePos = 0, endRatio = 1, wRatio = 1, mass, screenCount = 0, speedKmh = 38 } = opts
  const r = createAIRider({ aiProfile: 'rouleur', splinePos })
  r.id = `r${++_rid}`
  r.energy.wPrime.current = wRatio * r.energy.wPrime.max
  r.energy.endurance.current = endRatio * r.energy.endurance.max
  r.speedKmh = speedKmh
  r.screenCount = screenCount
  if (mass != null) r.profile.mass = mass
  return r
}
const lastKey = (r) => r.aiLog[r.aiLog.length - 1]?.logKey

// ════════════════════════════════════════════════════════════════════════════
// R3 — Contrôleur longitudinal : cible de position → watts
// Après R3, AUCUNE couche ne calcule de watts de commande : c'est le contrôleur,
// et lui seul, qui traduit la cible (libre ou position-de-roue) en frac. La dette
// reactKmh/corrKmh a quitté _planC2 pour devenir de la régulation de distance ici.
// ════════════════════════════════════════════════════════════════════════════

describe('R3 — le contrôleur produit l\'effort à partir d\'une cible de roue', () => {
  it('roue plus rapide devant + abri → le contrôleur pousse au-dessus du solo', () => {
    const route = flatRoute()
    const me = mkRider({ splinePos: 1000, screenCount: 2 })
    const ahead = mkRider({ splinePos: 1040, speedKmh: 40 })
    const solo = mkRider({ splinePos: 1000 })
    const fracSolo = decidePowerTarget(solo, route, { simSec: 10 })
    const frac = decidePowerTarget(me, route, { simSec: 10, riders: [me, ahead] })
    expect(lastKey(me)).toBe('c2:roue')
    expect(frac).toBeGreaterThan(fracSolo)     // l'effort est une CONSÉQUENCE de la cible
  })

  it('régulation de distance : trop loin de la roue → vise plus de vitesse que la roue', () => {
    // distErr > 0 (gap 8 m > gapCible 2 m) → corrKmh > 0 → cible > vitesse roue.
    // On le constate par une frac strictement au-dessus de ce qu'exigerait juste
    // la vitesse de la roue (la frac n'est pas une simple recopie).
    const route = flatRoute()
    const me = mkRider({ splinePos: 1000, screenCount: 3 })
    const ahead = mkRider({ splinePos: 1008, speedKmh: 38 })   // 8 m devant, même vitesse
    const frac = decidePowerTarget(me, route, { simSec: 1, riders: [me, ahead] })
    expect(lastKey(me)).toBe('c2:roue')
    expect(frac).toBeGreaterThan(0.50)
  })

  it('réaction à l\'accélération : la roue ouvre le gap → effort accru au tick suivant', () => {
    const route = flatRoute()
    const me = mkRider({ splinePos: 1000, screenCount: 3 })
    let ahead = mkRider({ splinePos: 1004, speedKmh: 38 })
    decidePowerTarget(me, route, { simSec: 1, riders: [me, ahead] })   // amorce _prevGapAhead
    const f1 = me.powerFrac
    // La roue accélère : au tick suivant le gap s'est creusé → dGap>0 → reactKmh>0.
    ahead.splinePos = 1010                                  // gap passe de 4 à 10 m
    ahead.speedKmh = 42
    const f2 = decidePowerTarget(me, route, { simSec: 2, riders: [me, ahead] })
    expect(lastKey(me)).toBe('c2:roue')
    expect(f2).toBeGreaterThan(f1)
  })

  it('roue disparue (followId absent du peloton) → repli propre sur l\'instinct', () => {
    const route = flatRoute()
    const me = mkRider({ splinePos: 1000, screenCount: 2 })
    const ahead = mkRider({ splinePos: 1040, speedKmh: 40 })
    decidePowerTarget(me, route, { simSec: 1, riders: [me, ahead] })   // plan c2:roue posé
    // Tick suivant : la roue n'est plus dans le peloton. Le contrôleur ne doit pas
    // planter et doit retomber sur une frac d'instinct valide.
    const frac = decidePowerTarget(me, route, { simSec: 2, riders: [me] })
    expect(frac).toBeGreaterThan(0.50)
    expect(me._prevGapAhead).toBeUndefined()    // mémoire de gap nettoyée
  })
})

describe('R3 — devise pure corrigée : l\'émergence montagne est préservée', () => {
  it('grimpeur fort derrière une roue lente en côte → déborde (abri effondré)', () => {
    // draftFrac→0 en col (v²) → draftSaving≈0 ; rouler à la roue lente = renoncer
    // à mon rythme → mismatchCost>0 → score<0 → je ne suis pas. AUCUNE règle si-pente.
    const me = mkRider({ splinePos: 1000, mass: 66, speedKmh: 18 }); me.profile.ftpWatts = 270
    const ahead = mkRider({ splinePos: 1006, speedKmh: 14 })
    decidePowerTarget(me, climbRoute(), { simSec: 1, riders: [me, ahead] })
    expect(lastKey(me)).toMatch(/c2:(deborde|mon_rythme)/)
  })

  it('roue rapide abritée sur le plat → suivre vaut le coup (score>0)', () => {
    const me = mkRider({ splinePos: 1000, screenCount: 3 })
    const ahead = mkRider({ splinePos: 1040, speedKmh: 40 })
    decidePowerTarget(me, flatRoute(), { simSec: 1, riders: [me, ahead] })
    expect(lastKey(me)).toBe('c2:roue')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// R4 — Cible latérale à deux modes (structure ; actionneur D1 différé)
// Le plan porte toujours un couple long+lat. 'roue' = coordonnée précise (wheelId) ;
// 'abri' = contrainte de résultat (pas de coordonnée). Latéral figé tant qu'il n'y
// a pas d'actionneur — on vérifie ici la STRUCTURE, pas le mouvement.
// ════════════════════════════════════════════════════════════════════════════

describe('R4 — modes latéraux portés par le plan actif', () => {
  // On inspecte le mode latéral indirectement via le logKey du plan retenu :
  //  - un plan de suivi (c2:roue) implique lat.mode='roue' (cible coordonnée).
  //  - un plan d'instinct / déborde implique lat.mode='abri' (contrainte de résultat).
  it('plan de suivi → mode roue (le coureur vise une coordonnée = wheelId)', () => {
    const me = mkRider({ splinePos: 1000, screenCount: 3 })
    const ahead = mkRider({ splinePos: 1004, speedKmh: 40 })
    decidePowerTarget(me, flatRoute(), { simSec: 1, riders: [me, ahead] })
    expect(lastKey(me)).toBe('c2:roue')          // mode 'roue' (coordonnée wheelId)
  })

  it('coureur seul → mode abri (contrainte de résultat, pas de coordonnée)', () => {
    const me = mkRider({ splinePos: 1000 })
    decidePowerTarget(me, flatRoute(), { simSec: 1, riders: [me] })
    expect(lastKey(me)).toMatch(/^plat/)         // plan C1, latéral 'abri' par défaut
  })

  it('latéral figé : décider ne déplace pas lateralOffset (actionneur D1 non livré)', () => {
    const me = mkRider({ splinePos: 1000, screenCount: 3 })
    const before = me.lateralOffset
    const ahead = mkRider({ splinePos: 1004, speedKmh: 40 })
    decidePowerTarget(me, flatRoute(), { simSec: 1, riders: [me, ahead] })
    expect(me.lateralOffset).toBe(before)        // aucune loi de mouvement latéral encore
  })
})
