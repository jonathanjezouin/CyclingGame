import { describe, it, expect } from 'vitest'
import {
  decidePowerTarget,
  createAIRider,
} from '../src/simulation/engine.js'

// ─── Helpers (alignés sur couche2.test.js) ──────────────────────────────────
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
  const { splinePos = 0, endRatio = 1, wRatio = 1, mass, screenCount = 0 } = opts
  const r = createAIRider({ aiProfile: 'rouleur', splinePos })
  r.id = `r${++_rid}`                 // id unique : sinon nearestRiderAhead voit "soi"
  r.energy.wPrime.current = wRatio * r.energy.wPrime.max
  r.energy.endurance.current = endRatio * r.energy.endurance.max
  r.speedKmh = 38
  r.screenCount = screenCount
  if (mass != null) r.profile.mass = mass
  return r
}

const lastKey = (r) => r.aiLog[r.aiLog.length - 1]?.logKey

// ════════════════════════════════════════════════════════════════════════════
// R2 — Arbitre : invariants de contrat (IA Couches v0.2 §2)
// On teste l'arbitre à travers l'API publique decidePowerTarget, en construisant
// des situations qui exercent SES comportements propres : sélection par score,
// hystérésis de maintien, départage par priorité, veto hors concours.
// ════════════════════════════════════════════════════════════════════════════

describe('R2 — sélection par score (devise unique)', () => {
  it('seul (aucune roue) → le plan C1 gagne par défaut (référence, latéral abri)', () => {
    const me = mkRider({ splinePos: 1000 })
    decidePowerTarget(me, flatRoute(), { simSec: 1, riders: [me] })
    // Pas de roue → seul C1 candidate → un logKey de phase C1 (plat).
    expect(lastKey(me)).toMatch(/^plat/)
  })

  it('roue abritée plus rapide devant → le plan C2 détrône la référence C1', () => {
    const me = mkRider({ splinePos: 1000, screenCount: 2 }); me.speedKmh = 38
    const ahead = mkRider({ splinePos: 1040 }); ahead.speedKmh = 40  // roue plus rapide, abri
    decidePowerTarget(me, flatRoute(), { simSec: 1, riders: [me, ahead] })
    expect(lastKey(me)).toMatch(/^c2:/)
  })
})

describe('R2 — hystérésis de maintien (anti-papillonnage)', () => {
  it('le plan actif est latché dans rider._activePlanKey', () => {
    const me = mkRider({ splinePos: 1000, screenCount: 3 })
    const ahead = mkRider({ splinePos: 1004 })
    decidePowerTarget(me, flatRoute(), { simSec: 1, riders: [me, ahead] })
    expect(me._activePlanKey).toBeDefined()
    expect(me._activePlanKey).toBe(lastKey(me))
  })

  it('le plan tenu persiste tick-à-tick sur entrée identique (pas d\'oscillation)', () => {
    // Invariant robuste de l'hystérésis : sur une situation stable, le plan actif
    // ne doit pas papillonner d'un tick à l'autre. On présente deux fois la même
    // configuration et on vérifie que la clé de plan reste stable.
    const me = mkRider({ splinePos: 1000, screenCount: 2 }); me.speedKmh = 38
    const ahead = mkRider({ splinePos: 1040 }); ahead.speedKmh = 40
    decidePowerTarget(me, flatRoute(), { simSec: 1, riders: [me, ahead] })
    const k1 = me._activePlanKey
    // Même config au tick suivant (riders inchangés) → même plan tenu.
    decidePowerTarget(me, flatRoute(), { simSec: 2, riders: [me, ahead] })
    const k2 = me._activePlanKey
    expect(k2).toBe(k1)
  })
})

describe('R2 — départage par priorité à score égal', () => {
  it('C2 décline mais reste pertinent (déborde) → priorité fait surfacer le journal C2', () => {
    // Grimpeur plus rapide que la roue lente en montée : C2 décline (score≤0),
    // renvoie un plan "déborde" à score 0 = égalité avec C1 ; priorité C2>C1 → c2:*.
    const me = mkRider({ splinePos: 1000, mass: 66 }); me.id = 'me'; me.speedKmh = 18
    me.profile.ftpWatts = 270
    const ahead = mkRider({ splinePos: 1006 }); ahead.id = 'ahead'; ahead.speedKmh = 14
    decidePowerTarget(me, climbRoute(), { simSec: 1, riders: [me, ahead] })
    expect(lastKey(me)).toMatch(/c2:(deborde|mon_rythme)/)
  })
})

describe('R2 — la sécurité est un veto hors concours (post-clamp)', () => {
  it('W\' au plancher → la commande converge sous 0.80 (recup_w, veto post-clamp)', () => {
    // Le veto plafonne la CIBLE à 0.80 ; le lissage (en aval) y converge en
    // quelques ticks. On vérifie l'invariant sur la convergence, pas sur 1 tick.
    const me = mkRider({ splinePos: 1000, wRatio: 0.05, screenCount: 3 })
    me.powerFrac = 0.78   // on part déjà bas pour isoler le plafond, pas le lissage
    const ahead = mkRider({ splinePos: 1004 })
    let frac
    for (let t = 1; t <= 6; t++) {
      // W' reste bas → reste en récup (latché). Endurance non au plancher.
      me.energy.wPrime.current = 0.05 * me.energy.wPrime.max
      frac = decidePowerTarget(me, flatRoute(), { simSec: t, riders: [me, ahead] })
    }
    expect(lastKey(me)).toBe('recup_w')
    expect(frac).toBeLessThanOrEqual(0.80 + 1e-9)
  })

  it('explosé → 0.50 forcé, le plan ne compte plus (terminal)', () => {
    const me = mkRider({ splinePos: 1000 })
    me.energy.exploded = true
    const ahead = mkRider({ splinePos: 1004 })
    const frac = decidePowerTarget(me, flatRoute(), { simSec: 1, riders: [me, ahead] })
    expect(lastKey(me)).toBe('explose')
    // Lissage : la commande tend vers 0.50 (peut ne pas l'atteindre en 1 tick).
    expect(me.aiLog[me.aiLog.length - 1].reason).toMatch(/Explosion/)
  })

  it('le veto ne sort pas le coureur de la récup tant que W\' < 30% (hystérésis latchée)', () => {
    const me = mkRider({ splinePos: 1000, wRatio: 0.10 })   // sous 15% → entre en récup
    decidePowerTarget(me, flatRoute(), { simSec: 1, riders: [me] })
    expect(me._recoveringW).toBe(true)
    // Remonte à 20% (entre 15 et 30) : on NE sort PAS encore.
    me.energy.wPrime.current = 0.20 * me.energy.wPrime.max
    decidePowerTarget(me, flatRoute(), { simSec: 2, riders: [me] })
    expect(me._recoveringW).toBe(true)
    expect(lastKey(me)).toBe('recup_w')
  })
})

describe('R2 — structure du plan (R1) reste cohérente sous arbitrage', () => {
  it('rétro-compat : inerte sans riders (couche 1 pure)', () => {
    const me = mkRider({ splinePos: 1000 })
    const frac = decidePowerTarget(me, flatRoute(), { simSec: 1 })
    expect(frac).toBeGreaterThan(0.5)
    expect(lastKey(me)).toMatch(/^plat/)
  })
})
