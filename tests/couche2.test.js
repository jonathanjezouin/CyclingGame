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

// ─── C2 — arbitrage par les vitesses : suivre une roue qui vaut l'abri ───────
describe('Couche 2 — suivre une roue quand l\'abri le vaut (plat)', () => {
  it('roue devant à portée sur le plat → le coureur RÉAGIT (cible ≠ pur solo)', () => {
    const route = flatRoute()
    const me = mkRider({ splinePos: 1000, endRatio: 1 }); me.id = 'me'; me.speedKmh = 38
    me.screenCount = 2
    const ahead = mkRider({ splinePos: 1040 }); ahead.id = 'ahead'; ahead.speedKmh = 40
    const solo = mkRider({ splinePos: 1000, endRatio: 1 }); solo.id = 'solo'; solo.speedKmh = 38
    const fracSolo = decidePowerTarget(solo, route, { simSec: 10 })
    const frac = decidePowerTarget(me, route, { simSec: 10, riders: [me, ahead] })
    // Une roue plus rapide devant + abri → il pousse pour revenir, au-dessus du solo.
    expect(frac).toBeGreaterThan(fracSolo)
    expect(me.aiLog[me.aiLog.length - 1].logKey).toMatch(/^c2:/)
  })

  it('roue trop loin (au-delà du plafond) → pas de C2, on reste au solo', () => {
    const route = flatRoute()
    const me = mkRider({ splinePos: 1000 }); me.id = 'me'; me.speedKmh = 38
    const ahead = mkRider({ splinePos: 1000 + 300 }); ahead.id = 'ahead'; ahead.speedKmh = 40
    const solo = mkRider({ splinePos: 1000 }); solo.id = 'solo'; solo.speedKmh = 38
    const fracSolo = decidePowerTarget(solo, route, { simSec: 10 })
    const frac = decidePowerTarget(me, route, { simSec: 10, riders: [me, ahead] })
    expect(frac).toBeCloseTo(fracSolo, 5)
  })
})

// ─── C2 — émergence montée : pas de cas spécial, l'abri fond via v² ─────────
describe('Couche 2 — comportement montée émergent (pas de règle si-pente)', () => {
  it('en montée raide, l\'abri ne paie quasi plus → cible proche du solo', () => {
    const route = climbRoute()
    const me = mkRider({ splinePos: 1000 }); me.id = 'me'; me.speedKmh = 14
    me.screenCount = 2
    const ahead = mkRider({ splinePos: 1010 }); ahead.id = 'ahead'; ahead.speedKmh = 14
    const solo = mkRider({ splinePos: 1000 }); solo.id = 'solo'; solo.speedKmh = 14
    const fracSolo = decidePowerTarget(solo, route, { simSec: 10 })
    const frac = decidePowerTarget(me, route, { simSec: 10, riders: [me, ahead] })
    // L'abri en col est négligeable : C2 ne tire pas le coureur loin de son instinct.
    expect(Math.abs(frac - fracSolo)).toBeLessThan(0.10)
  })

  it('grimpeur plus rapide que la roue en montée → il déborde (roule à son rythme)', () => {
    const route = climbRoute()
    // Grimpeur léger : son instinct C1 en montée est nettement > la roue lente devant.
    const me = mkRider({ splinePos: 1000, mass: 66 }); me.id = 'me'; me.speedKmh = 18
    me.profile.ftpWatts = 270
    const ahead = mkRider({ splinePos: 1006 }); ahead.id = 'ahead'; ahead.speedKmh = 14 // roue lente
    decidePowerTarget(me, route, { simSec: 10, riders: [me, ahead] })
    // Il ne se bride pas derrière la roue lente : état "déborde" ou "mon_rythme".
    expect(me.aiLog[me.aiLog.length - 1].logKey).toMatch(/c2:(deborde|mon_rythme)/)
  })
})

