import { describe, it, expect } from 'vitest'
import {
  nearestRiderAhead,
  decidePowerTarget,
  createAIRider,
} from '../src/simulation/engine.js'

// ─── Helpers ─────────────────────────────────────────────────────────────────
// Route plate par défaut (l'abri y paie au maximum). On peut injecter des
// segments pour faire varier upcomingFlats / upcomingAscents.
const mkRoute = ({ gradient = 0, totalLength = 50000, segments = [] } = {}) => ({
  getGradientAt: () => gradient,
  totalLength,
  segments,
})

// Route entièrement plate avec un long segment "flat" couvrant l'horizon.
const flatRoute = (totalLength = 50000) => ({
  getGradientAt: () => 0,
  totalLength,
  segments: [{ from: 0, to: totalLength, type: 'flat' }],
})

// Route en montée continue (segment "climb" sur tout l'horizon).
const climbRoute = (totalLength = 50000) => ({
  getGradientAt: () => 6,
  totalLength,
  segments: [{ from: 0, to: totalLength, type: 'climb' }],
})

function mkRider(opts = {}) {
  const { splinePos = 0, endRatio = 1, wRatio = 1, mass } = opts
  const r = createAIRider({ aiProfile: 'rouleur', splinePos })
  r.energy.wPrime.current = wRatio * r.energy.wPrime.max
  r.energy.endurance.current = endRatio * r.energy.endurance.max
  r.speedKmh = 38
  if (mass != null) r.profile.mass = mass
  return r
}

// ─── nearestRiderAhead — primitive longitudinale ────────────────────────────
describe('nearestRiderAhead — coureur le plus proche devant (longitudinal)', () => {
  it('retourne null si personne devant (tête de course)', () => {
    const me = mkRider({ splinePos: 1000 })
    const back = mkRider({ splinePos: 500 })
    back.id = 'r_back'
    expect(nearestRiderAhead(me, [me, back])).toBeNull()
  })

  it('trouve la roue la plus proche devant, ignore celles derrière', () => {
    const me = mkRider({ splinePos: 1000 }); me.id = 'me'
    const near = mkRider({ splinePos: 1030 }); near.id = 'near'
    const far  = mkRider({ splinePos: 1200 }); far.id = 'far'
    const back = mkRider({ splinePos: 800 });  back.id = 'back'
    const res = nearestRiderAhead(me, [me, far, back, near])
    expect(res.rider.id).toBe('near')
    expect(res.gap).toBeCloseTo(30, 5)
  })

  it('ignore le latéral et le groupe : seul splinePos compte', () => {
    const me = mkRider({ splinePos: 0 }); me.id = 'me'
    me.group = 'A'
    const other = mkRider({ splinePos: 90 }); other.id = 'other'
    other.group = 'B'              // groupe différent
    other.lateralOffset = 5        // décalé latéralement
    const res = nearestRiderAhead(me, [me, other])
    expect(res.rider.id).toBe('other')
    expect(res.gap).toBeCloseTo(90, 5)
  })
})

// ─── C2 — convertir l'abri en vitesse (revenir / tenir une roue) ────────────
describe('Couche 2 — pousse pour revenir sur une roue quand l\'abri le vaut', () => {
  it('sur le plat, une roue devant à portée → effort SUPÉRIEUR au solo', () => {
    const route = flatRoute()
    const me = mkRider({ splinePos: 1000, endRatio: 1 }); me.id = 'me'
    const ahead = mkRider({ splinePos: 1040 }); ahead.id = 'ahead' // 40 m devant
    // Cible solo de référence (sans personne autour).
    const solo = mkRider({ splinePos: 1000, endRatio: 1 }); solo.id = 'solo'
    const fracSolo = decidePowerTarget(solo, route, { simSec: 10 })
    // Avec la roue devant.
    const frac = decidePowerTarget(me, route, { simSec: 10, riders: [me, ahead] })
    expect(frac).toBeGreaterThan(fracSolo)
  })

  it('en montée, l\'abri ne paie pas → pas de surcoût C2', () => {
    const route = climbRoute()
    const me = mkRider({ splinePos: 1000 }); me.id = 'me'
    const ahead = mkRider({ splinePos: 1040 }); ahead.id = 'ahead'
    const solo = mkRider({ splinePos: 1000 }); solo.id = 'solo'
    const fracSolo = decidePowerTarget(solo, route, { simSec: 10 })
    const frac = decidePowerTarget(me, route, { simSec: 10, riders: [me, ahead] })
    expect(frac).toBeCloseTo(fracSolo, 5)
  })

  it('roue trop loin (au-delà du plafond de chasse) → pas d\'effort C2', () => {
    const route = flatRoute()
    const me = mkRider({ splinePos: 1000 }); me.id = 'me'
    const ahead = mkRider({ splinePos: 1000 + 300 }); ahead.id = 'ahead' // 300 m
    const solo = mkRider({ splinePos: 1000 }); solo.id = 'solo'
    const fracSolo = decidePowerTarget(solo, route, { simSec: 10 })
    const frac = decidePowerTarget(me, route, { simSec: 10, riders: [me, ahead] })
    expect(frac).toBeCloseTo(fracSolo, 5)
  })
})

