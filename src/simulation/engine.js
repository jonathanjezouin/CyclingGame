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

// ─── Taux de consommation/récupération d'énergie ────────────────────────────
// Source de vérité unique, partagée entre applyEnergy() (tick réel) et
// computeEnduranceDrain()/computeWPrimeDrain() (projection C1).
//
// Modèle continu (v1.2) : le coût n'est plus indexé sur le LABEL de zone mais
// sur la puissance réelle vs FTP. W' se vide des watts au-dessus du seuil et se
// recharge du déficit en dessous ; l'Endurance draine en (P/FTP)².
//
// Endurance — taux de base (J gameplay/sec) à 1.0×FTP. Le drain réel vaut
// ENDURANCE_BASE_RATE × (P/FTP)². Calibré pour qu'une étape longue en
// croisière (~0.65×FTP) ne vide pas la jauge, mais qu'une HC soutenue pèse.
const ENDURANCE_BASE_RATE = 1.6
// W' — puissance de récupération de référence (W sous le FTP) à laquelle la
// recharge atteint son taux nominal. Au-delà, la recharge plafonne.
const WPRIME_RECOVERY_REF_W = 100
// W' — taux de recharge nominal (J/sec) quand le déficit atteint la référence,
// avant modulation enduranceFactor × freshness.
const WPRIME_RECOVERY_RATE = 50

// ─── LEGACY (projection C1 historique / compat tests) ───────────────────────
// Conservés pour référence ; le tick réel n'indexe plus le coût sur la zone.
const ENDURANCE_AEROBIC_RATES = [0, 0.2, 0.5, 1.0]
const ENDURANCE_ANAEROBIC_RATE = 2
const WPRIME_ANAEROBIC_RATES = { 4: 80, 5: 200, 6: 500 }

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

// ─── IA — Raisonnement par couches (IA Couches v0.1) ────────────────────────
// La couche 1 modélise le COUREUR SEUL : il n'a AUCUNE conscience des autres
// coureurs. Son raisonnement aboutit à une ZONE D'EFFORT CIBLE (1-6), que le
// moteur traduit ensuite en puissance puis en vitesse. La machine d'état
// FOLLOWING/ATTACKING/RECOVERING (ex-Bloc B P0) est retirée au profit de ce
// modèle continu fondé sur le budget de réserve. Voir IA_Couches_v0_1.

// Nombre maximum d'entrées conservées dans rider.aiLog (B1 — fiche coureur).
// Une entrée par CHANGEMENT de zone cible (pas par tick) : reste lisible même
// sur une longue course. Les plus anciennes sont évincées (FIFO).
export const AI_LOG_MAX_ENTRIES = 20

// Facteur FTP central de chaque zone — utilisé pour traduire une zone cible
// (joueur OU IA) en puissance. Valeur représentative au milieu de la plage
// ftpMin..ftpMax de ZONES. Z6 borné à une valeur d'attaque soutenable.
export const ZONE_FTP_TARGET = { 1: 0.50, 2: 0.65, 3: 0.83, 4: 0.98, 5: 1.13, 6: 1.30 }

// ─── Profils amateurs (IA Couches v0.1 §5, valeurs abaissées vs pro) ────────
// Un profil n'est PAS une logique « si grimpeur alors… » : les comportements
// émergent du bouquet (W/kg, W', plafond anaérobie, enduranceFactor). Valeurs
// de niveau amateur (FTP ~245-270 W, W/kg ~3.0-3.7) — moddables.
//   mass  : kg (coureur + vélo)         maxAnaero : W (plafond 5-15 s)
//   ftp   : W (seuil ~1 h)              wPrimeJ   : J (taille du réservoir)
//   enduranceFactor : 0-1 (freine la recharge de wBalance + fraîcheur longue)
export const AMATEUR_PROFILES = {
  grimpeur: { mass: 66, ftp: 245, wPrimeJ: 11000, maxAnaerobicPower: 650,  enduranceFactor: 0.88 },
  rouleur:  { mass: 78, ftp: 270, wPrimeJ: 16000, maxAnaerobicPower: 750,  enduranceFactor: 0.86 },
  puncheur: { mass: 74, ftp: 255, wPrimeJ: 18000, maxAnaerobicPower: 850,  enduranceFactor: 0.80 },
  sprinteur:{ mass: 84, ftp: 250, wPrimeJ: 22000, maxAnaerobicPower: 1050, enduranceFactor: 0.74 },
}

// Amplitude de la variation individuelle (±%) appliquée à chaque caractéristique
// pour qu'aucun coureur d'un même profil ne soit interchangeable avec un autre.
const PROFILE_JITTER = 0.06

