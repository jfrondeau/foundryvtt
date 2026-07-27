/**
 * Combat Overlay — Module Foundry VTT v14 · Système dnd5e 5.x
 *
 * Suivi de combat COMPACT superposé à la scène, pensé pour l'écran partagé de la
 * table. Il s'affiche AUTOMATIQUEMENT dès qu'un combat est actif (encounter créé
 * avec au moins un combattant) et reste visible pour TOUS les utilisateurs.
 *
 * Deux vues selon la phase (empreinte minimale sur la carte) :
 *  - « Setup » (Préparation, ou édition manuelle relancée en combat via ⋮) : liste
 *    large — vignette + nom + initiative ÉDITABLE — plus les contrôles de mise en
 *    place (rouler l'init des monstres, Commencer / Terminer, Fermer l'édition).
 *  - « Combat » : RAIL fin de vignettes (anneau PV coloré, ☠ si mort), le courant
 *    agrandi avec halo ember ; à côté, la carte du courant (grand portrait + CA/PV)
 *    et le panneau cible (T). L'initiative est masquée par défaut une fois lancé.
 *  - Les combattants cachés ne sont visibles que du MJ (grisés).
 *
 * Réglages notables (client) : afficher les portraits, masquer l'init en combat,
 * afficher le bouton « Tour suivant » (off par défaut : le raccourci « . » suffit).
 *
 * Automatisations au changement de tour :
 *  - Le token du combattant courant est SÉLECTIONNÉ (pour qui le possède).
 *  - La caméra se CENTRE sur ce token (MJ uniquement, pour piloter la vue de table).
 *
 * Raccourci clavier : « . » (Period) passe au tour suivant (réservé au MJ, qui
 * pilote le combat). « , » (Comma) revient au tour précédent (non lié par défaut).
 *
 * Interaction de la barre :
 *  - Poignée (⋮⋮) : glisser pour déplacer (position mémorisée par utilisateur).
 *  - Bouton ⟨ / ⟩ : minimise / ré-étend (état mémorisé par utilisateur).
 */

import { MODULE_ID } from "../const.js";
import { makeNotify } from "../lib/common.js";
import { FloatingBar } from "../lib/floating-bar.js";

const notify = makeNotify("Combat");

const VIDEO_RE = /\.(webm|mp4|m4v|ogv|ogg)$/i;
const MYSTERY_MAN = "icons/svg/mystery-man.svg";

// Réglages & raccourcis clavier de cette fonctionnalité : centralisés dans settings.js.

// ═══════════════════════════════════════════════════════════════════════════════
// OVERLAY
// ═══════════════════════════════════════════════════════════════════════════════
export class CombatOverlay extends FloatingBar {
  static instance = null;

  /** Instancie et démarre l'overlay (idempotent). Appelé selon le réglage d'activation. */
  static start() {
    if (this.instance) return;
    this.instance = new this();
    this.instance.init();
  }

