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
// Endurance — zones aérobies (Z1-Z3) : joules gameplay/sec, indexé par zone.
const ENDURANCE_AEROBIC_RATES = [0, 0.2, 0.5, 1.0]
// Endurance — zones anaérobies (Z4-Z6) : drain additionnel constant (J/sec).
const ENDURANCE_ANAEROBIC_RATE = 2
// W' — récupération passive en zones aérobies (J/sec).
const WPRIME_RECOVERY_RATE = 50
// W' — drain en zones anaérobies (J/sec), indexé par zone.
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
    const rate = ENDURANCE_AEROBIC_RATES[zone] ?? ENDURANCE_AEROBIC_RATES[1]
    energy.endurance.current = Math.max(0, energy.endurance.current - rate * dtSec)
    // Récupération W' passive
    if (energy.wPrime.current < energy.wPrime.max) {
      energy.wPrime.current = Math.min(
        energy.wPrime.max,
        energy.wPrime.current + WPRIME_RECOVERY_RATE * dtSec
      )
    }
  } else {
    // Zones anaérobies : consomme W'
    const wRate = WPRIME_ANAEROBIC_RATES[zone] ?? WPRIME_ANAEROBIC_RATES[6]
    energy.wPrime.current = Math.max(0, energy.wPrime.current - wRate * dtSec)
    // Consomme aussi Endurance plus vite
    energy.endurance.current = Math.max(0, energy.endurance.current - ENDURANCE_ANAEROBIC_RATE * dtSec)
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
export function computeEnduranceDrain(effectivePower, zone, durationSec) {
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
export function computeWPrimeDrain(effectivePower, zone, durationSec) {
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

  const speedKmh = computeSpeed(effectivePower, currentGradient, 0, draftFactor)
  const speedMs  = speedKmh / 3.6
  const durationSec = speedMs > 0 ? distanceToNextKeyPoint / speedMs : 0

  const enduranceCost = computeEnduranceDrain(effectivePower, zone, durationSec)
  const wPrimeCost    = computeWPrimeDrain(effectivePower, zone, durationSec)

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
