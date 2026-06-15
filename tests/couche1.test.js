import { describe, it, expect } from 'vitest'
import {
  decideTargetZone,
  decidePowerTarget,
  aiDecide,
  makeRiderProfile,
  AMATEUR_PROFILES,
  ZONE_FTP_TARGET,
  AI_LOG_MAX_ENTRIES,
  createAIRider,
  createRider,
  createRidersFromRoster,
  computeSpeed,
  simulateTick,
} from '../src/simulation/engine.js'

// ─── Helpers ─────────────────────────────────────────────────────────────────
// Route factice : gradient constant (sauf override), pas de segments.
const mkRoute = ({ gradient = 0, totalLength = 50000, segments = [] } = {}) => ({
  getGradientAt: () => gradient,
  totalLength,
  segments,
})

// Route à gradient variable selon splinePos (pour tester gradientAhead).
const mkRouteFn = (gradientFn, { totalLength = 50000, segments = [] } = {}) => ({
  getGradientAt: gradientFn,
  totalLength,
  segments,
})

function mkRider(aiProfile, { wRatio = 1, exploded = false, splinePos = 0, mass } = {}) {
  const r = createAIRider({ aiProfile, splinePos })
  r.energy.wPrime.current = wRatio * r.energy.wPrime.max
  r.energy.exploded = exploded
  if (mass != null) r.profile.mass = mass
  return r
}

// ─── Profils amateurs ────────────────────────────────────────────────────────
describe('Profils amateurs (makeRiderProfile)', () => {
  it('expose les quatre profils amateurs avec FTP abaissé (< pro)', () => {
    expect(Object.keys(AMATEUR_PROFILES).sort()).toEqual(['grimpeur', 'puncheur', 'rouleur', 'sprinteur'])
    for (const p of Object.values(AMATEUR_PROFILES)) {
      expect(p.ftp).toBeLessThan(290) // amateur, sous les valeurs pro (~320+)
      expect(p.ftp).toBeGreaterThan(220)
    }
  })

  it('le grimpeur a le meilleur W/kg, le sprinter le pire', () => {
    const wkg = (p) => p.ftp / p.mass
    expect(wkg(AMATEUR_PROFILES.grimpeur)).toBeGreaterThan(wkg(AMATEUR_PROFILES.sprinteur))
  })

  it('le sprinter a le plus gros plafond anaérobie et le plus gros W\'', () => {
    const s = AMATEUR_PROFILES.sprinteur
    for (const k of ['grimpeur', 'rouleur', 'puncheur']) {
      expect(s.maxAnaerobicPower).toBeGreaterThanOrEqual(AMATEUR_PROFILES[k].maxAnaerobicPower)
    }
  })

  it('jitter reproductible : même graine → mêmes valeurs', () => {
    const a = makeRiderProfile('grimpeur', 'rider_007')
    const b = makeRiderProfile('grimpeur', 'rider_007')
    expect(a).toEqual(b)
  })

  it('jitter individuel : graines différentes → valeurs (généralement) différentes', () => {
    const a = makeRiderProfile('grimpeur', 'rider_007')
    const b = makeRiderProfile('grimpeur', 'rider_010')
    // Au moins une caractéristique diffère
    const diff = a.ftpWatts !== b.ftpWatts || a.mass !== b.mass || a.wPrimeJ !== b.wPrimeJ
    expect(diff).toBe(true)
  })

  it('reste dans une fourchette raisonnable autour de la base (±~6%)', () => {
    const p = makeRiderProfile('rouleur', 'x')
    const base = AMATEUR_PROFILES.rouleur
    expect(p.ftpWatts).toBeGreaterThan(base.ftp * 0.9)
    expect(p.ftpWatts).toBeLessThan(base.ftp * 1.1)
  })
})

