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

// ─── Aspiration / draft (Bloc A — TDD v0.5 §4bis.3) ─────────────────────────
// Courbe plafonnée : le bénéfice augmente avec le nombre d'écrans devant, avec
// un rendement marginal décroissant, et plafonne à 7 écrans (au-delà, gain nul).
// Index = nombre d'écrans dans le cône frontal ; valeur = réduction aéro de base.
const DRAFT_BASE_TABLE = [0, 0.12, 0.22, 0.30, 0.36, 0.40, 0.43, 0.45]
const DRAFT_CONE_DIST_M    = 10            // portée frontale du cône (m)
const DRAFT_CONE_HALF_ANGLE = Math.PI / 6  // demi-angle 30°
// Au-delà de cet écart longitudinal entre deux coureurs successifs (m), on
// considère une cassure : ils ne sont plus dans le même groupe.
const GROUP_GAP_THRESHOLD_M = 25

// ─── IA comportementale (Bloc B — TDD/GDD v0.5 §12.2) ───────────────────────
// États de la machine IA. EXPLODED et RECOVERING priment sur la décision de
// profil ; ATTACKING se maintient jusqu'à quasi-épuisement du W' (hystérésis,
// évite le flip-flop tick par tick).
export const AI_STATES = {
  FOLLOWING:  'following',
  ATTACKING:  'attacking',
  EXPLODED:   'exploded',
  RECOVERING: 'recovering',
}

// Seuils de réserve W' (fraction du max) pour les transitions d'état.
const WPRIME_RECOVER_ENTER = 0.15  // sous ce seuil → RECOVERING (Éco forcé)
const WPRIME_RECOVER_EXIT  = 0.40  // au-dessus → sortie de RECOVERING
const WPRIME_ATTACK_EXIT   = 0.15  // sous ce seuil → fin d'attaque (RECOVERING)

// Profils IA — stratégie d'effort selon le terrain (TDD v0.5 §12.2).
// equipier : "calque sur le leader d'équipe" nécessite un modèle d'équipe
// (team_id / leader_id) non encore présent dans le schéma roster — en
// attendant, comportement prudent type rouleur, sans initiative d'attaque
// (seuil d'attaque "Jamais", conforme à la table v0.5).
export const AI_PROFILES = {
  grimpeur: {
    climbGradientMin:  2,     // % — au-delà : terrain de montée pour ce profil
    attackGradientMin: 5,     // % — gradient minimum pour tenter une attaque
    attackWPrimeMin:   0.60,  // W' minimum pour tenter une attaque
  },
  rouleur: {
    climbGradientMin:  2,
    attackGradientMax: 2,     // attaque seulement sur plat / faux-plat
    attackWPrimeMin:   0.70,
  },
  sprinteur: {
    maintienDistM: 2000,      // bascule en Maintien dans les 2 derniers km
    sprintDistM:   500,       // attaque (Z5/Z6) dans les 500 derniers m
  },
  equipier: {
    climbGradientMin: 2,
  },
}

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
    screenCount: 0,        // écrans devant dans le cône (Bloc A) — calculé par la boucle
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
    aiState: AI_STATES.FOLLOWING,
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

/**
 * Instancie N coureurs depuis un roster JSON (TDD v0.5 §7.3, Bloc A).
 * Chaque entrée : { id, name, isPlayer, ftpWatts, role, aiProfile }.
 *
 * Les coureurs sont étagés longitudinalement à la ligne de départ pour qu'un
 * peloton existe dès le premier tick (sinon tous à splinePos 0 = côte à côte,
 * aucun écran, aucun draft). L'étagement est faible (quelques mètres) et sera
 * vite réorganisé par la dynamique de course.
 *
 * @param {Object} roster - { id, riders: [...] }
 * @param {Object} opts   - { startSpacingM: espacement initial entre coureurs }
 * @returns {Array} riders
 */