// ─── C2 — convertir l'abri en épargne (se caler dans la roue) ───────────────
describe('Couche 2 — se cale dans la roue pour épargner quand du parcours reste', () => {
  it('juste derrière une roue, loin de l\'arrivée → effort INFÉRIEUR au solo', () => {
    const route = flatRoute()
    const me = mkRider({ splinePos: 1000 }); me.id = 'me'
    me.screenCount = 3            // abri effectif reçu → rouler moins cher à v égale
    const ahead = mkRider({ splinePos: 1004 }); ahead.id = 'ahead' // 4 m → calé
    const solo = mkRider({ splinePos: 1000 }); solo.id = 'solo'
    const fracSolo = decidePowerTarget(solo, route, { simSec: 10 })
    const frac = decidePowerTarget(me, route, { simSec: 10, riders: [me, ahead] })
    expect(frac).toBeLessThan(fracSolo)
  })

  it('plat final proche de l\'arrivée → on n\'épargne plus (C1 lâche les watts)', () => {
    // distanceToFinish < 6000 et plus d'ascension → finishingSoon : pas d'épargne.
    const route = flatRoute(50000)
    const me = mkRider({ splinePos: 45000 }); me.id = 'me'
    const ahead = mkRider({ splinePos: 45004 }); ahead.id = 'ahead'
    const solo = mkRider({ splinePos: 45000 }); solo.id = 'solo'
    const fracSolo = decidePowerTarget(solo, route, { simSec: 10 })
    const frac = decidePowerTarget(me, route, { simSec: 10, riders: [me, ahead] })
    expect(frac).toBeCloseTo(fracSolo, 5)
  })
})

// ─── C2 — jonction bon marché (recoller un petit trou, vite) ────────────────
describe('Couche 2 — jonction bon marché : recoller un petit trou', () => {
  it('petit trou (~13 m) à rythme modeste → grosse relance pour recoller', () => {
    const route = flatRoute()
    // Le lissage (POWER_SMOOTH_UP) étale la hausse sur ~5 s : on simule quelques
    // ticks de décision pour observer la cible de jonction se matérialiser.
    const me = mkRider({ splinePos: 1000, endRatio: 1 }); me.id = 'me'; me.speedKmh = 35
    const ahead = mkRider({ splinePos: 1013 }); ahead.id = 'ahead' // 13 m
    const solo = mkRider({ splinePos: 1000, endRatio: 1 }); solo.id = 'solo'; solo.speedKmh = 35
    let fSolo = 0, fMe = 0
    for (let t = 0; t < 8; t++) {
      fSolo = decidePowerTarget(solo, route, { simSec: 10 + t })
      fMe = decidePowerTarget(me, route, { simSec: 10 + t, riders: [me, ahead] })
    }
    // Après convergence, la jonction tire l'intensité nettement au-dessus du solo.
    expect(fMe).toBeGreaterThan(fSolo + 0.10)
  })

  it('jonction appliquée même si l\'abri prospectif est faible (terrain montagneux devant)', () => {
    // Horizon dominé par la montée → shelterVal sous le gate de valeur, mais la
    // jonction bon marché s'applique quand même (gradient courant plat).
    const route = {
      getGradientAt: (p) => (p < 1100 ? 0 : 6),   // plat ici, montée juste après
      totalLength: 50000,
      segments: [
        { from: 0, to: 1100, type: 'flat' },
        { from: 1100, to: 50000, type: 'climb' },
      ],
    }
    const me = mkRider({ splinePos: 1000 }); me.id = 'me'; me.speedKmh = 35
    const ahead = mkRider({ splinePos: 1015 }); ahead.id = 'ahead'
    const solo = mkRider({ splinePos: 1000 }); solo.id = 'solo'; solo.speedKmh = 35
    const fracSolo = decidePowerTarget(solo, route, { simSec: 10 })
    const frac = decidePowerTarget(me, route, { simSec: 10, riders: [me, ahead] })
    expect(frac).toBeGreaterThan(fracSolo)
  })

  it('jonction bornée par le budget : endurance basse → relance atténuée', () => {
    const route = flatRoute()
    const full = mkRider({ splinePos: 1000, endRatio: 1 }); full.id = 'full'; full.speedKmh = 35
    const low  = mkRider({ splinePos: 1000, endRatio: 0.18 }); low.id = 'low'; low.speedKmh = 35
    const aheadF = mkRider({ splinePos: 1013 }); aheadF.id = 'aF'
    const aheadL = mkRider({ splinePos: 1013 }); aheadL.id = 'aL'
    const overFull = decidePowerTarget(full, route, { simSec: 10, riders: [full, aheadF] })
    const overLow  = decidePowerTarget(low,  route, { simSec: 10, riders: [low, aheadL] })
    // À budget large, on pousse plus fort qu'à budget serré.
    expect(overFull).toBeGreaterThan(overLow)
  })

  it('grand trou (au-delà du seuil jonction) → pas de jonction bon marché', () => {
    // 80 m > C2_JOIN_GAP_M : seul le terme "valeur" peut jouer, pas la jonction.
    const route = flatRoute()
    const me = mkRider({ splinePos: 1000 }); me.id = 'me'; me.speedKmh = 35
    const ahead = mkRider({ splinePos: 1080 }); ahead.id = 'ahead'
    const frac = decidePowerTarget(me, route, { simSec: 10, riders: [me, ahead] })
    // Sur le plat, le terme valeur s'applique mais reste modéré (pas de +22%).
    // On vérifie surtout qu'on ne déclenche pas la grosse relance de jonction.
    const solo = mkRider({ splinePos: 1000 }); solo.id = 'solo'; solo.speedKmh = 35
    const fracSolo = decidePowerTarget(solo, route, { simSec: 10 })
    expect(frac - fracSolo).toBeLessThan(0.18)
  })
})