// ─── Schéma coureur Couche 1 ─────────────────────────────────────────────────
describe('Schéma coureur — champs Couche 1', () => {
  it('createRider expose profile, freshness, targetZone', () => {
    const r = createRider()
    expect(r.profile).toBeDefined()
    expect(r.profile.mass).toBeGreaterThan(0)
    expect(r.profile.enduranceFactor).toBeGreaterThan(0)
    expect(r.energy.freshness).toBe(1.0)
    expect(r.targetZone).toBe(3)
  })

  it('createRidersFromRoster : le joueur garde son FTP roster sans jitter', () => {
    const roster = { riders: [{ id: 'p', name: 'Joueur', isPlayer: true, ftpWatts: 280 }] }
    const [p] = createRidersFromRoster(roster)
    expect(p.energy.ftpWatts).toBe(280)
    expect(p.targetZone).toBe(3)
  })

  it('createRidersFromRoster : une IA reçoit un profil amateur (W\' = wPrimeJ)', () => {
    const roster = { riders: [{ id: 'a', name: 'IA', isPlayer: false, aiProfile: 'grimpeur' }] }
    const [a] = createRidersFromRoster(roster)
    expect(a.energy.wPrime.max).toBe(a.profile.wPrimeJ)
    expect(a.energy.ftpWatts).toBe(a.profile.ftpWatts)
  })
})

// ─── decideTargetZone — logique de zone (Couche 1 §9.1) ─────────────────────
describe('decideTargetZone — zone de base par terrain', () => {
  it('le joueur (aiProfile null) n\'est pas affecté : garde sa zone', () => {
    const p = createRider({ targetZone: 4 })
    const z = decideTargetZone(p, mkRoute({ gradient: 6 }), { simSec: 0 })
    expect(z).toBe(4)
    expect(p.aiLog).toEqual([])
  })

  it('plat, loin de l\'arrivée → intensité d\'endurance modérée', () => {
    const r = mkRider('rouleur', { splinePos: 0 })
    r.speedKmh = 35
    decidePowerTarget(r, mkRoute({ gradient: 0, totalLength: 50000 }), { simSec: 0 })
    expect(r.powerFrac).toBeLessThan(0.90)
    expect(r.powerFrac).toBeGreaterThan(0.40)
  })

  it('plat, en approche de l\'arrivée (< 2 km) → Z3', () => {
    const r = mkRider('rouleur', { splinePos: 49000 })
    const z = decideTargetZone(r, mkRoute({ gradient: 0, totalLength: 50000 }), { simSec: 0 })
    expect(z).toBe(3)
  })

  it('montée → intensité plus haute que sur le plat', () => {
    const flatR = mkRider('grimpeur'); flatR.speedKmh = 35
    const climbR = mkRider('grimpeur'); climbR.speedKmh = 16; climbR._zoneCommitSec = -100
    decidePowerTarget(flatR, mkRoute({ gradient: 0 }), { simSec: 0 })
    decidePowerTarget(climbR, mkRoute({ gradient: 6 }), { simSec: 1000 })
    expect(climbR.powerFrac).toBeGreaterThan(flatR.powerFrac)
  })

  it('descente → ne force pas, récupère (≤ Z2)', () => {
    const r = mkRider('rouleur')
    const z = decideTargetZone(r, mkRoute({ gradient: -5 }), { simSec: 0 })
    expect(z).toBeLessThanOrEqual(2)
  })
})

describe('decideTargetZone — plafond de zone selon la masse', () => {
  it('un gabarit lourd plafonne plus bas qu\'un léger sur la même bosse', () => {
    // On annule l'anti-girouette en autorisant la montée (réserve pleine + commit)
    const light = mkRider('grimpeur', { mass: 64 })
    const heavy = mkRider('sprinteur', { mass: 88 })
    light._zoneCommitSec = -100
    heavy._zoneCommitSec = -100
    const route = mkRoute({ gradient: 8 })
    const zLight = decideTargetZone(light, route, { simSec: 1000 })
    const zHeavy = decideTargetZone(heavy, route, { simSec: 1000 })
    expect(zHeavy).toBeLessThanOrEqual(zLight)
  })
})