export function createRidersFromRoster(roster, opts = {}) {
  const startSpacingM = opts.startSpacingM ?? 3
  const list = roster?.riders ?? []
  const n = list.length

  return list.map((entry, i) => {
    const isPlayer = !!entry.isPlayer
    // Étagement : le premier de la liste démarre devant. Léger zig-zag latéral
    // pour éviter l'alignement parfait (et donner des écrans dans le cône).
    const splinePos = (n - 1 - i) * startSpacingM
    const lateralOffset = (i % 2 === 0 ? 1 : -1) * 0.4 * (isPlayer ? 1 : 1)

    const make = isPlayer ? createRider : createAIRider
    return make({
      id:   entry.id   ?? `rider_${String(i).padStart(3, '0')}`,
      name: entry.name ?? `Coureur ${i + 1}`,
      isPlayer,
      role: entry.role ?? 'allrounder',
      aiProfile: isPlayer ? null : (entry.aiProfile ?? 'rouleur'),
      splinePos,
      renderPos: splinePos,
      lateralOffset,
      energy: {
        endurance:  { current: 3600, max: 3600 },
        wPrime:     { current: 25000, max: 25000 },
        zone:       2,
        ftpWatts:   entry.ftpWatts ?? 280,
        exploded:   false,
        wFailTicks: 0,
        dayFormMod: 1.0,
      },
      effortMode: isPlayer ? 'maintien' : 'eco',
    })
  })
}

// ─── Calcul de vitesse (physique simplifiée) ─────────────────────────────────
/**
 * Résolution numérique de v tel que P_dispo = P_aero(v) + P_pente(v) + P_roulement(v)
 * Dichotomie simple, 8 itérations.
 *
 * @param {number} powerWatts
 * @param {number} gradientPercent
 * @param {number} windKmh
 * @param {number} draftFactor - multiplicateur de CdA ∈ ]0,1] (1 = pas d'abri).
 *                               Vaut 1 - draftReduction(). Réduit la traînée aéro.
 */