// PRNG déterministe (mulberry32) — pour que le jitter soit reproductible à
// partir d'une graine stable (l'id du coureur), donc des courses rejouables.
function _seededRng(seedStr) {
  let h = 1779033703 ^ String(seedStr).length
  for (let i = 0; i < String(seedStr).length; i++) {
    h = Math.imul(h ^ String(seedStr).charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  let a = h >>> 0
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Construit les caractéristiques individuelles d'un coureur à partir de son
 * profil amateur, avec une variation reproductible (graine = seed).
 *
 * @param {string} profileName - clé de AMATEUR_PROFILES
 * @param {string} seed        - graine du jitter (typiquement rider.id)
 * @returns {{mass,ftpWatts,wPrimeJ,maxAnaerobicPower,enduranceFactor}}
 */
export function makeRiderProfile(profileName, seed = 'seed') {
  const base = AMATEUR_PROFILES[profileName] ?? AMATEUR_PROFILES.rouleur
  const rng = _seededRng(`${seed}:${profileName}`)
  const jit = () => 1 + (rng() * 2 - 1) * PROFILE_JITTER
  return {
    mass:             Math.round(base.mass * jit()),
    ftpWatts:         Math.round(base.ftp * jit()),
    wPrimeJ:          Math.round(base.wPrimeJ * jit()),
    maxAnaerobicPower:Math.round(base.maxAnaerobicPower * jit()),
    enduranceFactor:  Math.min(0.98, Math.max(0.6, base.enduranceFactor * jit())),
  }
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

// ─── Modes POC → zones cibles (LEGACY — conservé pour C1/actionToZone) ──────
// Les modes Éco/Maintien/Attaque ne pilotent plus l'effort courant : le joueur
// comme l'IA visent désormais une ZONE cible (rider.targetZone, 1-6). Ces
// entrées restent utilisées par actionToZone()/projectCost() (C1) comme
// raccourcis d'« actions » projetables au survol du HUD.
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
    // Profil physiologique — constantes individuelles (IA Couches v0.1 §2.1).
    // mass est le levier des bosses ; wPrimeJ/maxAnaerobicPower/enduranceFactor
    // distinguent les profils sans logique « si grimpeur alors… ».
    profile: {
      mass: 75,
      ftpWatts: 280,
      wPrimeJ: 25000,
      maxAnaerobicPower: 900,
      enduranceFactor: 0.86,
    },
    // Énergie
    energy: {
      // Endurance — grande jauge « tenir des heures ». Dimensionnée pour une
      // étape longue (≥ 50 km) : ne se vide pas sur une seule course en
      // croisière Z2-Z3 (explosion réservée aux excès soutenus). IA Couches §4.
      endurance:  { current: 9000, max: 9000 },
      // wPrime = réserve anaérobie (W'). current = wBalance (jauge courante).
      wPrime:     { current: 25000, max: 25000 },
      zone:       2,
      ftpWatts:   280,
      exploded:   false,      // explosion Endurance — irréversible sur la course
      wFailTicks: 0,          // ticks restants de défaillance W' (crampe locale)
      freshness:  1.0,        // fraîcheur générale (1.0 → ~0.85), module la recharge
      dayFormMod: 1.0,
    },
    // État courant
    speedKmh: 0,
    targetZone: 3,            // zone d'effort cible (1-6) — joueur ET IA
    effortMode: 'maintien',  // LEGACY — conservé pour compat HUD/projection
    distanceTravelled: 0,
    screenCount: 0,        // écrans devant dans le cône (Bloc A) — calculé par la boucle
    // B1 — fiche coureur : journal des changements de décision IA
    // (aiState/effortMode), le plus récent en dernier. No-op pour le joueur
    // (aiDecide() ne l'appelle jamais). Voir AI_LOG_MAX_ENTRIES.
    aiLog: [],
    ...overrides,
  }
}

/**
 * Crée un coureur IA avec un profil amateur.
 * L'IA raisonne en couche 1 (decideTargetZone) : coureur seul, sans conscience
 * des autres. Sa zone cible est recalculée chaque tick (anti-girouette).
 */
export function createAIRider(overrides = {}) {
  const profileName = overrides.aiProfile ?? 'rouleur'
  const prof = makeRiderProfile(profileName, overrides.id ?? 'rider_ai_001')
  return createRider({
    id: 'rider_ai_001',
    name: 'Lucas Ferrer',
    isPlayer: false,
    aiProfile: profileName,
    lateralOffset: -0.8,    // côté gauche de la route
    profile: prof,
    energy: {
      endurance:  { current: 9000, max: 9000 },
      wPrime:     { current: prof.wPrimeJ, max: prof.wPrimeJ },
      zone:       2,
      ftpWatts:   prof.ftpWatts,
      exploded:   false,
      wFailTicks: 0,
      freshness:  1.0,
      dayFormMod: 1.0,
    },
    targetZone: 2,
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

    // Caractéristiques : priorité aux valeurs EN DUR du roster (mass, ftpWatts,
    // wPrimeJ, maxAnaerobicPower, enduranceFactor). Si une valeur manque, on
    // retombe sur le profil amateur (aiProfile, optionnel) ou des défauts.
    const fallback = entry.aiProfile
      ? makeRiderProfile(entry.aiProfile, entry.id ?? `rider_${i}`)
      : { mass: 75, ftpWatts: 260, wPrimeJ: 16000, maxAnaerobicPower: 800, enduranceFactor: 0.84 }
    const prof = {
      mass:              entry.mass              ?? fallback.mass,
      ftpWatts:          entry.ftpWatts          ?? fallback.ftpWatts,
      wPrimeJ:           entry.wPrimeJ           ?? fallback.wPrimeJ,
      maxAnaerobicPower: entry.maxAnaerobicPower ?? fallback.maxAnaerobicPower,
      enduranceFactor:   entry.enduranceFactor   ?? fallback.enduranceFactor,
    }

    return make({
      id:   entry.id   ?? `rider_${String(i).padStart(3, '0')}`,
      name: entry.name ?? `Coureur ${i + 1}`,
      isPlayer,
      role: entry.role ?? 'allrounder',
      // aiProfile conservé seulement s'il est fourni (plus requis) — pour
      // l'instant tous les coureurs partagent le même raisonnement couche 1.
      aiProfile: isPlayer ? null : (entry.aiProfile ?? 'coureur'),
      splinePos,
      renderPos: splinePos,
      lateralOffset,
      profile: prof,
      energy: {
        endurance:  { current: 9000, max: 9000 },
        wPrime:     { current: prof.wPrimeJ, max: prof.wPrimeJ },
        zone:       2,
        ftpWatts:   prof.ftpWatts,
        exploded:   false,
        wFailTicks: 0,
        freshness:  1.0,
        dayFormMod: 1.0,
      },
      targetZone: isPlayer ? 3 : 2,
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
 * @param {number} massKg - masse coureur+vélo (défaut PHYSICS.mass). Levier des
 *                          bosses : c'est par cette masse que le profil grimpeur
 *                          (léger) prend l'avantage en montée (W/kg).
 */
export function computeSpeed(powerWatts, gradientPercent, windKmh = 0, draftFactor = 1, massKg = PHYSICS.mass) {
  const { rho, g, Crr } = PHYSICS
  const mass = massKg ?? PHYSICS.mass
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

// ─── IA0 — Dérivation route (PBI v1.1, §0) ──────────────────────────────────
// Fonctions de requête pures sur des données déjà présentes (segments et
// keyPoints du track JSON, groups issus du Bloc A) — aucune nouvelle donnée.
// Prérequis bloquant pour IA-L1 (moments décisifs) et IA-L2 (écarts inter-
// groupes).

// Types de segments (track JSON) considérés comme "montée" / "plat" pour la
// dérivation des moments décisifs.
const CLIMB_SEGMENT_TYPES = ['climb', 'hc_climb']
const FLAT_SEGMENT_TYPES  = ['flat']

function _upcomingSegments(route, fromSplinePos, types) {
  return (route?.segments ?? [])
    .filter(seg => types.includes(seg.type) && seg.to > fromSplinePos)
    .map(seg => ({ ...seg, distanceM: Math.max(0, seg.from - fromSplinePos) }))
}

/**
 * Segments de montée (climb/hc_climb) à venir depuis `fromSplinePos`,
 * triés par ordre de rencontre (le plus proche en premier).
 *
 * @param {Object} route - expose `segments` : [{ from, to, type, road_width_m }, ...] (m)
 * @param {number} fromSplinePos
 * @returns {Array} segments enrichis de `distanceM` (distance jusqu'au début du segment)
 */
export function upcomingClimbs(route, fromSplinePos) {
  return _upcomingSegments(route, fromSplinePos, CLIMB_SEGMENT_TYPES)
}

/**
 * Segments de plat (flat) à venir depuis `fromSplinePos`.
 * @see upcomingClimbs
 */
export function upcomingFlats(route, fromSplinePos) {
  return _upcomingSegments(route, fromSplinePos, FLAT_SEGMENT_TYPES)
}

// Écart maximal (m) entre deux segments de montée pour qu'ils soient considérés
// comme UNE SEULE ascension. Couvre les replats/faux-plats d'approche : un
// faux-plat de 2% suivi d'un mur à 7% est une seule ascension pour le coureur,
// pas deux bosses. Au-delà de ce seuil (vraie descente, longue section plate),
// ce sont des ascensions distinctes.
const ASCENT_MERGE_GAP_M = 2500

/**
 * Regroupe les segments de montée (climb/hc_climb) contigus — ou séparés par un
 * court intervalle (≤ ASCENT_MERGE_GAP_M) — en ASCENSIONS logiques uniques.
 * Une ascension = { from, to, lengthM } couvrant tout l'ensemble.
 *
 * C'est la granularité « difficulté » telle que la perçoit un coureur : le
 * faux-plat d'approche et le mur qui suit forment un seul objectif (le sommet),
 * pas deux bosses comptées séparément.
 *
 * @param {Object} route - expose `segments`
 * @returns {Array<{from:number,to:number,lengthM:number}>} ascensions triées
 */
export function ascents(route) {
  const climbs = (route?.segments ?? [])
    .filter(s => CLIMB_SEGMENT_TYPES.includes(s.type))
    .sort((a, b) => a.from - b.from)
  const merged = []
  for (const seg of climbs) {
    const last = merged[merged.length - 1]
    if (last && seg.from - last.to <= ASCENT_MERGE_GAP_M) {
      last.to = seg.to   // prolonge l'ascension en cours
    } else {
      merged.push({ from: seg.from, to: seg.to })
    }
  }
  return merged.map(a => ({ ...a, lengthM: a.to - a.from }))
}

/**
 * Ascensions (fusionnées) à venir depuis `fromSplinePos` — celle en cours
 * incluse si le coureur est dedans. Sert au garde-fou prospectif (combien de
 * difficultés majeures restent) et au budget de montée.
 */
export function upcomingAscents(route, fromSplinePos) {
  return ascents(route).filter(a => a.to > fromSplinePos)
}

/**
 * Écart (m) entre le coureur `rider` et le groupe situé juste devant le sien.
 * Dérivé de `groups` (sortie de updateGroups, triée de l'avant vers l'arrière).
 *
 * Convention : écart = distance entre l'arrière du groupe de devant (le
 * coureur le plus reculé de ce groupe) et l'avant du groupe de `rider` (son
 * coureur le plus avancé) — c'est la distance que le groupe de `rider` doit
 * combler pour rejoindre le groupe de devant.
 *
 * Renvoie `Infinity` si `rider` est dans le groupe de tête (rien à rejoindre)
 * — ce qui rend naturellement fausses les conditions « écart < seuil de menace »
 * côté IA-L2.
 *
 * @param {Object} rider  - doit exposer `group` (nom du groupe courant)
 * @param {Array}  groups - sortie de updateGroups(riders)
 * @returns {number} écart en mètres, ou Infinity si pas de groupe devant
 */
export function gapToGroupAhead(rider, groups) {
  if (!groups || groups.length === 0) return Infinity
  const idx = groups.findIndex(g => g.name === rider.group)
  if (idx <= 0) return Infinity // tête de course, ou groupe introuvable

  const ownGroup   = groups[idx]
  const groupAhead = groups[idx - 1]
  if (!ownGroup.riders.length || !groupAhead.riders.length) return Infinity

  const frontOfOwn  = ownGroup.riders[0].splinePos                       // tête de son groupe
  const backOfAhead = groupAhead.riders[groupAhead.riders.length - 1].splinePos // arrière du groupe devant
  return Math.max(0, backOfAhead - frontOfOwn)
}

/**
 * Prochain « moment décisif » pour `rider`, selon son profil IA (PBI v1.1, §2) :
 *  - grimpeur            → sommet de la prochaine montée
 *  - rouleur / équipier  → début de la prochaine portion de plat
 *  - sprinteur           → prochain point clé de type "sprint"
 *  - tous (fallback)     → l'arrivée
 *
 * Le candidat de profil n'est retenu que s'il est plus proche que l'arrivée ;
 * sinon (ou si aucun candidat n'existe), l'arrivée est le moment décisif.
 *
 * @param {Object} rider - expose `splinePos` et `aiProfile`
 * @param {Object} route - expose `segments`, `keyPoints` (avec `splinePos`) et `totalLength`
 * @returns {{ type: string, name?: string, splinePos: number, distanceM: number }}
 */
export function getNextDecisiveMoment(rider, route) {
  const fromPos = rider.splinePos
  const totalLength = route?.totalLength ?? Infinity
  const finish = {
    type: 'finish',
    name: 'Arrivée',
    splinePos: totalLength,
    distanceM: Math.max(0, totalLength - fromPos),
  }

  let candidate = null
  switch (rider.aiProfile) {
    case 'grimpeur': {
      const [climb] = upcomingClimbs(route, fromPos)
      if (climb) {
        candidate = { type: 'summit', name: 'Sommet', splinePos: climb.to, distanceM: Math.max(0, climb.to - fromPos) }
      }
      break
    }
    case 'rouleur':
    case 'equipier': {
      const [flat] = upcomingFlats(route, fromPos)
      if (flat) {
        candidate = { type: 'flat', name: 'Plat', splinePos: flat.from, distanceM: Math.max(0, flat.from - fromPos) }
      }
      break
    }
    case 'sprinteur': {
      const sprintKp = (route?.keyPoints ?? []).find(kp => kp.type === 'sprint' && kp.splinePos > fromPos)
      if (sprintKp) {
        candidate = { type: 'sprint', name: sprintKp.name, splinePos: sprintKp.splinePos, distanceM: Math.max(0, sprintKp.splinePos - fromPos) }
      }
      break
    }
    default:
      break
  }

  return (candidate && candidate.distanceM < finish.distanceM) ? candidate : finish
}

// ─── IA — Couche 1 : le coureur seul (IA Couches v0.1) ──────────────────────
// Le raisonnement aboutit à une ZONE D'EFFORT CIBLE (1-6). Aucune conscience
// des autres coureurs (c'est l'objet des couches 2+). Recalculé chaque tick
// mais stabilisé contre l'effet « girouette » (hystérésis + engagement min).

// Formate une fraction en pourcentage entier pour les messages de raisonnement.
const _pct = (ratio) => Math.round(ratio * 100)

// Anti-girouette — seuils de wBalance (fraction du max) encadrant les montées
// de zone. On DESCEND de zone dès qu'on passe sous _LOW (sécurité, immédiat),
// mais on ne REMONTE qu'au-dessus de _HIGH : la bande morte tue l'oscillation.
const WBAL_DROP_BELOW = 0.15   // sous ce niveau → cap forcé à la baisse
const WBAL_RAISE_ABOVE = 0.40  // au-dessus → autorisé à viser plus haut à nouveau
// Engagement minimum : une zone choisie est tenue ce nombre de ticks (s) avant
// qu'une nouvelle MONTÉE de zone soit permise (une baisse d'urgence passe outre).
const ZONE_COMMIT_TICKS = 5

// Plafond de zone selon la masse en montée : plus lourd = plafond plus bas.
// (IA Couches v0.1 §9.1 — « on plafonne selon mass »).
function _massClimbZoneCap(mass) {
  if (mass >= 82) return 4   // gabarit lourd : pas au-delà du seuil en montée
  if (mass >= 74) return 5
  return 6                   // léger : peut monter en VO2max/sprint sur la bosse
}

// Distance restante (m) jusqu'au sommet de l'ASCENSION en cours (segments de
// montée fusionnés — faux-plat d'approche + mur comptent comme un seul objectif),
// ou null si le coureur n'est pas dans une montée. Sert au budget d'effort :
// « quelle intensité puis-je tenir jusqu'au sommet sans exploser ? ».
function _remainingClimbM(route, splinePos) {
  const asc = ascents(route).find(a => splinePos >= a.from && splinePos < a.to)
  return asc ? (asc.to - splinePos) : null
}

/**
 * Décide la ZONE d'effort cible d'un coureur seul (couche 1).
 * Mute rider.targetZone et rider.aiState (libellé lisible), consigne dans
 * rider.aiLog si la zone change. No-op pour le joueur (il choisit sa zone).
 *
 * Logique (IA Couches v0.1 §9.1) :
 *  1. Zone de base selon le temps : Z2 si loin de l'arrivée, Z3 en approche.
 *  2. Modulation pente : en montée on s'autorise +1 zone, plafonné par mass.
 *  3. Garde-fou prospectif : W' réparti sur les bosses restantes (climbsAhead)
 *     → on cape si beaucoup de montées restent (« pas tout sur la première »).
 *  4. Autorisation de puiser : si ça redescend juste après, on tolère Z4/Z5.
 *  5. Bornage wBalance : réserve basse → cap à Z3/Z2 (la réserve se recharge).
 *  + Filtre anti-girouette (hystérésis + engagement minimum).
 *
 * @param {Object} rider   - coureur IA (rider.aiProfile non null ; sinon no-op)
 * @param {Object} route   - expose getGradientAt, totalLength, segments
 * @param {Object} context - { simSec } horodatage simulé (B1, optionnel)
 * @returns {number} zone cible (1-6)
 */
export function decideTargetZone(rider, route, context = {}) {
  // Joueur : pas de décision IA, il pilote sa propre zone.
  if (!rider.aiProfile) return rider.targetZone

  const { simSec } = context
  const energy = rider.energy
  const prof = rider.profile ?? {}
  const mass = prof.mass ?? 75
  const wBal = energy.wPrime.current / energy.wPrime.max
  const gradient = route?.getGradientAt ? route.getGradientAt(rider.splinePos) : 0
  const totalLength = route?.totalLength ?? Infinity
  const distanceToFinish = Number.isFinite(totalLength)
    ? Math.max(0, totalLength - rider.splinePos)
    : Infinity

  // 1. Zone de base (plat / faux-plat) — bornée par le temps restant.
  //    En approche de l'arrivée (< 2 km), plus rien à garder → Z3.
  let zone = distanceToFinish <= 2000 ? 3 : 2
  let reason

  // 2. Modulation par la pente — GESTION DE BUDGET sur une montée.
  //    Sur un grand col, un coureur vise l'intensité la plus haute qu'il peut
  //    TENIR JUSQU'AU SOMMET sans exploser : il répartit sa réserve W' sur la
  //    distance de montée restante, plafonné par sa masse (un lourd lâche).
  const climbCap = _massClimbZoneCap(mass)
  if (gradient >= 2) {
    const ftp = energy.ftpWatts
    const wAvail = energy.wPrime.current
    // Réserve qu'on s'autorise à dépenser sur CETTE montée : on garde une marge
    // de sécurité (on ne vide jamais tout — paramétrable par profil plus tard).
    const SAFETY_MARGIN = 0.25
    const wBudget = Math.max(0, wAvail - SAFETY_MARGIN * energy.wPrime.max)

    // Distance restante jusqu'au sommet (si on est dans la montée), sinon on
    // se rabat sur une fenêtre courte (faux-plat isolé).
    const remainM = _remainingClimbM(route, rider.splinePos) ?? 500
    // Estimation grossière du temps jusqu'au sommet à la vitesse courante
    // (bornée pour rester stable au tout début quand speedKmh ≈ 0).
    const vMs = Math.max(2, (rider.speedKmh ?? 0) / 3.6)
    const timeToTopSec = remainM / vMs

    // Cherche la zone la plus haute (≤ plafond masse) dont le surcoût W' au-delà
    // du FTP reste finançable par le budget sur le temps jusqu'au sommet.
    // Z3 (sous le FTP) est toujours finançable (elle recharge même un peu).
    let chosen = 3
    for (let z = 4; z <= climbCap; z++) {
      const power = ZONE_FTP_TARGET[z] * ftp
      const drainPerSec = Math.max(0, power - ftp)        // W' J/s à cette zone
      const cost = drainPerSec * timeToTopSec
      if (cost <= wBudget) chosen = z
      else break
    }
    zone = Math.max(zone, chosen)

    const wkg = (ftp / mass).toFixed(1)
    reason = `Montée ${gradient.toFixed(1)}% sur ${(remainM/1000).toFixed(1)}km → Z${zone} ` +
             `(budget W' tenable jusqu'au sommet, ${wkg} W/kg, plafond Z${climbCap}).`
  } else if (gradient <= -3) {
    // Descente : inutile de forcer, on récupère.
    zone = Math.min(zone, 2)
    reason = `Descente ${gradient.toFixed(1)}% → récup en Z${zone}.`
  } else {
    reason = `Plat/faux-plat → Z${zone} (arrivée à ${(distanceToFinish/1000).toFixed(1)} km).`
  }

  // 3. Garde-fou prospectif : ne pas tout donner si d'AUTRES ascensions
  //    majeures restent APRÈS celle en cours. On compte les ascensions
  //    fusionnées dont le sommet est encore devant, en excluant celle où l'on
  //    se trouve (un faux-plat + mur = une seule ascension, pas deux).
  const ascentsAhead = upcomingAscents(route, rider.splinePos)
    .filter(a => !(rider.splinePos >= a.from && rider.splinePos < a.to))
  if (ascentsAhead.length >= 1 && zone >= 5) {
    zone = 4
    reason += ` ${ascentsAhead.length} ascension(s) après → cap Z4 (je garde pour la suite).`
  }

  // 5. Bornage dynamique par wBalance (réserve disponible) — sécurité immédiate.
  if (wBal < WBAL_DROP_BELOW) {
    zone = Math.min(zone, energy.exploded ? 1 : 2)
    reason = `Réserve W' basse (${_pct(wBal)}%) → cap Z${zone}, la réserve se recharge.`
  } else if (energy.exploded) {
    zone = 1
    reason = `Explosion Endurance → Z1 forcé (irréversible).`
  }

  // ── Filtre anti-girouette ──────────────────────────────────────────────
  const prev = rider.targetZone ?? zone
  const lastChange = rider._zoneCommitSec ?? -Infinity
  const committedFor = (simSec ?? 0) - lastChange
  if (zone > prev) {
    // Monter de zone : exige hystérésis (réserve au-dessus du seuil haut) ET
    // engagement minimum tenu. Sinon on reste sur la zone précédente.
    const allowed = wBal >= WBAL_RAISE_ABOVE && committedFor >= ZONE_COMMIT_TICKS
    if (!allowed) {
      zone = prev
      reason = `Maintien Z${zone} (anti-girouette : hystérésis/engagement non franchis).`
    }
  }
  // Une baisse de zone est toujours permise (sécurité W').

  if (zone !== prev) rider._zoneCommitSec = simSec ?? 0

  rider.targetZone = zone
  // aiState : libellé lisible dérivé de la zone (pour la fiche coureur B1).
  rider.aiState = zone >= 5 ? 'effort_fort' : zone >= 3 ? 'soutenu' : 'economie'
  _logZoneDecision(rider, simSec, zone, reason)
  return zone
}

// Journal B1 : une entrée par CHANGEMENT de zone cible (pas par tick).
function _logZoneDecision(rider, simSec, zone, reason) {
  if (!rider.aiLog) rider.aiLog = []
  const last = rider.aiLog[rider.aiLog.length - 1]
  if (!last || last.zone !== zone) {
    rider.aiLog.push({ simSec: simSec ?? null, zone, aiState: rider.aiState, reason })
    if (rider.aiLog.length > AI_LOG_MAX_ENTRIES) rider.aiLog.shift()
  }
}

/**
 * Compat : ancien point d'entrée de l'IA. Délègue à decideTargetZone() et
 * renvoie la zone cible (le moteur traduit zone → puissance dans simulateTick).
 * @returns {number} zone cible
 */
export function aiDecide(rider, context = {}) {
  return decideTargetZone(rider, context.route, context)
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

  const ftp = energy.ftpWatts
  const ftpRatio = powerWatts / ftp
  // La zone reste un libellé de lecture (HUD, fiche) dérivé du ratio — mais le
  // COÛT ci-dessous n'en dépend plus : il est indexé sur la puissance réelle.
  const zone = getZoneFromFtpRatio(ftpRatio)
  energy.zone = zone

  // ── W' : modèle continu (inspiré de Skiba) ──────────────────────────────
  // Au-dessus du FTP, W' se vide proportionnellement aux watts EXCÉDENTAIRES
  // (powerWatts − ftp). Sous le FTP, il se recharge proportionnellement au
  // déficit (ftp − powerWatts), modulé par enduranceFactor × freshness.
  // Conséquence directe : un coureur qui pousse 320 W pour 250 W de FTP dans
  // une bosse paye, même si le label affiche « Z3 » — le coût suit l'effort,
  // plus l'étiquette.
  if (powerWatts > ftp) {
    const excess = powerWatts - ftp                 // W au-dessus du seuil
    energy.wPrime.current = Math.max(0, energy.wPrime.current - excess * dtSec)
    if (energy.wPrime.current <= 0 && energy.wFailTicks <= 0) {
      energy.wFailTicks = W_FAIL_DURATION_TICKS
    }
  } else if (energy.wPrime.current < energy.wPrime.max) {
    // Recharge : le déficit sous le FTP, plafonné par DCP (puissance de
    // récupération de référence) pour éviter une recharge instantanée à l'arrêt.
    const deficit = Math.min(ftp - powerWatts, WPRIME_RECOVERY_REF_W)
    const endF = rider.profile?.enduranceFactor ?? 1
    const fresh = energy.freshness ?? 1
    const recovery = (deficit / WPRIME_RECOVERY_REF_W) * WPRIME_RECOVERY_RATE * endF * fresh
    energy.wPrime.current = Math.min(energy.wPrime.max, energy.wPrime.current + recovery * dtSec)
  }

  // ── Endurance : coût indexé sur l'intensité réelle (fraction de FTP) ─────
  // Drain = taux de base × (puissance / FTP)². Le carré accentue le coût des
  // hautes intensités soutenues : 10 km de HC à 1.0×FTP coûtent bien plus que
  // du plat à 0.65×FTP, sans paliers de zone. Un effort sous ~0.5×FTP draine
  // un minimum (le coureur consomme toujours un peu).
  const intensity = Math.max(0.5, ftpRatio)
  const enduranceDrain = ENDURANCE_BASE_RATE * intensity * intensity
  energy.endurance.current = Math.max(0, energy.endurance.current - enduranceDrain * dtSec)

  // Explosion Endurance
  if (energy.endurance.current <= 0) {
    energy.exploded = true
  }

  // Fraîcheur générale : décroît lentement avec le temps cumulé (IA Couches
  // v0.1 §8). 1.0 au départ → ~0.85 après ~1h. Plancher à 0.80.
  if (energy.freshness != null) {
    energy.freshness = Math.max(0.80, energy.freshness - 0.000045 * dtSec)
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

// ─── C1 — Projection de coût (PBI v1.0/v1.1, TDD v0.7 §11.2) ────────────────
// Algorithme de référence extrait ici (sans l'affichage HUD C2) afin d'être
// réutilisable par IA-L1 (computeBudget) et par C2-C4 une fois implémentés.

/**
 * Facteur FTP cible pour une `action`.
 *
 * Pour le POC, les seules "actions" disponibles sont les modes d'effort
 * (Éco/Maintien/Attaque — C2 les affiche au survol). `currentGradient` est
 * conservé dans la signature pour les actions contextuelles à venir
 * (menu D3 : « Se tenir à l'avant », « Prendre des relais »...) dont le
 * coût pourra dépendre du terrain ; il n'influence pas encore le résultat.
 *
 * @param {string} action - clé de EFFORT_MODES ('eco' | 'maintien' | 'attaque')
 * @param {number} currentGradient - % de pente courant (réservé, non utilisé)
 * @returns {number} facteur FTP (ex. 0.85 pour Maintien)
 */
export function actionToZone(action, currentGradient) {
  return (EFFORT_MODES[action] ?? EFFORT_MODES.maintien).ftpFactor
}

/**
 * Coût en Endurance (joules gameplay) pour `durationSec` à la zone donnée.
 * Mêmes taux que applyEnergy() (ENDURANCE_AEROBIC_RATES / ANAEROBIC_RATE) —
 * source de vérité partagée.
 *
 * @param {number} effectivePower - puissance effective (W), réservé pour calibration future
 * @param {number} zone - zone d'effort (1-6)
 * @param {number} durationSec
 * @returns {number} coût en joules gameplay (toujours ≥ 0)
 */
export function computeEnduranceDrain(effectivePower, zone, durationSec, ftp) {
  // Modèle continu : drain = base × (P/FTP)². Si ftp est fourni (4e arg), on
  // l'utilise ; sinon fallback legacy indexé sur la zone (anciens appels/tests).
  if (ftp) {
    const intensity = Math.max(0.5, effectivePower / ftp)
    return ENDURANCE_BASE_RATE * intensity * intensity * durationSec
  }
  const rate = zone <= 3
    ? (ENDURANCE_AEROBIC_RATES[zone] ?? ENDURANCE_AEROBIC_RATES[1])
    : ENDURANCE_ANAEROBIC_RATE
  return rate * durationSec
}

/**
 * Coût en W' (joules) pour `durationSec` à la zone donnée.
 * En zones aérobies (Z1-Z3), W' récupère : le coût est négatif (gain), à la
 * récupération passive WPRIME_RECOVERY_RATE — cohérent avec « W' stable »
 * dans l'exemple de projection (GDD v0.7 §5.3).
 *
 * @param {number} effectivePower - puissance effective (W), réservé pour calibration future
 * @param {number} zone - zone d'effort (1-6)
 * @param {number} durationSec
 * @returns {number} coût en joules (négatif = récupération de W')
 */
export function computeWPrimeDrain(effectivePower, zone, durationSec, ftp) {
  // Modèle continu : > FTP vide les watts excédentaires ; < FTP recharge du
  // déficit (plafonné à la référence). Coût net (négatif = recharge). Fallback
  // legacy par zone si ftp absent.
  if (ftp) {
    if (effectivePower > ftp) return (effectivePower - ftp) * durationSec
    const deficit = Math.min(ftp - effectivePower, WPRIME_RECOVERY_REF_W)
    return -(deficit / WPRIME_RECOVERY_REF_W) * WPRIME_RECOVERY_RATE * durationSec
  }
  if (zone <= 3) return -WPRIME_RECOVERY_RATE * durationSec
  const rate = WPRIME_ANAEROBIC_RATES[zone] ?? WPRIME_ANAEROBIC_RATES[6]
  return rate * durationSec
}

/**
 * Projection de coût d'une `action` jusqu'à un point clé situé à
 * `distanceToNextKeyPoint` mètres (TDD v0.7 §11.2, GDD v0.7 §5.3).
 *
 * Estimation honnête, pas une promesse : recalculée à la demande (C2/C3)
 * à partir de l'état courant du coureur.
 *
 * Note vitesse : la vitesse projetée est recalculée pour `action` via
 * computeSpeed() (et non rider.speedKmh, qui reflète l'effortMode courant) —
 * la projection porte sur "et si je faisais X", pas sur l'état présent.
 * Le draftFactor utilise rider.screenCount (géométrique, Bloc A), conforme
 * à la note v0.5 du TDD.
 *
 * @param {string} action - clé de EFFORT_MODES
 * @param {Object} rider  - expose energy.{ftpWatts,endurance,wPrime,dayFormMod}, screenCount, speedKmh, splinePos
 * @param {Object} route  - expose getGradientAt(splinePos)
 * @param {number} distanceToNextKeyPoint - mètres jusqu'au point clé visé
 * @returns {{ zone: number, durationSec: number, endurancePct: number, wPrimePct: number }}
 *          endurancePct/wPrimePct sont des fractions du max (ex. 0.22 = -22%) ;
 *          wPrimePct peut être négatif (récupération projetée).
 */
export function projectCost(action, rider, route, distanceToNextKeyPoint) {
  const { energy } = rider
  const currentGradient = route?.getGradientAt ? route.getGradientAt(rider.splinePos) : 0

  const ftpFactor    = actionToZone(action, currentGradient)
  const powerTarget  = ftpFactor * energy.ftpWatts * (energy.dayFormMod ?? 1)
  const draftFactor  = 1 - draftReduction(rider.screenCount ?? 0, rider.speedKmh ?? 0)
  const effectivePower = powerTarget * draftFactor
  const zone = getZoneFromFtpRatio(effectivePower / energy.ftpWatts)

  const speedKmh = computeSpeed(effectivePower, currentGradient, 0, draftFactor, rider.profile?.mass)
  const speedMs  = speedKmh / 3.6
  const durationSec = speedMs > 0 ? distanceToNextKeyPoint / speedMs : 0

  const enduranceCost = computeEnduranceDrain(effectivePower, zone, durationSec, energy.ftpWatts)
  const wPrimeCost    = computeWPrimeDrain(effectivePower, zone, durationSec, energy.ftpWatts)

  return {
    zone,
    durationSec,
    endurancePct: enduranceCost / energy.endurance.max,
    wPrimePct:    wPrimeCost   / energy.wPrime.max,
  }
}

// ─── Tick principal ──────────────────────────────────────────────────────────
/**
 * Avance la simulation d'un tick pour un coureur.
 * @param {Object} rider - état courant du coureur (muté)
 * @param {Object} route - objet route avec getGradientAt(splinePos)
 * @param {number} dtSec - durée du tick en secondes simulées
 */
export function simulateTick(rider, route, dtSec = 1) {
  const { energy } = rider

  // Puissance cible selon la ZONE cible (joueur ou IA — même chemin).
  // zone → facteur FTP central (ZONE_FTP_TARGET) → watts.
  const zone = rider.targetZone ?? 3
  const ftpFactor = ZONE_FTP_TARGET[zone] ?? ZONE_FTP_TARGET[3]
  let powerWatts = ftpFactor * energy.ftpWatts * energy.dayFormMod
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

  // Vitesse — masse réelle du coureur (levier des bosses : un grimpeur léger
  // grimpe plus vite à watts égaux).
  const massKg = rider.profile?.mass ?? PHYSICS.mass
  const speedKmh = computeSpeed(powerWatts, gradient, 0, draftFactor, massKg)
  rider.speedKmh = speedKmh

  // Avancement sur la spline (m)
  const distanceM = (speedKmh / 3.6) * dtSec
  rider.splinePos = Math.min(rider.splinePos + distanceM, route.totalLength)
  rider.distanceTravelled += distanceM

  // Énergie
  applyEnergy(rider, powerWatts, dtSec)
}