describe('decideTargetZone — garde-fou prospectif (climbsAhead)', () => {
  it('plusieurs bosses restantes → cape la zone (pas tout sur la première)', () => {
    const segments = [
      { from: 0,     to: 5000,  type: 'climb' },
      { from: 10000, to: 15000, type: 'climb' },
      { from: 20000, to: 25000, type: 'hc_climb' },
    ]
    const r = mkRider('grimpeur', { mass: 64, splinePos: 0 })
    r._zoneCommitSec = -100
    const route = mkRouteFn(() => 8, { totalLength: 50000, segments })
    const z = decideTargetZone(r, route, { simSec: 1000 })
    // Le cap prospectif empêche d'atteindre Z5+ tant qu'il reste ≥ 2 bosses
    expect(z).toBeLessThanOrEqual(4)
  })
})

describe('decideTargetZone — bornage par wBalance (réserve)', () => {
  it('réserve W\' très basse → repasse sous le seuil pour recharger', () => {
    const r = mkRider('grimpeur', { wRatio: 0.10 })
    r._zoneCommitSec = -100; r.speedKmh = 14
    decidePowerTarget(r, mkRoute({ gradient: 8 }), { simSec: 1000 })
    expect(r.powerFrac).toBeLessThanOrEqual(0.85)
  })

  it('explosion Endurance → Z1 forcé', () => {
    const r = mkRider('rouleur', { exploded: true, wRatio: 0.05 })
    const z = decideTargetZone(r, mkRoute({ gradient: 0 }), { simSec: 0 })
    expect(z).toBe(1)
  })
})

describe('decideTargetZone — anti-girouette', () => {
  it('la hausse d\'intensité est lissée (amortie), pas instantanée', () => {
    const r = mkRider('grimpeur', { wRatio: 1.0, splinePos: 0 })
    r.speedKmh = 16; r._zoneCommitSec = -100
    r.powerFrac = 0.65
    // Une grosse pente vise haut, mais on ne saute pas d'un coup à la cible.
    decidePowerTarget(r, mkRoute({ gradient: 8 }), { simSec: 1000 })
    expect(r.powerFrac).toBeGreaterThan(0.65)   // a monté
    expect(r.powerFrac).toBeLessThan(1.13)      // mais pas d'un bond jusqu'au plafond
  })

  it('autorise la montée une fois l\'engagement tenu et la réserve haute', () => {
    const r = mkRider('grimpeur', { wRatio: 1.0, splinePos: 0 })
    decideTargetZone(r, mkRoute({ gradient: 0 }), { simSec: 0 })
    const z = decideTargetZone(r, mkRoute({ gradient: 6 }), { simSec: 10 })
    expect(z).toBeGreaterThan(2)
  })

  it('la baisse d\'intensité est immédiate (sécurité W\')', () => {
    const r = mkRider('grimpeur', { wRatio: 1.0, splinePos: 0 })
    r.speedKmh = 16; r._zoneCommitSec = -100
    for (let i = 0; i < 20; i++) decidePowerTarget(r, mkRoute({ gradient: 8 }), { simSec: 1000 + i })
    const high = r.powerFrac
    expect(high).toBeGreaterThan(0.95)
    // Réserve s'effondre : la baisse s'applique tout de suite (pas de lissage)
    r.energy.wPrime.current = 0.05 * r.energy.wPrime.max
    decidePowerTarget(r, mkRoute({ gradient: 8 }), { simSec: 1020 })
    expect(r.powerFrac).toBeLessThan(high)
  })
})

