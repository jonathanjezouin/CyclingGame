# 🚴 Vélo Manager / Rider — POC

Proof of Concept du moteur de simulation et du rendu 2D top-down.

## Stack

- **Electron** — runtime desktop
- **Vue 3** (Composition API) — UI / HUD
- **Pixi.js** — rendu WebGL 2D
- **JS pur** — moteur de simulation souverain

## Lancer le POC

```bash
npm install
npm run dev
```

Le script démarre Vite (port 5173) puis Electron automatiquement.

## Structure

```
src/
  simulation/
    engine.js      — physique, énergie, ticks (souverain)
    loop.js        — boucle de simulation découplée du rendu
  render/
    spline.js      — Catmull-Rom + riderToPixel canonique
    renderer.js    — Pixi.js : route, coureur, caméra
  ui/
    HUD.vue        — jauges énergie, modes d'effort, DS
    AltimetricProfile.vue — bandeau altimétrique SVG
  data/
    track_poc.json — tracé de test (12 km, montée + descente)
  App.vue          — orchestration générale
electron/
  main.js          — process principal, IPC, SLM placeholder
  preload.js       — contextBridge sécurisé
```

## Mécanique POC

- **3 modes d'effort** : Éco (Z2 / 65% FTP) · Maintien (Z3-4 / 85% FTP) · Attaque (Z5-6 / 115% FTP)
- **Double réservoir** : Endurance (heures) + W' anaérobie (minutes)
- **Physique** : équation puissance cycliste résolue par dichotomie à chaque tick
- **Draft** : modèle à shields avec facteur vitesse (non utilisé au POC coureur unique)
- **Accélération temporelle** : ×1 / ×5 / ×10 / ×30
- **Radio DS** : messages placeholder toutes les 15–35s simulées

## Périmètre Phase 1 (après POC)

- Multi-coureurs + dynamiques de groupe
- Draft effectif
- Zoom 3 avec trajectoire fine (forceRoute + forceEvitement)
- Projection de coût contextuelle
- Icônes d'état coureurs

---
*Vélo Manager / Rider — GDD/TDD v0.3*