export function computeSpeed(powerWatts, gradientPercent, windKmh = 0, draftFactor = 1) {
  const { rho, g, Crr, mass } = PHYSICS
  const CdA = (Math.abs(gradientPercent) > 3 ? PHYSICS.CdA_climb : PHYSICS.CdA_flat) * draftFactor
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

// ─── Aspiration / draft ──────────────────────────────────────────────────────
/**
 * Réduction aérodynamique due au draft.
 * Modèle frontal plafonné (TDD v0.5 §4bis.3) :
 *   draftEffectif = draftBase(screenCount) × clamp((v/40)², 0.05, 1.0)
 * Le facteur vitesse modélise l'effondrement de l'aspiration en montagne
 * (l'aéro est en v², donc à 15 km/h le draft est quasi nul).
 *
 * @param {number} screenCount - nombre de coureurs faisant écran dans le cône
 * @param {number} speedKmh    - vitesse instantanée du coureur
 * @returns {number} réduction ∈ [0, 0.45] — fraction de CdA économisée
 */
export function draftReduction(screenCount, speedKmh) {
  const idx  = Math.min(Math.max(0, Math.floor(screenCount)), DRAFT_BASE_TABLE.length - 1)
  const base = DRAFT_BASE_TABLE[idx]
  const vFactor = Math.min(1.0, Math.max(0.05, (speedKmh / 40) ** 2))
  return base * vFactor
}

/**
 * Compte les coureurs faisant écran devant `rider`, dans son cône frontal.
 * Géométrie (TDD v0.5 §12.1) : un coureur compte comme écran si
 *   - il appartient au même groupe,
 *   - il est devant en splinePos (ahead > 0),
 *   - il est dans la fenêtre de distance (ahead ≤ CONE_DIST),
 *   - son écart latéral le place dans le demi-angle du cône.
 *
 * On compte sur la géométrie, pas sur rankInGroup : deux coureurs côte à côte
 * (même splinePos) ne s'abritent pas, et un coureur en 2e ligne ne « voit »
 * que les coureurs réellement devant lui.
 *
 * @param {Object} rider
 * @param {Array}  riders - tous les coureurs
 * @returns {number} nombre d'écrans
 */
export function computeScreenCount(rider, riders) {
  let count = 0
  for (const r of riders) {
    if (r.id === rider.id || r.group !== rider.group) continue
    const ahead = r.splinePos - rider.splinePos
    if (ahead <= 0 || ahead > DRAFT_CONE_DIST_M) continue
    const lateral = Math.abs((r.lateralOffset ?? 0) - (rider.lateralOffset ?? 0))
    const angle = Math.atan2(lateral, ahead)
    if (angle <= DRAFT_CONE_HALF_ANGLE) count++
  }
  return count
}

/**
 * Recalcule group + rankInGroup pour tous les coureurs (TDD v0.5 §12.1).
 * Étagement longitudinal : tri par splinePos décroissant (1 = tête de course),
 * segmentation en groupes selon les écarts (> GROUP_GAP_THRESHOLD_M => cassure).
 *
 * Mute chaque rider (group, rankInGroup). Retourne la liste des groupes
 * pour l'UI (bandeau d'écarts) : [{ name, riders: [...] }, ...].
 *
 * @param {Array} riders
 * @returns {Array} groupes ordonnés de l'avant vers l'arrière
 */
export function updateGroups(riders) {
  if (riders.length === 0) return []
  const sorted = [...riders].sort((a, b) => b.splinePos - a.splinePos)

  const groups = []
  let current = null
  let prevPos = null

  for (const r of sorted) {
    if (current === null || (prevPos - r.splinePos) > GROUP_GAP_THRESHOLD_M) {
      current = { name: `group_${groups.length}`, riders: [] }
      groups.push(current)
    }
    current.riders.push(r)
    prevPos = r.splinePos
  }

  // Nommage lisible : tête = échappée si seule devant, sinon peloton ; reste = poursuivants/retardataires
  groups.forEach((g, gi) => {
    let name
    if (groups.length === 1)      name = 'peloton'
    else if (gi === 0)            name = g.riders.length <= 3 ? 'echappee' : 'peloton'
    else if (gi === groups.length - 1) name = 'retardataires'
    else                          name = 'poursuivants'
    g.name = name
    g.riders.forEach((r, ri) => {
      r.group = name
      r.rankInGroup = ri + 1   // 1 = tête de groupe
    })
  })

  return groups
}

// ─── IA comportementale — décision d'effort (Bloc B) ────────────────────────
/**
 * Détermine si `rider` doit tenter une attaque selon son profil
 * (TDD/GDD v0.5 §12.2 — colonne "Seuil d'attaque").
 *
 * @returns {boolean}
 */
export function shouldAttack(rider, gradient, distanceToFinish, wRatio) {
  const profile = AI_PROFILES[rider.aiProfile]
  if (!profile) return false
  switch (rider.aiProfile) {
    case 'grimpeur':
      return gradient >= profile.attackGradientMin && wRatio >= profile.attackWPrimeMin
    case 'rouleur':
      return gradient <= profile.attackGradientMax && wRatio >= profile.attackWPrimeMin
    case 'sprinteur':
      return distanceToFinish <= profile.sprintDistM
    case 'equipier':
    default:
      return false // "Seuil d'attaque : Jamais" (TDD v0.5 §12.2)
  }
}

/**
 * Mode d'effort « de croisière » (état FOLLOWING) selon profil et terrain
 * (TDD/GDD v0.5 §12.2 — colonnes "Stratégie montée" / "descente-plat").
 *
 * @returns {'eco'|'maintien'}
 */
export function baseEffortMode(rider, gradient, distanceToFinish) {
  const profile = AI_PROFILES[rider.aiProfile]
  if (!profile) return 'maintien'
  switch (rider.aiProfile) {
    case 'grimpeur':
      // Maintien en montée (son terrain), Éco ailleurs (garde les jambes pour le col)
      return gradient >= profile.climbGradientMin ? 'maintien' : 'eco'
    case 'rouleur':
    case 'equipier':
      // Éco en montagne (pas leur terrain), Maintien sur plat / faux-plat
      return gradient >= profile.climbGradientMin ? 'eco' : 'maintien'
    case 'sprinteur':
      // Éco jusqu'aux 2 derniers km, puis Maintien pour se replacer avant le sprint
      return distanceToFinish <= profile.maintienDistM ? 'maintien' : 'eco'
    default:
      return 'maintien'
  }
}

/**
 * Décision d'effort IA pour un tick (TDD/GDD v0.5 §12.2).
 * Mute `rider.aiState` et renvoie le nouvel `effortMode`.
 *
 * Ordre de priorité :
 *  1. EXPLODED   — Endurance à 0, état terminal pour la course → Éco
 *  2. ATTACKING  — tient jusqu'à quasi-épuisement du W' (hystérésis)
 *  3. RECOVERING — Éco forcé jusqu'à reconstitution du W' (sauf sprint final)
 *  4. Tentative d'attaque selon le profil → ATTACKING
 *  5. FOLLOWING  — effort de base selon profil et terrain
 *
 * @param {Object} rider   - coureur IA (rider.aiProfile non null ; sinon no-op)
 * @param {Object} context - { route } — route expose getGradientAt(splinePos) et totalLength
 * @returns {string} effortMode ('eco' | 'maintien' | 'attaque')
 */
export function aiDecide(rider, context = {}) {
  // Coureur joueur : aucune décision IA, on laisse son effortMode tel quel.
  if (!rider.aiProfile) return rider.effortMode

  const { route } = context
  const energy = rider.energy
  const wRatio = energy.wPrime.current / energy.wPrime.max
  const gradient = route?.getGradientAt ? route.getGradientAt(rider.splinePos) : 0
  const distanceToFinish = route?.totalLength != null
    ? Math.max(0, route.totalLength - rider.splinePos)
    : Infinity

  const sprintCfg = AI_PROFILES.sprinteur
  const isFinalSprint = rider.aiProfile === 'sprinteur' && distanceToFinish <= sprintCfg.sprintDistM

  // 1. Explosion — irréversible sur la course
  if (energy.exploded) {
    rider.aiState = AI_STATES.EXPLODED
    return 'eco'
  }

  // 2. Attaque en cours : on tient jusqu'à épuisement quasi-total du W'
  if (rider.aiState === AI_STATES.ATTACKING) {
    if (wRatio < WPRIME_ATTACK_EXIT) {
      rider.aiState = AI_STATES.RECOVERING
    } else {
      return 'attaque'
    }
  }

  // 3. Récupération : priorité, sauf sprint final (dernière carte malgré tout)
  if (rider.aiState === AI_STATES.RECOVERING) {
    if (wRatio >= WPRIME_RECOVER_EXIT || isFinalSprint) {
      rider.aiState = AI_STATES.FOLLOWING
    } else {
      return 'eco'
    }
  } else if (wRatio < WPRIME_RECOVER_ENTER && !isFinalSprint) {
    rider.aiState = AI_STATES.RECOVERING
    return 'eco'
  }

  // 4. Tentative d'attaque selon le profil
  if (shouldAttack(rider, gradient, distanceToFinish, wRatio)) {
    rider.aiState = AI_STATES.ATTACKING
    return 'attaque'
  }

  // 5. Suivi normal
  rider.aiState = AI_STATES.FOLLOWING
  return baseEffortMode(rider, gradient, distanceToFinish)
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

  // Aspiration : la réduction de traînée dépend du nombre d'écrans devant
  // (rider.screenCount, calculé par la boucle avant le tick) et de la vitesse
  // du tick précédent (facteur v² qui varie peu d'un tick à l'autre).
  const draft = draftReduction(rider.screenCount ?? 0, rider.speedKmh)
  const draftFactor = 1 - draft

  // Vitesse
  const speedKmh = computeSpeed(powerWatts, gradient, 0, draftFactor)
  rider.speedKmh = speedKmh

  // Avancement sur la spline (m)
  const distanceM = (speedKmh / 3.6) * dtSec
  rider.splinePos = Math.min(rider.splinePos + distanceM, route.totalLength)
  rider.distanceTravelled += distanceM

  // Énergie
  applyEnergy(rider, powerWatts, dtSec)
}