// ─── Journal de raisonnement (B1) — clé = zone ──────────────────────────────
describe('decideTargetZone — journal de raisonnement (rider.aiLog, B1)', () => {
  it('rider.aiLog démarre vide', () => {
    const r = createAIRider({ aiProfile: 'grimpeur' })
    expect(r.aiLog).toEqual([])
  })

  it('première décision : consignée avec zone, aiState et raison', () => {
    const r = mkRider('rouleur')
    decideTargetZone(r, mkRoute({ gradient: 0 }), { simSec: 0 })
    expect(r.aiLog).toHaveLength(1)
    expect(r.aiLog[0].zone).toBe(r.targetZone)
    expect(typeof r.aiLog[0].reason).toBe('string')
    expect(r.aiLog[0].aiState).toBeDefined()
  })

  it('aucune nouvelle entrée si la zone ne change pas', () => {
    const r = mkRider('rouleur', { splinePos: 0 })
    r._zoneCommitSec = -100
    decideTargetZone(r, mkRoute({ gradient: 0 }), { simSec: 0 })
    decideTargetZone(r, mkRoute({ gradient: 0 }), { simSec: 1 })
    expect(r.aiLog).toHaveLength(1)
  })

  it('nouvelle entrée quand la phase de course change', () => {
    const r = mkRider('grimpeur', { wRatio: 1.0, splinePos: 0 })
    r.speedKmh = 30
    decidePowerTarget(r, mkRoute({ gradient: 0 }), { simSec: 0 })   // plat
    r.speedKmh = 16
    decidePowerTarget(r, mkRoute({ gradient: 6 }), { simSec: 10 })  // montée
    expect(r.aiLog.length).toBeGreaterThanOrEqual(2)
    expect(r.aiLog[r.aiLog.length - 1].reason).not.toBe(r.aiLog[0].reason)
  })

  it('le journal est plafonné à AI_LOG_MAX_ENTRIES (FIFO)', () => {
    const r = mkRider('grimpeur', { wRatio: 1.0, splinePos: 0 })
    r._zoneCommitSec = -1000
    // Alterne plat/forte pente sur de nombreux ticks pour générer des changements
    for (let s = 0; s < 200; s++) {
      const g = (s % 2 === 0) ? 0 : 8
      r.energy.wPrime.current = r.energy.wPrime.max // garde la réserve haute
      r._zoneCommitSec = -1000                      // lève l'engagement à chaque fois
      decideTargetZone(r, mkRoute({ gradient: g }), { simSec: s })
    }
    expect(r.aiLog.length).toBeLessThanOrEqual(AI_LOG_MAX_ENTRIES)
  })
})

// ─── Compat : aiDecide délègue à decideTargetZone ───────────────────────────
describe('aiDecide (compat) — délègue à decideTargetZone', () => {
  it('renvoie la zone cible et mute rider.targetZone', () => {
    const r = mkRider('rouleur')
    const z = aiDecide(r, { route: mkRoute({ gradient: 0 }), simSec: 0 })
    expect(z).toBe(r.targetZone)
  })
})

// ─── Physique : la masse est le levier des bosses (W/kg) ────────────────────
describe('computeSpeed — la masse réelle pilote l\'avantage en montée', () => {
  it('à watts ÉGAUX, le plus léger grimpe plus vite', () => {
    const light = computeSpeed(245, 8, 0, 1, 66)
    const heavy = computeSpeed(245, 8, 0, 1, 88)
    expect(light).toBeGreaterThan(heavy)
  })

  it('un grimpeur amateur (66kg, 245W) grimpe plus vite qu\'un sprinter (84kg, 250W) à 8%', () => {
    const grimpeur = computeSpeed(0.98 * 245, 8, 0, 1, 66)
    const sprinteur = computeSpeed(0.98 * 250, 8, 0, 1, 84)
    expect(grimpeur).toBeGreaterThan(sprinteur)
  })

  it('sur le plat, l\'écart de masse ne renverse pas l\'avantage de puissance', () => {
    const grimpeur = computeSpeed(0.98 * 245, 0, 0, 1, 66)
    const rouleur = computeSpeed(0.98 * 270, 0, 0, 1, 78)
    expect(rouleur).toBeGreaterThan(grimpeur)
  })
})