describe('Couche 2 — composition avec C1', () => {
  it('inerte sans riders dans le contexte (rétro-compat couche 1)', () => {
    const route = flatRoute()
    const a = mkRider({ splinePos: 1000 }); a.id = 'a'
    const b = mkRider({ splinePos: 1000 }); b.id = 'b'
    const fA = decidePowerTarget(a, route, { simSec: 10 })
    const fB = decidePowerTarget(b, route, { simSec: 10, riders: undefined })
    expect(fA).toBeCloseTo(fB, 5)
  })

  it('la sécurité W\' garde le dernier mot malgré une roue devant', () => {
    const route = flatRoute()
    // W' très bas → récupération latchée force ≤ 0.80 même avec une roue à suivre.
    const me = mkRider({ splinePos: 1000, wRatio: 0.05 }); me.id = 'me'
    me._recoveringW = true
    const ahead = mkRider({ splinePos: 1040 }); ahead.id = 'ahead'
    decidePowerTarget(me, route, { simSec: 10, riders: [me, ahead] })
    // powerFrac lissé vers une cible ≤ 0.80 — il ne doit pas grimper pour la roue.
    expect(me.powerFrac).toBeLessThanOrEqual(0.85)
  })

  it('coureur explosé : C2 ne s\'applique pas', () => {
    const route = flatRoute()
    const me = mkRider({ splinePos: 1000 }); me.id = 'me'
    me.energy.exploded = true
    const ahead = mkRider({ splinePos: 1040 }); ahead.id = 'ahead'
    decidePowerTarget(me, route, { simSec: 10, riders: [me, ahead] })
    // Cible forcée à 0.50 (lissée) — pas de relance pour la roue.
    expect(me.powerFrac).toBeLessThan(0.80)
  })
})

// ─── C2 — calage sans dépassement + journal des décisions ───────────────────
describe('Couche 2 — calage derrière la roue (pas de faux relais)', () => {
  it('calé derrière → ne vise jamais au-dessus du solo (anti-dépassement)', () => {
    const route = flatRoute()
    const me = mkRider({ splinePos: 1000 }); me.id = 'me'
    me.screenCount = 2
    const ahead = mkRider({ splinePos: 1003 }); ahead.id = 'ahead' // collé
    const solo = mkRider({ splinePos: 1000 }); solo.id = 'solo'
    const fracSolo = decidePowerTarget(solo, route, { simSec: 10 })
    const frac = decidePowerTarget(me, route, { simSec: 10, riders: [me, ahead] })
    expect(frac).toBeLessThanOrEqual(fracSolo + 1e-9)
  })

  it('journalise une transition d\'état C2 (chasse → calage)', () => {
    const route = flatRoute()
    const me = mkRider({ splinePos: 1000 }); me.id = 'me'; me.speedKmh = 35
    me.aiLog = []
    let ahead = mkRider({ splinePos: 1030 }); ahead.id = 'ahead'   // 30 m → chasse
    decidePowerTarget(me, route, { simSec: 10, riders: [me, ahead] })
    const phasesChase = me.aiLog.map(e => e.phase).join(' ')
    me.screenCount = 3
    ahead = mkRider({ splinePos: 1004 }); ahead.id = 'ahead'       // 4 m → calage
    decidePowerTarget(me, route, { simSec: 12, riders: [me, ahead] })
    const lastPhase = me.aiLog[me.aiLog.length - 1].phase
    expect(phasesChase).toMatch(/c2:(chasse|jonction)/)
    expect(lastPhase).toMatch(/c2:(cale|epargne)/)
  })
})
