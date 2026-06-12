/**
 * Moteur de simulation — Vélo Manager / Rider POC
 * Souverain sur toutes les décisions mécaniques.
 * 1 tick = 1 seconde simulée.
 */

// ─── Constantes physiques ───────────────────────────────────────────────────
const PHYSICS = {
  rho: 1.225,       // densité air kg/m³
  g: 9.81,          // gravité m/s²
  CdA_flat: 0.32,   // traînée position aéro
  CdA_climb: 0.40,  // traînée position montagne
  Crr: 0.004,       // coefficient roulement
  mass: 75,         // masse coureur+vélo kg
}

// Durée de la défaillance W' (crampe locale) quand W' atteint 0, en ticks (= s)
const W_FAIL_DURATION_TICKS = 10
// Puissance bridée pendant la défaillance W' (fraction du FTP)
const W_FAIL_POWER_FACTOR = 0.50

// ─── Zones d'effort ─────────────────────────────────────────────────────────
export const ZONES = {
  Z1: { id: 1, name: 'Récupération', ftpMin: 0,   ftpMax: 0.55, color: '#60a5fa', label: 'Z1' },
  Z2: { id: 2, name: 'Endurance',    ftpMin: 0.56, ftpMax: 0.75, color: '#34d399', label: 'Z2' },
  Z3: { id: 3, name: 'Tempo',        ftpMin: 0.76, ftpMax: 0.90, color: '#fbbf24', label: 'Z3' },
  Z4: { id: 4, name: 'Seuil',        ftpMin: 0.91, ftpMax: 1.05, color: '#f97316', label: 'Z4' },
  Z5: { id: 5, name: 'VO2max',       ftpMin: 1.06, ftpMax: 1.20, color: '#ef4444', label: 'Z5' },
  Z6: { id: 6, name: 'Sprint',       ftpMin: 1.21, ftpMax: 9.99, color: '#dc2626', label: 'Z6' },
}

// ─── Modes POC → zones cibles ───────────────────────────────────────────────
// Note : 'attaque' à 1.15 FTP soutenu donne Z5 (effort prolongé d'attaque).
// Le Z6 ponctuel relève de l'action 'Sprinter' (déclenchement unique, Phase 1),
// pas d'un mode d'effort continu.
export const EFFORT_MODES = {
  eco:      { label: 'Éco',     ftpFactor: 0.65, zone: ZONES.Z2, color: '#34d399' },
  maintien: { label: 'Maintien',ftpFactor: 0.85, zone: ZONES.Z3, color: '#fbbf24' },
  attaque:  { label: 'Attaque', ftpFactor: 1.15, zone: ZONES.Z5, color: '#ef4444' },
}

// ─── Création d'un coureur ───────────────────────────────────────────────────
export function createRider(overrides = {}) {
  return {
    id: 'rider_001',
    name: 'Marco Deluca',
    isPlayer: true,
    // Niveau 1 — simulation
    splinePos: 0,
    renderPos: 0,
    group: 'peloton',
    rankInGroup: 1,
    // Niveau 2 — rendu Zoom 3
    lateralOffset: 0.8,     // joueur légèrement à droite du centre
    targetWheel: null,
    ellipse: { long: 2.5, lat: 0.8 },
    // Énergie
    energy: {
      endurance:  { current: 3600, max: 3600 },
      wPrime:     { current: 25000, max: 25000 },
      zone:       2,
      ftpWatts:   280,
      exploded:   false,      // explosion Endurance — irréversible sur la course
      wFailTicks: 0,          // ticks restants de défaillance W' (crampe locale)
      dayFormMod: 1.0,
    },
    // État courant
    speedKmh: 0,
    effortMode: 'maintien',
    distanceTravelled: 0,
    ...overrides,
  }
}

/**
 * Crée un coureur IA avec un profil simple.
 * L'IA roule à puissance constante (effortMode fixe, pas d'input joueur).
 */
export function createAIRider(overrides = {}) {
  return createRider({
    id: 'rider_ai_001',
    name: 'Lucas Ferrer',
    isPlayer: false,
    lateralOffset: -0.8,    // côté gauche de la route
    energy: {
      endurance:  { current: 3600, max: 3600 },
      wPrime:     { current: 25000, max: 25000 },
      zone:       2,
      ftpWatts:   265,       // légèrement plus faible que le joueur
      exploded:   false,
      wFailTicks: 0,
      dayFormMod: 1.0,
    },
    effortMode: 'maintien',
    ...overrides,
  })
}

// ─── Calcul de vitesse (physique simplifiée) ─────────────────────────────────
/**
 * Résolution numérique de v tel que P_dispo = P_aero(v) + P_pente(v) + P_roulement(v)
 * Dichotomie simple, 8 itérations.
 */