// ─── Intégration : enduranceFactor module la recharge W' ────────────────────
describe('enduranceFactor — module la recharge de wBalance (§8)', () => {
  it('à réserve entamée et zone aérobie, un meilleur enduranceFactor recharge plus vite', () => {
    const slow = createAIRider({ aiProfile: 'sprinteur' }) // enduranceFactor bas
    const fast = createAIRider({ aiProfile: 'grimpeur' })  // enduranceFactor haut
    // Même point de départ de réserve, zone de récup (Z2)
    for (const r of [slow, fast]) {
      r.targetZone = 2
      r.energy.wPrime.current = 0.5 * r.energy.wPrime.max
    }
    const route = mkRoute({ gradient: 0 })
    const w0slow = slow.energy.wPrime.current / slow.energy.wPrime.max
    const w0fast = fast.energy.wPrime.current / fast.energy.wPrime.max
    for (let i = 0; i < 20; i++) { simulateTick(slow, route, 1); simulateTick(fast, route, 1) }
    const gainSlow = slow.energy.wPrime.current / slow.energy.wPrime.max - w0slow
    const gainFast = fast.energy.wPrime.current / fast.energy.wPrime.max - w0fast
    expect(gainFast).toBeGreaterThan(gainSlow)
  })

  it('freshness décroît avec le temps cumulé', () => {
    const r = createAIRider({ aiProfile: 'rouleur' })
    r.targetZone = 2
    const f0 = r.energy.freshness
    for (let i = 0; i < 100; i++) simulateTick(r, mkRoute({ gradient: 0 }), 1)
    expect(r.energy.freshness).toBeLessThan(f0)
  })
})

// ─── v1.2 : coût énergie continu + gestion de budget en montée ──────────────
describe('Énergie continue & budget de montée (v1.2)', () => {
  const mkRoute = ({ gradient = 0, totalLength = 50000, segments = [] } = {}) => ({
    getGradientAt: () => gradient, totalLength, segments,
  })

  it('Endurance : un effort plus intense draine plus vite (P/FTP)²', () => {
    const easy = createRider({ powerFrac: 0.65 })
    const hard = createRider({ powerFrac: 0.98 })
    for (let i = 0; i < 30; i++) { simulateTick(easy, mkRoute({ gradient: 0 }), 1); simulateTick(hard, mkRoute({ gradient: 0 }), 1) }
    const dEasy = easy.energy.endurance.max - easy.energy.endurance.current
    const dHard = hard.energy.endurance.max - hard.energy.endurance.current
    expect(dHard).toBeGreaterThan(dEasy)
  })

  it('sur une longue HC, un grimpeur léger pousse au-dessus du seuil (powerFrac > 1)', () => {
    const segments = [{ from: 0, to: 12000, type: 'hc_climb' }]
    const route = { getGradientAt: () => 7, totalLength: 12000, segments }
    const grimpeur = createAIRider({ aiProfile: 'grimpeur', splinePos: 2000 })
    grimpeur.profile.mass = 64
    grimpeur.speedKmh = 16
    grimpeur._zoneCommitSec = -100
    // plusieurs ticks pour laisser le lissage monter vers la cible
    for (let i = 0; i < 30; i++) decidePowerTarget(grimpeur, route, { simSec: 1000 + i })
    expect(grimpeur.powerFrac).toBeGreaterThan(1.0)
  })

  it('sur la même HC, un coureur lourd plafonne plus bas qu\'un léger', () => {
    const segments = [{ from: 0, to: 12000, type: 'hc_climb' }]
    const route = { getGradientAt: () => 7, totalLength: 12000, segments }
    const leger = createAIRider({ aiProfile: 'grimpeur', splinePos: 2000 })
    const lourd = createAIRider({ aiProfile: 'sprinteur', splinePos: 2000 })
    leger.profile.mass = 64; lourd.profile.mass = 86
    for (const r of [leger, lourd]) { r.speedKmh = 15; r._zoneCommitSec = -100 }
    for (let i = 0; i < 30; i++) { decidePowerTarget(leger, route, { simSec: 1000+i }); decidePowerTarget(lourd, route, { simSec: 1000+i }) }
    expect(lourd.powerFrac).toBeLessThanOrEqual(leger.powerFrac)
  })
})
