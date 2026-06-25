import { describe, it, expect } from 'vitest'
import {
  createAIRider,
  applyEnergy,
  wPrimeMaxFor,
} from '../src/simulation/engine.js'

// EN1 — couplage endurance → W' (PBI v1.4 §2)
// Décision actée : W' = unique variable de décision tactique ; l'endurance est
// un état de fond lent qui gouverne le W' par (a) recharge ralentie, (b) plafond
// rétréci, et devient terminale au plancher. Plus d'explosion par drain à 0.

const FTP = 250

function mkRider() {
  const r = createAIRider({ aiProfile: 'rouleur', splinePos: 0 })
  r.energy.ftpWatts = FTP
  return r
}

// Force un ratio d'endurance donné (sans toucher au max).
function setEnduranceRatio(r, ratio) {
  r.energy.endurance.current = ratio * r.energy.endurance.max
}

describe('EN1 (b) — plafond W\' mobile', () => {
  it('wPrimeMaxFor : endurance pleine → plafond nominal', () => {
    const r = mkRider()
    setEnduranceRatio(r, 1)
    expect(wPrimeMaxFor(r.energy, r.energy.wPrimeNominal))
      .toBeCloseTo(r.energy.wPrimeNominal, 5)
  })

  it('wPrimeMaxFor : endurance nulle → résidu non nul (EN3), pas 0', () => {
    const r = mkRider()
    setEnduranceRatio(r, 0)
    const max = wPrimeMaxFor(r.energy, r.energy.wPrimeNominal)
    expect(max).toBeGreaterThan(0)
    expect(max).toBeCloseTo(0.15 * r.energy.wPrimeNominal, 5)
  })

  it('wPrimeMaxFor : décroît de façon monotone avec l\'endurance', () => {
    const r = mkRider()
    const nom = r.energy.wPrimeNominal
    setEnduranceRatio(r, 1.0); const hi = wPrimeMaxFor(r.energy, nom)
    setEnduranceRatio(r, 0.5); const mid = wPrimeMaxFor(r.energy, nom)
    setEnduranceRatio(r, 0.1); const lo = wPrimeMaxFor(r.energy, nom)
    expect(hi).toBeGreaterThan(mid)
    expect(mid).toBeGreaterThan(lo)
  })

  it('applyEnergy : le plafond W\' courant suit la baisse d\'endurance', () => {
    const r = mkRider()
    const maxFull = r.energy.wPrime.max
    setEnduranceRatio(r, 0.4)
    applyEnergy(r, FTP * 0.6, 1)        // sous le seuil, pas d'explosion
    expect(r.energy.wPrime.max).toBeLessThan(maxFull)
  })

  it('applyEnergy : un plafond rétréci sous le current clampe le current', () => {
    const r = mkRider()
    r.energy.wPrime.current = r.energy.wPrime.max  // réservoir plein
    setEnduranceRatio(r, 0.2)                        // plafond va chuter
    applyEnergy(r, FTP * 0.6, 1)
    expect(r.energy.wPrime.current).toBeLessThanOrEqual(r.energy.wPrime.max + 1e-6)
  })
})

describe('EN1 (a) — recharge W\' ralentie par l\'endurance', () => {
  it('recharge plus faible à endurance basse qu\'à endurance pleine', () => {
    const mkAt = (ratio) => {
      const r = mkRider()
      setEnduranceRatio(r, ratio)
      // current bien sous le max courant pour laisser de la place à la recharge
      r.energy.wPrime.current = 0.3 * wPrimeMaxFor(r.energy, r.energy.wPrimeNominal)
      return r
    }
    const full = mkAt(1.0)
    const low = mkAt(0.2)
    const before = { full: full.energy.wPrime.current, low: low.energy.wPrime.current }
    applyEnergy(full, FTP * 0.5, 1)   // déficit identique des deux côtés
    applyEnergy(low, FTP * 0.5, 1)
    const gainFull = full.energy.wPrime.current - before.full
    const gainLow = low.energy.wPrime.current - before.low
    expect(gainFull).toBeGreaterThan(0)
    expect(gainLow).toBeGreaterThan(0)        // jamais nulle (floor)
    expect(gainLow).toBeLessThan(gainFull)    // mais plus lente
  })
})

describe('EN1 — explosion = plancher d\'endurance (terminal)', () => {
  it('PAS d\'explosion tant que l\'endurance est au-dessus du plancher (5%)', () => {
    const r = mkRider()
    setEnduranceRatio(r, 0.06)
    applyEnergy(r, FTP * 0.6, 1)
    expect(r.energy.exploded).toBe(false)
  })

  it('explosion quand l\'endurance passe SOUS le plancher', () => {
    const r = mkRider()
    setEnduranceRatio(r, 0.05)
    applyEnergy(r, FTP * 1.0, 1)   // draine encore un peu → sous 5%
    expect(r.energy.exploded).toBe(true)
  })

  it('endurance à 0 n\'est plus requise pour exploser (seuil, pas zéro pile)', () => {
    const r = mkRider()
    setEnduranceRatio(r, 0.04)
    applyEnergy(r, FTP * 0.6, 1)
    expect(r.energy.endurance.current).toBeGreaterThan(0)  // pas à zéro
    expect(r.energy.exploded).toBe(true)                    // et pourtant explosé
  })

  it('un coureur explosé ne consomme plus (retour précoce)', () => {
    const r = mkRider()
    r.energy.exploded = true
    const wBefore = r.energy.wPrime.current
    const eBefore = r.energy.endurance.current
    applyEnergy(r, FTP * 1.2, 1)
    expect(r.energy.wPrime.current).toBe(wBefore)
    expect(r.energy.endurance.current).toBe(eBefore)
  })
})

describe('EN1 — hiérarchie : intensité plus haute → étranglement plus précoce', () => {
  it('à endurance égale, pousser plus fort rétrécit le plafond W\' plus vite', () => {
    const hard = mkRider()
    const easy = mkRider()
    // 200 ticks : hard pousse au-dessus du seuil, easy en dessous
    for (let i = 0; i < 200; i++) {
      if (!hard.energy.exploded) applyEnergy(hard, FTP * 1.05, 1)
      if (!easy.energy.exploded) applyEnergy(easy, FTP * 0.70, 1)
    }
    expect(hard.energy.endurance.current).toBeLessThan(easy.energy.endurance.current)
    expect(hard.energy.wPrime.max).toBeLessThan(easy.energy.wPrime.max)
  })
})