// ─── C2 — réaction à l'accélération de la roue (réactivité, fatigue) ────────
describe('Couche 2 — réaction à l\'accélération de la roue', () => {
  it('la roue accélère (gap s\'ouvre) → réaction marquée pour la suivre', () => {
    const route = flatRoute()
    const me = mkRider({ splinePos: 1000, endRatio: 1 }); me.id = 'me'; me.speedKmh = 38
    me.screenCount = 2
    // tick 1 : roue à 2 m, même vitesse (établit _prevGapAhead)
    let ahead = mkRider({ splinePos: 1002 }); ahead.id = 'ahead'; ahead.speedKmh = 38
    decidePowerTarget(me, route, { simSec: 10, riders: [me, ahead] })
    // tick 2 : la roue a accéléré → gap s'ouvre à 5 m, elle roule plus vite
    ahead = mkRider({ splinePos: 1005 }); ahead.id = 'ahead'; ahead.speedKmh = 42
    const frac = decidePowerTarget(me, route, { simSec: 11, riders: [me, ahead] })
    // Réaction : cible au-dessus de la simple croisière solo (~0.78).
    expect(frac).toBeGreaterThan(0.80)
    expect(me.aiLog[me.aiLog.length - 1].logKey).toBe('c2:roue')
  })

  it('W\' bas → réaction plus molle (réactivité atténuée par la fatigue)', () => {
    const route = flatRoute()
    const mk = (wRatio) => {
      const r = mkRider({ splinePos: 1000, endRatio: 1, wRatio }); r.id = 'r'; r.speedKmh = 38
      r.screenCount = 2
      return r
    }
    const fresh = mk(1.0)
    const tired = mk(0.10)
    let aF = mkRider({ splinePos: 1002 }); aF.id = 'aF'; aF.speedKmh = 38
    let aT = mkRider({ splinePos: 1002 }); aT.id = 'aT'; aT.speedKmh = 38
    decidePowerTarget(fresh, route, { simSec: 10, riders: [fresh, aF] })
    decidePowerTarget(tired, route, { simSec: 10, riders: [tired, aT] })
    // même accélération de la roue pour les deux
    aF = mkRider({ splinePos: 1006 }); aF.id = 'aF'; aF.speedKmh = 43
    aT = mkRider({ splinePos: 1006 }); aT.id = 'aT'; aT.speedKmh = 43
    const fFresh = decidePowerTarget(fresh, route, { simSec: 11, riders: [fresh, aF] })
    const fTired = decidePowerTarget(tired, route, { simSec: 11, riders: [tired, aT] })
    // Le frais réagit au moins aussi fort que le cramé (réactivité >= ).
    expect(fFresh).toBeGreaterThanOrEqual(fTired - 1e-9)
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

// ─── C2 — distance de suivi (anti faux-relais) + journal ────────────────────
describe('Couche 2 — tenue de roue & journal', () => {
  it('dans la roue à même vitesse → cible raisonnable, état c2:roue', () => {
    const route = flatRoute()
    const me = mkRider({ splinePos: 1000 }); me.id = 'me'; me.speedKmh = 40
    me.screenCount = 2
    const ahead = mkRider({ splinePos: 1002 }); ahead.id = 'ahead'; ahead.speedKmh = 40
    decidePowerTarget(me, route, { simSec: 10, riders: [me, ahead] })
    expect(me.aiLog[me.aiLog.length - 1].logKey).toBe('c2:roue')
  })

  it('journalise une transition d\'état (revenir → dans la roue)', () => {
    const route = flatRoute()
    const me = mkRider({ splinePos: 1000 }); me.id = 'me'; me.speedKmh = 38
    me.screenCount = 2; me.aiLog = []
    let ahead = mkRider({ splinePos: 1040 }); ahead.id = 'ahead'; ahead.speedKmh = 40 // loin
    decidePowerTarget(me, route, { simSec: 10, riders: [me, ahead] })
    const keysFar = me.aiLog.map(e => e.logKey).join(' ')
    ahead = mkRider({ splinePos: 1003 }); ahead.id = 'ahead'; ahead.speedKmh = 40     // dans la roue
    decidePowerTarget(me, route, { simSec: 12, riders: [me, ahead] })
    const last = me.aiLog[me.aiLog.length - 1].logKey
    expect(keysFar).toMatch(/c2:(reviens|mon_rythme)/)
    expect(last).toBe('c2:roue')
  })
})
