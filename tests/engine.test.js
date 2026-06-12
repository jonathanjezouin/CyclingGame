import { describe, it, expect } from 'vitest'
import {
  computeSpeed,
  getZoneFromFtpRatio,
  applyEnergy,
  simulateTick,
  createRider,
  createAIRider,
  ZONES,
  EFFORT_MODES,
} from '../src/simulation/engine.js'

// ─── computeSpeed — table calibrée v0.4 ─────────────────────────────────────
// Référence TDD v0.4 §4bis.1. Tolérance large (±2 km/h) : on gèle l'ordre de
// grandeur calibré, pas une valeur au watt près. Si la physique dérive au-delà,
// le test casse et c'est volontaire.
describe('computeSpeed — physique calibrée', () => {
  const cases = [
    { label: 'plat 250W',          power: 250, gradient: 0,   expected: 37, tol: 3 },
    { label: 'faux-plat +2% 250W', power: 250, gradient: 2,   expected: 29, tol: 3 },
    { label: 'col +6% 250W',       power: 250, gradient: 6,   expected: 17, tol: 2 },
    { label: 'col HC +9% 250W',    power: 250, gradient: 9,   expected: 12, tol: 2 },
    { label: 'descente -5% 250W',  power: 250, gradient: -5,  expected: 50, tol: 5 },
  ]

  for (const c of cases) {
    it(`${c.label} ≈ ${c.expected} km/h`, () => {
      const v = computeSpeed(c.power, c.gradient)
      expect(v).toBeGreaterThan(c.expected - c.tol)
      expect(v).toBeLessThan(c.expected + c.tol)
    })
  }

  it('monotone : plus de puissance → plus de vitesse (plat)', () => {
    expect(computeSpeed(350, 0)).toBeGreaterThan(computeSpeed(250, 0))
  })

  it('monotone : plus de pente → moins de vitesse (à puissance égale)', () => {
    expect(computeSpeed(250, 8)).toBeLessThan(computeSpeed(250, 2))
  })

  it('puissance nulle → vitesse nulle ou quasi nulle en montée', () => {
    expect(computeSpeed(0, 5)).toBeLessThan(1)
  })

  it('ne retourne jamais NaN ni négatif', () => {
    for (const g of [-10, -5, 0, 3, 6, 12]) {
      const v = computeSpeed(280, g)
      expect(Number.isFinite(v)).toBe(true)
      expect(v).toBeGreaterThanOrEqual(0)
    }
  })
})

// ─── getZoneFromFtpRatio — dérivé de la table ZONES ─────────────────────────
// Bornes ftpMax inclusives : 0.55 / 0.75 / 0.90 / 1.05 / 1.20.
describe('getZoneFromFtpRatio — cohérent avec ZONES', () => {
  it('milieu de chaque zone', () => {
    expect(getZoneFromFtpRatio(0.40)).toBe(1)
    expect(getZoneFromFtpRatio(0.65)).toBe(2)
    expect(getZoneFromFtpRatio(0.83)).toBe(3)
    expect(getZoneFromFtpRatio(0.98)).toBe(4)
    expect(getZoneFromFtpRatio(1.13)).toBe(5)
    expect(getZoneFromFtpRatio(1.50)).toBe(6)
  })

  it('bornes inclusives sur ftpMax', () => {
    expect(getZoneFromFtpRatio(0.55)).toBe(1)  // borne haute Z1
    expect(getZoneFromFtpRatio(0.75)).toBe(2)  // borne haute Z2
    expect(getZoneFromFtpRatio(1.05)).toBe(4)  // borne haute Z4
    expect(getZoneFromFtpRatio(1.20)).toBe(5)  // borne haute Z5
  })

  it('ratio extrême → Z6', () => {
    expect(getZoneFromFtpRatio(99)).toBe(6)
  })

  it('chaque id de zone retournable est présent dans ZONES', () => {
    const ids = Object.values(ZONES).map(z => z.id)
    for (let r = 0.1; r < 2; r += 0.1) {
      expect(ids).toContain(getZoneFromFtpRatio(r))
    }
  })
})