export function computeSpeed(powerWatts, gradientPercent, windKmh = 0) {
  const { rho, g, Crr, mass } = PHYSICS
  const CdA = Math.abs(gradientPercent) > 3 ? PHYSICS.CdA_climb : PHYSICS.CdA_flat
  const gradient = gradientPercent / 100
  const vWind = windKmh / 3.6

  // f(v) = P_aero + P_pente + P_roulement - powerWatts
  const f = (v) => {
    const vAbs = Math.max(v, 0.1)
    const pAero = 0.5 * CdA * rho * Math.pow(vAbs + vWind, 2) * vAbs
    const pPente = mass * g * Math.sin(Math.atan(gradient)) * vAbs
    const pRoul = Crr * mass * g * vAbs
    return pAero + pPente + pRoul - powerWatts
  }

  // Bornes initiales
  let lo = 0.1, hi = 25 // m/s (90 km/h max)
  for (let i = 0; i < 8; i++) {
    const mid = (lo + hi) / 2
    if (f(mid) < 0) lo = mid
    else hi = mid
  }
  const vMs = (lo + hi) / 2
  return Math.max(0, vMs * 3.6) // retourne en km/h
}

// ─── Consommation d'énergie ──────────────────────────────────────────────────
/**
 * Calcule et applique la consommation d'énergie pour 1 tick (1 seconde).
 */
export function applyEnergy(rider, powerWatts, dtSec = 1) {
  const { energy } = rider
  if (energy.exploded) {
    // Après explosion : puissance bridée
    return
  }

  const ftpRatio = powerWatts / energy.ftpWatts
  const zone = getZoneFromFtpRatio(ftpRatio)
  energy.zone = zone

  if (zone <= 3) {
    // Zones aérobies : consomme Endurance lentement
    const rate = [0, 0.2, 0.5, 1.0][zone] ?? 1.0 // joules gameplay/sec
    energy.endurance.current = Math.max(0, energy.endurance.current - rate * dtSec)
    // Récupération W' passive
    if (energy.wPrime.current < energy.wPrime.max) {
      energy.wPrime.current = Math.min(
        energy.wPrime.max,
        energy.wPrime.current + 50 * dtSec
      )
    }
  } else {
    // Zones anaérobies : consomme W'
    const wRates = { 4: 80, 5: 200, 6: 500 } // J/sec
    const wRate = wRates[zone] ?? 200
    energy.wPrime.current = Math.max(0, energy.wPrime.current - wRate * dtSec)
    // Consomme aussi Endurance plus vite
    energy.endurance.current = Math.max(0, energy.endurance.current - 2 * dtSec)
    // Défaillance W' : si W' atteint 0, crampe locale pendant N ticks
    // (puissance bridée, cf. simulateTick). Récupération partielle ensuite.
    if (energy.wPrime.current <= 0 && energy.wFailTicks <= 0) {
      energy.wFailTicks = W_FAIL_DURATION_TICKS
    }
  }

  // Explosion Endurance
  if (energy.endurance.current <= 0) {
    energy.exploded = true
  }
}

/**
 * Zone (1-6) à partir du ratio puissance/FTP.
 * Dérivé de la table ZONES — source de vérité unique pour les seuils.
 * Les bornes ftpMax de la table sont inclusives ; on retourne la première
 * zone dont ftpMax couvre le ratio.
 */
const _ZONES_ORDERED = Object.values(ZONES).sort((a, b) => a.id - b.id)

export function getZoneFromFtpRatio(ratio) {
  for (const z of _ZONES_ORDERED) {
    if (ratio <= z.ftpMax) return z.id
  }
  return _ZONES_ORDERED[_ZONES_ORDERED.length - 1].id // Z6 fallback
}

// ─── Tick principal ──────────────────────────────────────────────────────────
/**
 * Avance la simulation d'un tick pour un coureur.
 * @param {Object} rider - état courant du coureur (muté)
 * @param {Object} route - objet route avec getGradientAt(splinePos)
 * @param {number} dtSec - durée du tick en secondes simulées
 */
export function simulateTick(rider, route, dtSec = 1) {
  const mode = EFFORT_MODES[rider.effortMode] ?? EFFORT_MODES.maintien
  const { energy } = rider

  // Puissance cible selon mode et état
  let powerWatts = mode.ftpFactor * energy.ftpWatts * energy.dayFormMod
  if (energy.exploded) powerWatts = energy.ftpWatts * 0.55

  // Défaillance W' (crampe) : puissance bridée pendant N ticks, puis récupération
  if (energy.wFailTicks > 0) {
    powerWatts = Math.min(powerWatts, energy.ftpWatts * W_FAIL_POWER_FACTOR)
    energy.wFailTicks = Math.max(0, energy.wFailTicks - dtSec)
  }

  // Gradient actuel
  const gradient = route.getGradientAt ? route.getGradientAt(rider.splinePos) : 0

  // Vitesse
  const speedKmh = computeSpeed(powerWatts, gradient)
  rider.speedKmh = speedKmh

  // Avancement sur la spline (m)
  const distanceM = (speedKmh / 3.6) * dtSec
  rider.splinePos = Math.min(rider.splinePos + distanceM, route.totalLength)
  rider.distanceTravelled += distanceM

  // Énergie
  applyEnergy(rider, powerWatts, dtSec)
}