  /** Fait avancer le combat actif d'un pas (MJ seulement). Renvoie true si consommé. */
  static advanceTurn(dir) {
    // Ne pas capter la touche quand on tape dans un champ (saisie d'initiative).
    const ae = document.activeElement;
    if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable)) return false;

    const combat = game.combats?.active;
    if (!combat || !game.user.isGM) return false;
    if (dir < 0) combat.previousTurn();
    else combat.nextTurn();
    return true;
  }

  /** Place le focus dans le champ PV du panneau cible (raccourci « / »). */
  static focusHp() {
    const inst = CombatOverlay.instance;
    if (!inst?.root) return false;
    // Ne pas capter la touche quand on tape déjà dans un champ.
    const ae = document.activeElement;
    if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable)) return false;
    // AoE (≥2 cibles) : champ partagé. Sinon : édition inline du badge PV.
    const shared = inst.root.querySelector(".co-hp-edit");
    if (shared) { shared.focus(); shared.select?.(); return true; }
    const badge = inst.root.querySelector(".co-target .co-stat-hp.co-stat-editable");
    if (badge) {
      const token = canvas.tokens?.get(badge.dataset.tokenId);
      if (token) { inst.beginHpEdit(token, badge); return true; }
    }
    notify.warn("Aucune cible : cible un token (T) ou sélectionne-le.");
    return false;
  }

  constructor() {
    super("combat");
    this.editMode = false;              // édition manuelle de l'init en cours de combat (bouton ⋮)
    this._lastTurnId = null;            // id du combattant courant au dernier rendu
    this._lastVisibleCurrentId = null;  // dernier combattant courant VISIBLE (pour ce user)
    // Regroupe les rafales de hooks (création multiple de combattants, etc.).
    this.sync = foundry.utils.debounce(this._sync.bind(this), 30);
  }

  get root() { return this.el; }
  set root(v) { this.el = v; }

  get combat() { return game.combats?.active ?? null; }

  // ── Cycle de vie ─────────────────────────────────────────────────────────
  init() {
    this.registerHooks();
    this.attachViewportHandlers();
    this.sync();
    notify.info("Overlay de combat prêt.");
  }

  registerHooks() {
    const rerender = () => this.sync();
    this.hookIds.createCombat      = Hooks.on("createCombat", rerender);
    this.hookIds.deleteCombat      = Hooks.on("deleteCombat", rerender);
    this.hookIds.updateCombat      = Hooks.on("updateCombat", rerender);
    this.hookIds.createCombatant   = Hooks.on("createCombatant", rerender);
    this.hookIds.updateCombatant   = Hooks.on("updateCombatant", rerender);
    this.hookIds.deleteCombatant   = Hooks.on("deleteCombatant", rerender);
    // Filet de sécurité : se re-synchronise chaque fois que le tracker natif se
    // rafraîchit — notamment quand un combattant caché redevient visible (la donnée
    // n'était pas synchronisée côté joueur, aucun hook de combattant ne s'y déclenche).
    this.hookIds.renderCombatTracker = Hooks.on("renderCombatTracker", rerender);
    // Bascule de visibilité côté token (hidden) → rafraîchit aussi.
    this.hookIds.updateToken = Hooks.on("updateToken", (doc, changes) => {
      if ("hidden" in changes) rerender();
    });
    // Panneau cible : se rafraîchit quand la cible (T) ou la sélection changent,
    // et quand les PV d'un acteur bougent (badges CA/PV à jour).
    this.hookIds.targetToken  = Hooks.on("targetToken", rerender);
    this.hookIds.controlToken = Hooks.on("controlToken", rerender);
    // Ne resync que si l'acteur modifié participe au combat (symétrique d'updateToken).
    this.hookIds.updateActor  = Hooks.on("updateActor", (actor) => {
      if (this.combat?.combatants?.some(c => c.actorId === actor.id)) rerender();
    });
  }

  // destroy() : hérité de FloatingBar.

  // ── Décision d'affichage ────────────────────────────────────────────────
  _sync() {
    const combat = this.combat;
    const visible = combat?.combatants?.size ? this.visibleCombatants(combat).length > 0 : false;

    if (!visible) {
      this._lastTurnId = null;
      this._lastVisibleCurrentId = null;
      this.editMode = false;
      if (this.root) this.root.style.display = "none";
      return;
    }

    // Le mode édition n'a de sens qu'une fois le combat lancé.
    if (!combat.started) this.editMode = false;

    this.mount();
    this.root.style.display = "";
    this.render(combat);

    // Changement de tour → sélection + centrage sur le token courant.
    const currentId = combat.started ? (combat.combatant?.id ?? null) : null;
    if (currentId && currentId !== this._lastTurnId) this.onTurnChange(combat.combatant);
    this._lastTurnId = currentId;
  }

  /** Combattants pertinents pour l'utilisateur (le MJ voit les cachés, pas les joueurs). */
  visibleCombatants(combat) {
    return combat.turns.filter(c => game.user.isGM || !c.hidden);
  }

  // ── Construction du conteneur (une seule fois) ───────────────────────────
  mount() {
    if (this.root) return;

    const root = document.createElement("div");
    root.id = "combat-overlay";
    this.root = root;
    document.body.appendChild(root);

    this.applySizes();
    this.applyDock();
    if (localStorage.getItem(this.collapsedKey) === "1") root.classList.add("co-collapsed");
  }

  // ── Rendu ────────────────────────────────────────────────────────────────
  /**
   * Deux vues selon la phase :
   *  - « setup » (préparation, ou édition manuelle en cours de combat) : liste large
   *    avec initiative éditable + contrôles de mise en place.
   *  - « combat » : rail fin de vignettes + carte du courant (et de la cible).
   */
  render(combat) {
    const root = this.root;

    // Ne pas reconstruire pendant une saisie (init / PV) : éviter la perte de focus
    // quand un autre client déclenche un rafraîchissement.
    const active = document.activeElement;
    if (active && root.contains(active) &&
        (active.classList.contains("co-init-edit") || active.classList.contains("co-hp-edit"))) return;

    const started = !!combat.started;
    const editing = started && this.editMode;
    const setupView = !started || editing;

    // Réglages d'image lus une seule fois par rendu (utilisés par combattant ensuite).
    this._showImages = game.settings.get(MODULE_ID, "showImages");
    this._imageMode  = game.settings.get(MODULE_ID, "imageMode");           // vignettes de la liste / rail
    this._featuredImageMode = game.settings.get(MODULE_ID, "featuredImageMode"); // courant + cibles
    // Disposition du courant : « en place » dans la liste (défaut) ou colonne à droite.
    this._inlineCurrent = game.settings.get(MODULE_ID, "combatCurrentInline");

    root.classList.toggle("co-noimg", !this._showImages);
    root.classList.toggle("co-setup", setupView);
    root.classList.toggle("co-combat", !setupView);

    root.innerHTML = "";
    root.appendChild(this.renderHeader(combat, started, editing));

    const visible = this.visibleCombatants(combat);
    const markerId = this.resolveMarkerId(combat, visible);

    // Boutons de tour (précédent/suivant) sur leur propre ligne sous l'en-tête,
    // si l'option est activée (MJ, hors mode préparation/édition).
    if (!setupView && game.user.isGM && game.settings.get(MODULE_ID, "showNextButton")) {
      root.appendChild(this.renderCombatNav(combat));
    }

    const body = document.createElement("div");
    body.className = "co-body co-collapsible";

    if (setupView) {
      body.appendChild(this.renderEditList(visible, markerId));
    } else {
      body.appendChild(this.renderRail(visible, markerId));
      if (this._inlineCurrent) {
        // Cibles flottantes accolées à droite de l'image du courant.
        const float = this.renderFloatingTargets();
        if (float) body.appendChild(float);
      } else {
        // Ancien affichage : carte du courant + cibles dans une colonne à droite.
        const detail = this.renderDetail(visible, markerId);
        if (detail) body.appendChild(detail);
      }
    }

    root.appendChild(body);

    // L'innerHTML vient d'être reconstruit (dimensions modifiées) : ré-ancrer.
    this.applyDock();

    // Le panneau flottant est positionné après attache au DOM et ré-ancrage
    // (la mesure de layout doit refléter la position/taille finales).
    if (!setupView && this._inlineCurrent) this.positionFloatingTargets();
  }

  /**
   * Marqueur ▶ : combattant courant s'il est visible. Si le courant est caché
   * (monstre invisible côté joueur), on conserve le dernier courant visible.
   */
  resolveMarkerId(combat, visible) {
    const visibleIds = new Set(visible.map(c => c.id));
    const actualCurrentId = combat.started ? (combat.combatant?.id ?? null) : null;
    if (actualCurrentId && visibleIds.has(actualCurrentId)) {
      this._lastVisibleCurrentId = actualCurrentId;
      return actualCurrentId;
    }
    if (combat.started && visibleIds.has(this._lastVisibleCurrentId)) return this._lastVisibleCurrentId;
    return null;
  }

  renderHeader(combat, started, editing) {
    const header = document.createElement("div");
    header.className = "co-header";

    header.appendChild(this.makeHandle("co-handle", "Glisser pour déplacer · clic droit : réglages"));

    const round = document.createElement("div");
    round.className = "co-round";
    round.textContent = !started ? "Préparation" : (editing ? `Édition · Round ${combat.round}` : `Round ${combat.round}`);
    header.appendChild(round);

    // Combat : bouton d'options ⋮ (bascule combat ↔ édition). Les boutons de tour
    // (précédent/suivant) sont sur leur propre ligne sous l'en-tête (renderCombatNav).
    if (game.user.isGM && started) {
      const edit = this.makeBtn("fas fa-sliders", editing ? "Revenir au combat" : "Modifier l'initiative / options", () => this.toggleEdit());
      edit.classList.toggle("co-active", editing);
      header.appendChild(edit);
    }

    // Toggle minimiser (toujours à droite).
    const toggle = document.createElement("div");
    toggle.className = "co-toggle";
    const collapsed = this.root.classList.contains("co-collapsed");
    toggle.dataset.tooltip = collapsed ? "Ré-étendre" : "Minimiser";
    toggle.innerHTML = `<i class="fas fa-chevron-${collapsed ? "down" : "up"}"></i>`;
    toggle.addEventListener("click", () => this.toggleCollapsed());
    header.appendChild(toggle);

    return header;
  }

  // ── Vue « setup » : liste large, initiative éditable ──────────────────────
  renderEditList(visible, markerId) {
    const wrap = document.createElement("div");
    wrap.className = "co-editlist";

    // Contrôles fixes en haut, puis la liste des combattants (seule à défiler).
    const ctl = this.renderSetupControls();
    if (ctl) wrap.appendChild(ctl);

    const rows = document.createElement("div");
    rows.className = "co-erows";
    for (const c of visible) {
      const row = document.createElement("div");
      row.className = "co-erow";
      row.classList.toggle("co-current", c.id === markerId);
      row.classList.toggle("co-pc", !c.isNPC);
      row.classList.toggle("co-npc", c.isNPC);
      row.classList.toggle("co-hidden", !!c.hidden);
      row.classList.toggle("co-dead", this.combatantDead(c));
      row.dataset.combatantId = c.id;

      row.appendChild(this.thumbEl(c, { ember: c.id === markerId }));

      const name = document.createElement("div");
      name.className = "co-ename";
      name.textContent = c.name;
      row.appendChild(name);

      row.appendChild(this.renderInit(c));

      row.addEventListener("click", (ev) => { if (ev.target.closest("input")) return; this.focusToken(c); });
      row.addEventListener("dblclick", (ev) => { if (ev.target.closest("input")) return; this.openSheet(c); });
      rows.appendChild(row);
    }
    wrap.appendChild(rows);
    return wrap;
  }

  /** Contrôles de mise en place (MJ) : 3 petits boutons icônes sur une ligne (tooltip). */
  renderSetupControls() {
    if (!game.user.isGM) return null;
    const combat = this.combat;
    if (!combat) return null;

    const ctl = document.createElement("div");
    ctl.className = "co-ctl";
    ctl.appendChild(this.makeBtn("fas fa-dice-d20", "Rouler l'init des monstres", () => combat.rollNPC()));
    if (!combat.started) {
      const start = this.makeBtn("fas fa-play", "Commencer le combat", () => combat.startCombat());
      start.classList.add("co-btn-start");
      ctl.appendChild(start);
    } else {
      const end = this.makeBtn("fas fa-flag-checkered", "Terminer le combat", () => this.endCombat(combat));
      end.classList.add("co-btn-end");
      ctl.appendChild(end);
    }
    return ctl;
  }

  toggleEdit() {
    this.editMode = !this.editMode;
    if (this.combat) this.render(this.combat);
  }

  /** Ligne de navigation de tour (précédent + suivant) sous l'en-tête (option MJ). */
  renderCombatNav(combat) {
    const nav = document.createElement("div");
    nav.className = "co-nav co-collapsible";
    nav.appendChild(this.makeBtn("fas fa-backward-step", "Tour précédent ( , )", () => combat.previousTurn()));
    nav.appendChild(this.makeBtn("fas fa-forward-step", "Tour suivant ( . )", () => combat.nextTurn()));
    return nav;
  }

  // ── Vue « combat » : rail fin + carte de détail ───────────────────────────
  renderRail(visible, markerId) {
    const rail = document.createElement("div");
    rail.className = "co-rail";
    const showInit = !game.settings.get(MODULE_ID, "hideInitInCombat");

    for (const c of visible) {
      const isCurrent = c.id === markerId;

      // Mode SANS portraits : chaque combattant en carte texte (nom + CA/PV),
      // le courant surligné — plutôt qu'une pastille d'initiales + anneau PV.
      if (!this._showImages) {
        rail.appendChild(this.renderListCard(c, isCurrent, showInit));
        continue;
      }

      // Mode « courant en place » : le combattant à son tour s'agrandit
      // directement dans la liste (portrait + nom + stats).
      if (this._inlineCurrent && isCurrent) {
        rail.appendChild(this.renderRailCurrentCard(c));
        continue;
      }

      const item = document.createElement("div");
      item.className = "co-thumbwrap";
      item.classList.toggle("co-current", isCurrent);
      item.classList.toggle("co-pc", !c.isNPC);
      item.classList.toggle("co-npc", c.isNPC);
      item.classList.toggle("co-hidden", !!c.hidden);
      item.classList.toggle("co-dead", this.combatantDead(c));
      item.dataset.combatantId = c.id;

      item.appendChild(this.thumbEl(c, { ember: isCurrent }));
      // Init affichée À CÔTÉ de la vignette (liste large), pas en surimpression.
      if (showInit) item.appendChild(this.initLabel(c));

      item.dataset.tooltip = c.name;
      item.addEventListener("click", () => this.focusToken(c));
      item.addEventListener("dblclick", () => this.openSheet(c));
      rail.appendChild(item);
    }
    return rail;
  }

  /** Petite étiquette d'initiative affichée à côté d'un combattant (or, tabulaire). */
  initLabel(c) {
    const hasInit = c.initiative !== null && c.initiative !== undefined;
    const el = document.createElement("div");
    el.className = "co-init-side";
    el.textContent = hasInit ? c.initiative : "–";
    return el;
  }

  /**
   * Carte texte d'un combattant pour le mode SANS portraits : nom (+ init à côté)
   * et badges CA/PV (MJ). Le courant reçoit le style de carte surlignée.
   */
  renderListCard(c, isCurrent, showInit) {
    const card = document.createElement("div");
    card.className = "co-card co-list-card";
    card.classList.toggle("co-current-card", isCurrent);
    card.classList.toggle("co-pc", !c.isNPC);
    card.classList.toggle("co-npc", c.isNPC);
    card.classList.toggle("co-hidden", !!c.hidden);
    card.classList.toggle("co-dead", this.combatantDead(c));
    card.dataset.combatantId = c.id;

    const head = document.createElement("div");
    head.className = "co-list-head";
    if (showInit) head.appendChild(this.initLabel(c));
    const name = document.createElement("div");
    name.className = "co-card-name";
    name.textContent = this.combatantDead(c) ? `☠ ${c.name}` : c.name;
    head.appendChild(name);
    card.appendChild(head);

    if (game.user.isGM) {
      const stats = this.actorStats(c.actor);
      if (stats.length) {
        const meta = document.createElement("div");
        meta.className = "co-card-stats";
        for (const s of stats) meta.appendChild(this.statBadge(s));
        card.appendChild(meta);
      }
    }

    card.addEventListener("click", () => this.focusToken(c));
    card.addEventListener("dblclick", () => this.openSheet(c));
    return card;
  }

  /**
   * Carte du courant insérée EN PLACE dans le rail (variante) : réutilise la carte
   * du courant, taggée pour la mettre en forme au sein de la liste.
   */
  renderRailCurrentCard(c) {
    const card = this.renderCurrentCard(c);
    card.classList.add("co-current-inline");
    return card;
  }

  /**
   * Panneau de détail à côté du rail (mode « colonne à droite » uniquement) :
   * carte du courant + panneau cible.
   */
  renderDetail(visible, markerId) {
    const detail = document.createElement("div");
    detail.className = "co-detail";

    const featured = markerId ? visible.find(c => c.id === markerId) : null;
    if (featured) detail.appendChild(this.renderCurrentCard(featured));

    const victims = this.resolveVictims();
    if (victims.length) detail.appendChild(this.renderTargetPanel(victims));

    return detail.children.length ? detail : null;
  }

  /** Panneau cible flottant, accolé à droite de l'image du courant (mode « en place »). */
  renderFloatingTargets() {
    const victims = this.resolveVictims();
    if (!victims.length) return null;
    const panel = this.renderTargetPanel(victims);
    panel.classList.add("co-targets-float");
    return panel;
  }

  /**
   * Positionne le panneau cible flottant (mode « en place ») à droite du rail,
   * aligné sur le HAUT de la carte du courant. S'il déborde sous le bas STRICT du
   * rail, on le remonte pour aligner son bas sur le bas du rail. Exception : si le
   * panneau est plus haut que le rail, on garde l'alignement haut et on le laisse
   * dépasser en bas. Positionnement absolu relatif au root (position: fixed), donc
   * hors du clip du rail (overflow) et insensible au glissement horizontal.
   */
  positionFloatingTargets() {
    const root = this.root;
    const panel = root?.querySelector(".co-targets-float");
    if (!panel) return;
    const rail = root.querySelector(".co-rail");
    if (!rail) { panel.remove(); return; }
    // Ancre verticale : la carte du courant si présente, sinon le rail lui-même.
    const anchor = root.querySelector(".co-current-inline") ?? rail;

    const rootRect = root.getBoundingClientRect();
    const railRect = rail.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    const gap = 4;

    // Horizontale : accolé au bord droit du rail.
    panel.style.left = `${railRect.right - rootRect.left + gap}px`;

    // Verticale : haut de la carte par défaut ; si ça déborde sous le bas du rail
    // ET que le panneau tient dans le rail, on aligne son bas sur celui du rail.
    const panelH = panel.offsetHeight;
    let topVp = anchorRect.top;
    if (panelH <= railRect.height && topVp + panelH > railRect.bottom) {
      topVp = railRect.bottom - panelH;
    }
    panel.style.top = `${topVp - rootRect.top}px`;
  }

  /** Carte du combattant courant : grand portrait + nom + stats (remplace le spotlight). */
  renderCurrentCard(c) {
    const card = document.createElement("div");
    card.className = "co-card co-current-card";
    card.classList.toggle("co-pc", !c.isNPC);
    card.classList.toggle("co-npc", c.isNPC);
    card.dataset.combatantId = c.id;

    if (this._showImages) {
      const p = document.createElement("div");
      p.className = "co-portrait";
      const img = document.createElement("img");
      img.src = this.imgFor(c, this._featuredImageMode);
      img.alt = c.name;
      p.appendChild(img);
      card.appendChild(p);
    }

    const name = document.createElement("div");
    name.className = "co-card-name";
    name.textContent = c.name;
    card.appendChild(name);

    if (game.user.isGM) {
      const stats = this.actorStats(c.actor);
      if (stats.length) {
        const meta = document.createElement("div");
        meta.className = "co-card-stats";
        for (const s of stats) meta.appendChild(this.statBadge(s));
        card.appendChild(meta);
      }
    }

    card.addEventListener("click", () => this.focusToken(c));
    card.addEventListener("dblclick", () => this.openSheet(c));
    return card;
  }

  statBadge(s) {
    const badge = document.createElement("span");
    badge.className = `co-stat co-stat-${s.key}`;
    badge.innerHTML = `<i class="${s.icon}"></i>`;
    badge.appendChild(document.createTextNode(` ${s.value}`));
    return badge;
  }

  // ── Vignette commune (rail + liste) : anneau PV + image ou initiales ───────
  thumbEl(c, opts = {}) {
    const wrap = document.createElement("div");
    wrap.className = "co-thumb";

    const ratio = this.hpRatioOf(c.actor);
    if (ratio !== null) {
      const ring = document.createElement("div");
      ring.className = "co-ring";
      const deg = Math.round(ratio * 360);
      ring.style.background = `conic-gradient(${this.hpColor(c.actor)} ${deg}deg, rgba(255,255,255,.12) ${deg}deg)`;
      wrap.appendChild(ring);
    }
    if (opts.ember) { const e = document.createElement("div"); e.className = "co-ember"; wrap.appendChild(e); }
    if (opts.target) { const t = document.createElement("div"); t.className = "co-tgtring"; wrap.appendChild(t); }

    const face = document.createElement("div");
    face.className = "co-face";
    if (this._showImages) {
      const img = document.createElement("img");
      img.src = this.imgFor(c, this._imageMode);
      img.alt = c.name;
      face.appendChild(img);
    } else {
      face.textContent = this.combatantDead(c) ? "☠" : this.initialsOf(c.name);
    }
    wrap.appendChild(face);
    return wrap;
  }

  hpRatioOf(actor) {
    const hp = actor?.system?.attributes?.hp;
    if (!hp || !Number.isFinite(hp.max) || hp.max <= 0) return null;
    const v = Number.isFinite(hp.value) ? hp.value : hp.max;
    return Math.max(0, Math.min(1, v / hp.max));
  }

  hpColor(actor) {
    if (this.actorHasDead(actor)) return "#5b6270";
    const r = this.hpRatioOf(actor);
    if (r === null) return "#5b9bd8";
    return r > 0.5 ? "#4cc96a" : r > 0.25 ? "#e8b04b" : "#e05a5a";
  }

  /** L'acteur porte-t-il le statut « dead » via l'un de ses effets ? (prédicat partagé) */
  actorHasDead(actor) {
    return actor?.effects?.some(e => e.statuses?.has("dead") || e.flags?.core?.statusId === "dead") ?? false;
  }

  combatantDead(c) {
    const tok = c.token?.object;
    if (tok && tok.document?.statuses?.has("dead")) return true;
    return this.actorHasDead(c.actor);
  }

  initialsOf(name) {
    const n = String(name || "?").trim();
    const p = n.split(/\s+/);
    return (p.length > 1 ? p[0][0] + p[1][0] : n.slice(0, 2)).toUpperCase();
  }

  /** Victimes qui recevront les PV : cibles (T) en priorité, sinon sélection. */
  resolveVictims() {
    const targets = Array.from(game.user.targets ?? []);
    if (targets.length) return targets;
    return Array.from(canvas.tokens?.controlled ?? []);
  }

  /** Panneau cible : vignette(s) + CA/PV + champ PV partagé (applique à toutes). */
  renderTargetPanel(victims) {
    const panel = document.createElement("div");
    panel.className = "co-targets";

    const title = document.createElement("div");
    title.className = "co-targets-title";
    title.innerHTML = `<i class="fas fa-crosshairs"></i> ${victims.length > 1 ? `Cibles (${victims.length})` : "Cible"}`;
    panel.appendChild(title);

    const list = document.createElement("div");
    list.className = "co-target-list";
    for (const token of victims) list.appendChild(this.renderTargetCard(token));
    panel.appendChild(list);

    // Champ delta partagé : uniquement en AoE (≥2 cibles). En solo, on édite
    // directement le badge PV de la cible (clic ou raccourci « / »).
    if (victims.length >= 2) {
      const input = document.createElement("input");
      input.className = "co-hp-edit";
      input.type = "text";
      input.inputMode = "numeric";
      input.placeholder = "Δ PV  ( / )";
      input.dataset.tooltip = "8 = dégâts · +8 = soin · Entrée = toutes les cibles";
      input.addEventListener("click", (ev) => ev.stopPropagation());
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          const value = input.value;
          input.value = "";
          this.applyHpToVictims(value).finally(() => input.blur());
        } else if (ev.key === "Escape") {
          input.value = "";
          input.blur();
        }
      });
      panel.appendChild(input);
    }
    return panel;
  }

  /** Une vignette de cible : image + nom + badges CA/PV (MJ). */
  renderTargetCard(token) {
    const card = document.createElement("div");
    card.className = "co-target";
    const isNPC = !token.actor?.hasPlayerOwner;
    card.classList.toggle("co-pc", !isNPC);
    card.classList.toggle("co-npc", isNPC);

    // Mode SANS portraits : pas de pastille d'initiales, juste nom + CA/PV.
    if (this._showImages) {
      const img = document.createElement("img");
      img.className = "co-target-img";
      img.src = this.imgForToken(token, this._featuredImageMode);
      img.alt = token.name;
      card.appendChild(img);
    }

    const name = document.createElement("div");
    name.className = "co-target-name";
    name.textContent = token.name;
    card.appendChild(name);

    // CA / PV sous la cible (MJ uniquement).
    if (game.user.isGM) {
      const stats = this.actorStats(token.actor);
      if (stats.length) {
        const meta = document.createElement("div");
        meta.className = "co-target-stats co-card-stats";
        for (const s of stats) {
          const badge = this.statBadge(s);
          // Badge PV cliquable → édition inline du delta (si on possède l'acteur).
          if (s.key === "hp" && token.actor?.isOwner) {
            badge.classList.add("co-stat-editable");
            badge.dataset.tokenId = token.id;
            badge.dataset.tooltip = "Clic : modifier les PV (8 = dégâts, +8 = soin)";
            badge.addEventListener("click", (ev) => { ev.stopPropagation(); this.beginHpEdit(token, badge); });
          }
          meta.appendChild(badge);
        }
        card.appendChild(meta);
      }
    }

    // Double-clic → feuille de l'acteur (pas de clic simple : ne pas voler la sélection).
    card.addEventListener("dblclick", () => {
      if (token.actor?.testUserPermission(game.user, "LIMITED")) token.actor.sheet?.render(true);
    });
    return card;
  }

  /**
   * Interprète une saisie PV (convention TokenHp.js : « 8 » = dégâts, « +8 » =
   * soin, « -8 » = dégâts) et renvoie le delta signé (négatif = dégâts), ou
   * null si vide / invalide / nul.
   */
  parseHpDelta(rawValue) {
    const raw = String(rawValue).trim();
    if (!raw) return null;
    const hasSign = raw.startsWith("+") || raw.startsWith("-");
    const parsed = parseInt(raw, 10);
    if (Number.isNaN(parsed)) { notify.warn("Valeur PV invalide (ex : 8, +8, -8)."); return null; }
    const delta = hasSign ? parsed : -Math.abs(parsed);
    return delta === 0 ? null : delta;
  }

  /**
   * Applique un delta PV à un seul token via le moteur natif dnd5e (applyDamage
   * gère les PV temporaires) et met à jour le statut Dead. Renvoie
   * { before, after, died } ou null si l'application a échoué / été refusée.
   */
  async applyDeltaToToken(token, delta) {
    const actor = token.actor;
    if (!actor) { notify.warn(`"${token.name}" sans acteur, ignoré.`); return null; }
    if (typeof actor.applyDamage !== "function") { notify.warn(`applyDamage indisponible sur "${token.name}".`); return null; }
    if (!actor.isOwner) { notify.warn(`Pas de permission sur "${token.name}".`); return null; }
    const before = actor.system?.attributes?.hp?.value;
    try {
      await actor.applyDamage(-delta); // applyDamage : positif = dégâts.
      const after = actor.system?.attributes?.hp?.value;
      // Statut Dead auto : appliqué si le solde < 1, retiré si les PV remontent.
      const dying = Number(after) < 1;
      const wasDead = this.hasDeadStatus(token);
      let died = false;
      if (dying && !wasDead) { await this.setDeadStatus(token, true); died = true; }
      else if (!dying && wasDead) await this.setDeadStatus(token, false);
      return { before, after, died };
    } catch (err) {
      notify.warn(`Échec PV sur "${token.name}".`);
      console.error(err);
      return null;
    }
  }

  /** Applique une saisie PV à un seul token (édition inline du badge PV). */
  async applyHpToOne(token, rawValue) {
    const delta = this.parseHpDelta(rawValue);
    if (delta === null) return;
    const res = await this.applyDeltaToToken(token, delta);
    if (!res) return;
    notify.info(`${delta < 0 ? "💀 Dégâts" : "💚 Soin"} [${delta > 0 ? "+" : ""}${delta}] : ${token.name} ${res.before}→${res.after}`);
    if (res.died) notify.warn(`☠️ Mort : ${token.name}`);
  }

  /** Applique une saisie PV partagée à toutes les victimes (AoE, champ ≥2 cibles). */
  async applyHpToVictims(rawValue) {
    const delta = this.parseHpDelta(rawValue);
    if (delta === null) return;
    const victims = this.resolveVictims();
    if (!victims.length) { notify.warn("Aucune cible."); return; }

    const log = [];
    const dead = [];
    for (const token of victims) {
      const res = await this.applyDeltaToToken(token, delta);
      if (!res) continue;
      log.push(`${token.name}: ${res.before}→${res.after}`);
      if (res.died) dead.push(token.name);
    }
    if (log.length) notify.info(`${delta < 0 ? "💀 Dégâts" : "💚 Soin"} [${delta > 0 ? "+" : ""}${delta}] : ${log.join(" | ")}`);
    if (dead.length) notify.warn(`☠️ Mort : ${dead.join(", ")}`);
  }

  /**
   * Bascule un badge PV en champ de saisie inline (delta) pour ce token.
   * Entrée applique, Échap/blur annule. Réutilise la classe .co-hp-edit pour
   * bénéficier de la garde anti-reconstruction pendant l'édition.
   */
  beginHpEdit(token, badge) {
    if (!badge || badge.querySelector("input")) return;
    const original = badge.innerHTML;
    const input = document.createElement("input");
    input.className = "co-hp-edit co-hp-inline";
    input.type = "text";
    input.inputMode = "numeric";
    input.placeholder = "±PV";
    input.dataset.tooltip = "8 = dégâts · +8 = soin · Entrée pour appliquer";
    input.addEventListener("click", (ev) => ev.stopPropagation());
    input.addEventListener("blur", () => { badge.innerHTML = original; }, { once: true });
    input.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Enter") {
        ev.preventDefault();
        const value = input.value;
        input.blur(); // restaure le badge ; la MàJ acteur déclenchera un re-render.
        this.applyHpToOne(token, value);
      } else if (ev.key === "Escape") {
        input.blur();
      }
    });
    badge.innerHTML = "";
    badge.appendChild(input);
    input.focus();
    input.select?.();
  }

  /** Le token (ou son acteur) porte-t-il le statut « dead » ? */
  hasDeadStatus(token) {
    if (token.document?.statuses?.has("dead")) return true;
    return this.actorHasDead(token.actor);
  }

  /**
   * Applique / retire le statut « dead » (overlay tête de mort) sur l'acteur du token.
   * Repris de TokenHp.js, priorité à l'API moderne dnd5e/Foundry v14.
   */
  async setDeadStatus(token, active) {
    const actor = token.actor;
    if (!actor) return;
    // Foundry v11+/dnd5e : voie canonique.
    if (typeof actor.toggleStatusEffect === "function") {
      await actor.toggleStatusEffect("dead", { active, overlay: active });
      return;
    }
    // Fallback : ActiveEffect manuel.
    const existing = actor.effects.find(
      e => e.statuses?.has("dead") || e.flags?.core?.statusId === "dead"
    );
    if (active && !existing) {
      const effectData = CONFIG.statusEffects.find(e => e.id === "dead")
        ?? { name: "Dead", img: "icons/svg/skull.svg" };
      await actor.createEmbeddedDocuments("ActiveEffect", [{
        name: effectData.name ?? "Dead",
        img:  effectData.img  ?? "icons/svg/skull.svg",
        statuses: ["dead"],
        flags: { core: { statusId: "dead", overlay: true } },
      }]);
    } else if (!active && existing) {
      await existing.delete();
    }
  }

  renderInit(c) {
    const hasInit = c.initiative !== null && c.initiative !== undefined;
    if (c.isOwner) {
      const input = document.createElement("input");
      input.className = "co-init co-init-edit";
      input.type = "number";
      input.value = hasInit ? c.initiative : "";
      input.placeholder = "–";
      input.dataset.tooltip = "Initiative (Entrée pour valider)";
      input.addEventListener("click", (ev) => ev.stopPropagation());
      input.addEventListener("change", () => this.setInit(c, input.value));
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") { ev.preventDefault(); input.blur(); }
      });
      return input;
    }
    const span = document.createElement("div");
    span.className = "co-init";
    span.textContent = hasInit ? c.initiative : "–";
    return span;
  }

  /** Stats MJ à afficher pour un acteur (dnd5e), tolérant aux données manquantes. */
  actorStats(actor) {
    const sys = actor?.system;
    if (!sys) return [];
    const out = [];
    const ac = sys.attributes?.ac?.value;
    if (Number.isFinite(ac)) out.push({ key: "ac", icon: "fas fa-shield-halved", value: ac });
    const hp = sys.attributes?.hp;
    if (hp && (Number.isFinite(hp.value) || Number.isFinite(hp.max))) {
      out.push({ key: "hp", icon: "fas fa-heart", value: `${hp.value ?? "?"}/${hp.max ?? "?"}` });
    }
    // PV temporaires (dnd5e : hp.temp) — badge séparé à droite des PV, si présents.
    if (Number.isFinite(hp?.temp) && hp.temp > 0) {
      out.push({ key: "thp", icon: "fas fa-shield-heart", value: `+${hp.temp}` });
    }
    return out;
  }

  makeBtn(iconClass, tooltip, onClick) {
    const btn = document.createElement("div");
    btn.className = "co-btn";
    btn.dataset.tooltip = tooltip;
    btn.innerHTML = `<i class="${iconClass}"></i>`;
    btn.addEventListener("click", (ev) => { ev.preventDefault(); onClick(); });
    return btn;
  }

  // ── Données ────────────────────────────────────────────────────────────
  /**
   * Choisit la source d'image (token ou acteur) selon le `mode` fourni
   * (« token » | « actor »), avec repli si vidéo/manquante. Le mode diffère selon
   * le contexte : vignettes de la liste (this._imageMode) vs courant/cibles
   * (this._featuredImageMode).
   */
  pickImg(tokenSrc, actorSrc, mode) {
    let src = mode === "token" ? (tokenSrc || actorSrc) : (actorSrc || tokenSrc);
    if (!src || VIDEO_RE.test(src)) {
      const alt = mode === "token" ? actorSrc : tokenSrc;
      src = (alt && !VIDEO_RE.test(alt)) ? alt : MYSTERY_MAN;
    }
    return src;
  }

  /** Image d'un combattant (`mode` : celui de la liste ou du courant selon l'appelant). */
  imgFor(c, mode) { return this.pickImg(c.token?.texture?.src || c.img, c.actor?.img, mode); }

  /** Image d'un Token placé sur la scène (cible / sélection). */
  imgForToken(token, mode) { return this.pickImg(token.document?.texture?.src, token.actor?.img, mode); }

  /** Termine et clôture le combat après confirmation (MJ). */
  async endCombat(combat) {
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: "Terminer le combat" },
      content: "<p>Terminer et clôturer ce combat ?</p>",
      rejectClose: false,
      modal: true,
    });
    if (!ok) return;
    try {
      await combat.delete();
    } catch (err) {
      notify.warn("Impossible de terminer le combat.");
      console.error(err);
    }
  }

  async setInit(c, value) {
    const trimmed = String(value).trim();
    const num = trimmed === "" ? null : Number(trimmed);
    if (num !== null && Number.isNaN(num)) { notify.warn("Initiative invalide."); return; }
    try {
      await c.update({ initiative: num });
    } catch (err) {
      notify.warn("Impossible de modifier l'initiative.");
      console.error(err);
    }
  }

  // ── Automatisations de tour ──────────────────────────────────────────────
  onTurnChange(combatant) {
    const token = combatant?.token?.object;
    if (!token) return;

    if (game.settings.get(MODULE_ID, "autoControlToken") && token.isOwner) {
      try {
        // La sélection est plus visible si la couche Tokens est active, MAIS on ne
        // sort JAMAIS l'utilisateur d'une couche de dessin (Regions/Drawings) :
        // il peut être en train de tracer un gabarit/dessin. token.control() suffit
        // à sélectionner (et la token bar suit) même sans changer de couche.
        const drawing = [canvas.regions, canvas.drawings].filter(Boolean);
        if (canvas.tokens && canvas.activeLayer !== canvas.tokens && !drawing.includes(canvas.activeLayer)) {
          canvas.tokens.activate();
        }
        token.control({ releaseOthers: true });
      } catch (e) { console.warn("[Combat Overlay] control:", e); }
    }
    if (game.settings.get(MODULE_ID, "autoPanToken") && game.user.isGM) {
      try { canvas.animatePan({ x: token.center.x, y: token.center.y }); } catch (e) { console.warn("[Combat Overlay] pan:", e); }
    }
  }

  /** Double-clic : ouvre la feuille de l'acteur (si l'utilisateur a au moins un accès limité). */
  openSheet(combatant) {
    const actor = combatant?.actor;
    if (!actor?.testUserPermission(game.user, "LIMITED")) return;
    actor.sheet?.render(true);
  }

  /** Clic sur une ligne : sélectionne et centre sur le token si l'utilisateur le possède. */
  focusToken(combatant) {
    const token = combatant?.token?.object;
    if (!token?.isOwner) return;
    try {
      token.control({ releaseOthers: true });
      canvas.animatePan({ x: token.center.x, y: token.center.y });
    } catch (e) { console.warn("[Combat Overlay] focus:", e); }
  }

  // ── Taille / minimiser ───────────────────────────────────────────────────
  applySizes() {
    const row = Number(game.settings.get(MODULE_ID, "rowSize")) || 34;
    const spot = Number(game.settings.get(MODULE_ID, "currentImageSize")) || 140;
    this.root?.style.setProperty("--co-row", `${row}px`);
    this.root?.style.setProperty("--co-spot", `${spot}px`);
  }

  // Minimiser (skeleton dans FloatingBar) : chevron vertical (haut/bas).
  get collapsedClass() { return "co-collapsed"; }

  updateCollapseIcon(on) {
    const icon = this.root.querySelector(".co-toggle i");
    if (icon) icon.className = `fas fa-chevron-${on ? "down" : "up"}`;
    const toggle = this.root.querySelector(".co-toggle");
    if (toggle) toggle.dataset.tooltip = on ? "Ré-étendre" : "Minimiser";
  }

  // Position : héritée de FloatingBar ; seul le défaut change (coin haut-gauche).
  defaultPosition() { return { left: 10, top: 80 }; }

  // Ancrage aux bords : hérité de FloatingBar. Défaut « free » (position libre).
  get dockSettingKey() { return "combatDock"; }
}