// ─── applyEnergy — consommation et recharge ─────────────────────────────────
describe('applyEnergy — réservoirs', () => {
  it('Z2 consomme Endurance lentement, ne touche pas W\'', () => {
    const r = createRider()
    const w0 = r.energy.wPrime.current
    const e0 = r.energy.endurance.current
    applyEnergy(r, 0.65 * r.energy.ftpWatts, 1) // Z2
    expect(r.energy.endurance.current).toBeLessThan(e0)
    expect(r.energy.endurance.current).toBeGreaterThan(e0 - 1) // < 1 J/s
    expect(r.energy.wPrime.current).toBeGreaterThanOrEqual(w0) // recharge ou stable
  })

  it('Z5 vide W\' rapidement', () => {
    const r = createRider()
    const w0 = r.energy.wPrime.current
    applyEnergy(r, 1.13 * r.energy.ftpWatts, 1) // Z5 → 200 J/s
    expect(w0 - r.energy.wPrime.current).toBeGreaterThan(150)
  })

  it('recharge W\' passive en zone aérobie quand W\' entamé', () => {
    const r = createRider()
    r.energy.wPrime.current = 10000
    applyEnergy(r, 0.40 * r.energy.ftpWatts, 1) // Z1
    expect(r.energy.wPrime.current).toBeGreaterThan(10000)
  })

  it('explosion quand Endurance atteint 0', () => {
    const r = createRider()
    r.energy.endurance.current = 0.3
    applyEnergy(r, 0.85 * r.energy.ftpWatts, 1) // Z3, 1 J/s
    expect(r.energy.endurance.current).toBe(0)
    expect(r.energy.exploded).toBe(true)
  })

  it('rider explosé : applyEnergy est un no-op', () => {
    const r = createRider()
    r.energy.exploded = true
    const e0 = r.energy.endurance.current
    const w0 = r.energy.wPrime.current
    applyEnergy(r, 1.5 * r.energy.ftpWatts, 1)
    expect(r.energy.endurance.current).toBe(e0)
    expect(r.energy.wPrime.current).toBe(w0)
  })

  it('défaillance W\' : déclenche wFailTicks quand W\' atteint 0', () => {
    const r = createRider()
    r.energy.wPrime.current = 50
    applyEnergy(r, 1.5 * r.energy.ftpWatts, 1) // Z6 → vide W'
    expect(r.energy.wPrime.current).toBe(0)
    expect(r.energy.wFailTicks).toBeGreaterThan(0)
  })
})

// ─── simulateTick — intégration ─────────────────────────────────────────────
describe('simulateTick — avancement', () => {
  // Route factice : gradient constant, longueur large
  const flatRoute = { getGradientAt: () => 0, totalLength: 100000 }

  it('avance le coureur sur la spline', () => {
    const r = createRider()
    const p0 = r.splinePos
    simulateTick(r, flatRoute, 1)
    expect(r.splinePos).toBeGreaterThan(p0)
    expect(r.speedKmh).toBeGreaterThan(0)
  })

  it('distanceTravelled cohérente avec la vitesse', () => {
    const r = createRider()
    simulateTick(r, flatRoute, 1)
    const expectedM = r.speedKmh / 3.6
    expect(Math.abs(r.distanceTravelled - expectedM)).toBeLessThan(0.5)
  })

  it('ne dépasse jamais totalLength', () => {
    const shortRoute = { getGradientAt: () => 0, totalLength: 5 }
    const r = createRider()
    for (let i = 0; i < 10; i++) simulateTick(r, shortRoute, 1)
    expect(r.splinePos).toBeLessThanOrEqual(5)
  })

  it('mode attaque soutenu place en Z5 (pas Z6)', () => {
    const r = createRider({ effortMode: 'attaque' })
    simulateTick(r, flatRoute, 1)
    expect(r.energy.zone).toBe(5)
  })

  it('défaillance W\' bride la puissance → vitesse réduite', () => {
    const r = createRider({ effortMode: 'attaque' })
    r.energy.wFailTicks = 5
    simulateTick(r, flatRoute, 1)
    // En crampe, la zone retombe en aérobie (≤ Z3)
    expect(r.energy.zone).toBeLessThanOrEqual(3)
    expect(r.energy.wFailTicks).toBe(4)
  })

  it('rider explosé roule à puissance bridée', () => {
    const r = createRider()
    r.energy.exploded = true
    simulateTick(r, flatRoute, 1)
    expect(r.speedKmh).toBeGreaterThan(0)
    expect(r.speedKmh).toBeLessThan(computeSpeed(r.energy.ftpWatts, 0))
  })
})

// ─── Sanity sur les fabriques ───────────────────────────────────────────────
describe('createRider / createAIRider', () => {
  it('joueur et IA ont des FTP distincts', () => {
    expect(createRider().energy.ftpWatts).not.toBe(createAIRider().energy.ftpWatts)
  })

  it('overrides appliqués', () => {
    const r = createRider({ effortMode: 'eco', splinePos: 42 })
    expect(r.effortMode).toBe('eco')
    expect(r.splinePos).toBe(42)
  })

  it('tous les modes d\'effort sont valides', () => {
    for (const key of Object.keys(EFFORT_MODES)) {
      const r = createRider({ effortMode: key })
      const route = { getGradientAt: () => 0, totalLength: 1e6 }
      expect(() => simulateTick(r, route, 1)).not.toThrow()
    }
  })

  it('IA possède wFailTicks (parité avec le joueur)', () => {
    expect(createAIRider().energy.wFailTicks).toBe(0)
  })
})
