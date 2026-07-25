/**
 * Combat Overlay — Module Foundry VTT v14 · Système dnd5e 5.x
 *
 * Suivi de combat COMPACT superposé à la scène, pensé pour l'écran partagé de la
 * table. Il s'affiche AUTOMATIQUEMENT dès qu'un combat est actif (encounter créé
 * avec au moins un combattant) et reste visible pour TOUS les utilisateurs.
 *
 * Affichage :
 *  - En-tête : « Manche N » (ou « Préparation » avant le début) + boutons MJ.
 *  - Une ligne par combattant : marqueur ▶ sur le courant, portrait (ou image de
 *    token, réglable), nom, initiative. Fond différent PJ / monstre.
 *  - Les combattants cachés ne sont visibles que du MJ (grisés).
 *
 * Automatisations au changement de tour :
 *  - Le token du combattant courant est SÉLECTIONNÉ (pour qui le possède : le MJ
 *    voit chaque token, un joueur voit le sien à son tour).
 *  - La caméra se CENTRE sur ce token (MJ uniquement, pour piloter la vue de table).
 *
 * Aide au MJ en début de combat :
 *  - Bouton « dé » : roule l'initiative de tous les MONSTRES d'un clic (rollNPC).
 *  - Chaque ligne de PJ expose un champ d'initiative éditable → saisie manuelle
 *    rapide au clavier (le MJ possède tout ; un joueur édite la sienne).
 *  - Bouton « play / tour suivant » selon l'état du combat.
 *
 * Raccourci clavier : « . » (Period) passe au tour suivant (réservé au MJ, qui
 * pilote le combat). « , » (Comma) revient au tour précédent (non lié par défaut).
 *
 * Interaction de la barre :
 *  - Poignée (⋮⋮) : glisser pour déplacer (position mémorisée par utilisateur).
 *  - Bouton ⟨ / ⟩ : minimise / ré-étend (état mémorisé par utilisateur).
 */

const MODULE_ID = "arthaks-table-combat-bar";
const NS = MODULE_ID;

const notify = {
  info: (m) => console.log(`[Combat Overlay] ${m}`),
  warn: (m) => { console.warn(`[Combat Overlay] ${m}`); ui.notifications?.warn(m); },
};

const VIDEO_RE = /\.(webm|mp4|m4v|ogv|ogg)$/i;
const MYSTERY_MAN = "icons/svg/mystery-man.svg";

// ═══════════════════════════════════════════════════════════════════════════════
// RÉGLAGES + RACCOURCIS
// ═══════════════════════════════════════════════════════════════════════════════
Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "imageMode", {
    name: "Image des combattants",
    hint: "Portrait de la fiche d'acteur ou image du token placé sur la scène.",
    scope: "world",
    config: true,
    type: String,
    choices: { actor: "Portrait de l'acteur", token: "Image du token" },
    default: "actor",
    onChange: () => CombatOverlay.instance?.sync(),
  });

  game.settings.register(MODULE_ID, "rowSize", {
    name: "Taille des lignes (px)",
    hint: "Hauteur des vignettes des lignes de la liste (petites).",
    scope: "client",
    config: true,
    type: Number,
    default: 34,
    onChange: () => CombatOverlay.instance?.applySizes(),
  });

  game.settings.register(MODULE_ID, "currentImageSize", {
    name: "Taille de l'image du combattant courant (px)",
    hint: "Grande image du combattant courant, affichée à droite de la liste (env. 4 lignes par défaut).",
    scope: "client",
    config: true,
    type: Number,
    default: 140,
    onChange: () => CombatOverlay.instance?.applySizes(),
  });

  game.settings.register(MODULE_ID, "autoControlToken", {
    name: "Sélectionner le token du combattant courant",
    hint: "À chaque changement de tour, sélectionne sur la scène le token du combattant courant (pour l'utilisateur qui le possède).",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });

  game.settings.register(MODULE_ID, "autoPanToken", {
    name: "Centrer la caméra sur le combattant courant (MJ)",
    hint: "À chaque changement de tour, centre la vue du MJ sur le token courant. N'affecte pas la caméra des joueurs.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });

  // « . » : tour suivant (le MJ pilote le combat → raccourci réservé au MJ).
  game.keybindings.register(MODULE_ID, "nextTurn", {
    name: "Combat : tour suivant",
    hint: "Passe au combattant suivant.",
    editable: [{ key: "Period" }],
    restricted: true,
    onDown: () => CombatOverlay.advanceTurn(+1),
  });

  // « , » : tour précédent.
  game.keybindings.register(MODULE_ID, "prevTurn", {
    name: "Combat : tour précédent",
    hint: "Revient au combattant précédent.",
    editable: [{ key: "Comma" }],
    restricted: true,
    onDown: () => CombatOverlay.advanceTurn(-1),
  });

  // « / » : place le curseur dans le champ PV du panneau cible (saisie clavier
  // rapide à la table). Cible : les tokens ciblés (T), sinon le token sélectionné.
  game.keybindings.register(MODULE_ID, "focusHp", {
    name: "Combat : modifier les PV de la cible",
    hint: "Place le curseur dans le champ PV du panneau cible. Entrer « 8 » (dégâts) ou « +8 » (soin), puis Entrée.",
    editable: [{ key: "Slash" }],
    restricted: true,
    onDown: () => CombatOverlay.focusHp(),
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DÉMARRAGE
// ═══════════════════════════════════════════════════════════════════════════════
Hooks.once("ready", () => {
  CombatOverlay.instance = new CombatOverlay();
  CombatOverlay.instance.init();
});

// ═══════════════════════════════════════════════════════════════════════════════
// OVERLAY
// ═══════════════════════════════════════════════════════════════════════════════
class CombatOverlay {
  static instance = null;

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
    this.root = null;
    this.hookIds = {};
    this._lastTurnId = null;            // id du combattant courant au dernier rendu
    this._lastVisibleCurrentId = null;  // dernier combattant courant VISIBLE (pour ce user)
    this.onResize = this.onResize.bind(this);
    // Regroupe les rafales de hooks (création multiple de combattants, etc.).
    this.sync = foundry.utils.debounce(this._sync.bind(this), 30);
  }

  get combat() { return game.combats?.active ?? null; }
  get posKey() { return `${NS}.pos.${game.user.id}`; }
  get collapsedKey() { return `${NS}.collapsed.${game.user.id}`; }

  // ── Cycle de vie ─────────────────────────────────────────────────────────
  init() {
    this.registerHooks();
    window.addEventListener("resize", this.onResize);
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
    this.hookIds.updateActor  = Hooks.on("updateActor", rerender);
  }

  destroy() {
    for (const [hook, id] of Object.entries(this.hookIds)) Hooks.off(hook, id);
    window.removeEventListener("resize", this.onResize);
    this.root?.remove();
    CombatOverlay.instance = null;
  }

  // ── Décision d'affichage ────────────────────────────────────────────────
  _sync() {
    const combat = this.combat;
    const visible = combat?.combatants?.size ? this.visibleCombatants(combat).length > 0 : false;

    if (!visible) {
      this._lastTurnId = null;
      this._lastVisibleCurrentId = null;
      if (this.root) this.root.style.display = "none";
      return;
    }

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
    this.applyPosition();
    if (localStorage.getItem(this.collapsedKey) === "1") root.classList.add("co-collapsed");
  }

  // ── Rendu ────────────────────────────────────────────────────────────────
  render(combat) {
    const root = this.root;

    // Ne pas reconstruire pendant une saisie d'initiative : la mise à jour d'un
    // autre client ne doit pas détruire le champ en cours d'édition (perte de focus).
    const active = document.activeElement;
    if (active && root.contains(active) &&
        (active.classList.contains("co-init-edit") || active.classList.contains("co-hp-edit"))) return;

    root.innerHTML = "";

    // En-tête : poignée + manche + boutons MJ + toggle.
    const header = document.createElement("div");
    header.className = "co-header";

    const handle = document.createElement("i");
    handle.className = "fas fa-grip-vertical co-handle";
    handle.dataset.tooltip = "Glisser pour déplacer";
    this.initDrag(handle);
    header.appendChild(handle);

    const round = document.createElement("div");
    round.className = "co-round";
    round.textContent = combat.started ? `Round ${combat.round}` : "Préparation";
    header.appendChild(round);

    if (game.user.isGM) {
      // Rouler l'initiative des monstres.
      const rollBtn = this.makeBtn("fas fa-dice-d20", "Rouler l'initiative des monstres", () => {
        combat.rollNPC();
      });
      header.appendChild(rollBtn);

      // Commencer / tour suivant selon l'état.
      if (!combat.started) {
        header.appendChild(this.makeBtn("fas fa-play", "Commencer le combat", () => combat.startCombat()));
      } else {
        header.appendChild(this.makeBtn("fas fa-forward-step", "Tour suivant ( . )", () => combat.nextTurn()));
      }

      // Terminer le combat (confirmation).
      const endBtn = this.makeBtn("fas fa-flag-checkered", "Terminer le combat", () => this.endCombat(combat));
      endBtn.classList.add("co-btn-end");
      header.appendChild(endBtn);
    }

    // Toggle minimiser (toujours à droite de l'en-tête).
    const toggle = document.createElement("div");
    toggle.className = "co-toggle";
    const collapsed = root.classList.contains("co-collapsed");
    toggle.dataset.tooltip = collapsed ? "Ré-étendre" : "Minimiser";
    toggle.innerHTML = `<i class="fas fa-chevron-${collapsed ? "down" : "up"}"></i>`;
    toggle.addEventListener("click", () => this.toggleCollapsed());
    header.appendChild(toggle);

    root.appendChild(header);

    // Marqueur ▶ : sur le combattant courant s'il est visible pour cet utilisateur.
    // Si le courant est caché (ex. monstre invisible côté joueur), on CONSERVE le
    // marqueur sur le dernier combattant visible qui l'avait, plutôt que de l'effacer.
    const visible = this.visibleCombatants(combat);
    const visibleIds = new Set(visible.map(c => c.id));
    const actualCurrentId = combat.started ? (combat.combatant?.id ?? null) : null;

    let markerId = null;
    if (actualCurrentId && visibleIds.has(actualCurrentId)) {
      markerId = actualCurrentId;
      this._lastVisibleCurrentId = actualCurrentId;
    } else if (combat.started && visibleIds.has(this._lastVisibleCurrentId)) {
      markerId = this._lastVisibleCurrentId;
    }

    // Corps : liste compacte à gauche, grande image du courant à droite.
    const body = document.createElement("div");
    body.className = "co-body co-collapsible";

    const list = document.createElement("div");
    list.className = "co-list";
    for (const c of visible) {
      list.appendChild(this.renderRow(c, c.id === markerId));
    }
    body.appendChild(list);

    const featured = markerId ? visible.find(c => c.id === markerId) : null;
    if (featured) body.appendChild(this.renderSpotlight(featured));

    // Panneau cible : image(s) + CA/PV + champ PV. Cible = tokens ciblés (T),
    // sinon token(s) sélectionné(s). Affiché seulement s'il y a une victime.
    const victims = this.resolveVictims();
    if (victims.length) body.appendChild(this.renderTargetPanel(victims));

    root.appendChild(body);
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

    const img = document.createElement("img");
    img.className = "co-target-img";
    img.src = this.imgForToken(token);
    img.alt = token.name;
    card.appendChild(img);

    const name = document.createElement("div");
    name.className = "co-target-name";
    name.textContent = token.name;
    card.appendChild(name);

    // CA / PV sous la cible (MJ uniquement).
    if (game.user.isGM) {
      const stats = this.actorStats(token.actor);
      if (stats.length) {
        const meta = document.createElement("div");
        meta.className = "co-target-stats co-spot-stats";
        for (const s of stats) {
          const badge = document.createElement("span");
          badge.className = `co-stat co-stat-${s.key}`;
          badge.innerHTML = `<i class="${s.icon}"></i>`;
          badge.appendChild(document.createTextNode(` ${s.value}`));
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
    return token.actor?.effects?.some(
      e => e.statuses?.has("dead") || e.flags?.core?.statusId === "dead"
    ) ?? false;
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

  renderRow(c, isCurrent) {
    const row = document.createElement("div");
    row.className = "co-row";
    row.classList.toggle("co-pc", !c.isNPC);
    row.classList.toggle("co-npc", c.isNPC);
    row.classList.toggle("co-current", isCurrent);
    row.classList.toggle("co-hidden", !!c.hidden);
    row.dataset.combatantId = c.id;

    // Marqueur du combattant courant.
    const marker = document.createElement("div");
    marker.className = "co-marker";
    marker.innerHTML = isCurrent ? '<i class="fas fa-caret-right"></i>' : "";
    row.appendChild(marker);

    // Portrait / token.
    const img = document.createElement("img");
    img.className = "co-img";
    img.src = this.imgFor(c);
    img.alt = c.name;
    row.appendChild(img);

    // Nom.
    const name = document.createElement("div");
    name.className = "co-name";
    name.textContent = c.name;
    row.appendChild(name);

    // Initiative : champ éditable si l'utilisateur possède le combattant, sinon texte.
    row.appendChild(this.renderInit(c));

    // Clic sur la ligne (hors champ) → sélectionne/centre le token si possédé.
    row.addEventListener("click", (ev) => {
      if (ev.target.closest("input")) return;
      this.focusToken(c);
    });
    // Double-clic → ouvre la feuille de personnage.
    row.addEventListener("dblclick", (ev) => {
      if (ev.target.closest("input")) return;
      this.openSheet(c);
    });

    return row;
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

  /** Grande vignette du combattant en vedette (courant) affichée à droite. */
  renderSpotlight(c) {
    const spot = document.createElement("div");
    spot.className = "co-spotlight";
    spot.dataset.combatantId = c.id;
    spot.classList.toggle("co-pc", !c.isNPC);
    spot.classList.toggle("co-npc", c.isNPC);

    const img = document.createElement("img");
    img.className = "co-spot-img";
    img.src = this.imgFor(c);
    img.alt = c.name;
    spot.appendChild(img);

    const name = document.createElement("div");
    name.className = "co-spot-name";
    name.textContent = c.name;
    spot.appendChild(name);

    // Infos MJ (CA / PV) — visibles du MJ uniquement, si l'acteur les expose.
    if (game.user.isGM) {
      const stats = this.actorStats(c.actor);
      if (stats.length) {
        const meta = document.createElement("div");
        meta.className = "co-spot-stats";
        for (const s of stats) {
          const badge = document.createElement("span");
          badge.className = `co-stat co-stat-${s.key}`;
          badge.innerHTML = `<i class="${s.icon}"></i>`;
          badge.appendChild(document.createTextNode(` ${s.value}`));
          meta.appendChild(badge);
        }
        spot.appendChild(meta);
      }
    }

    // Clic → sélection/centrage du token (si possédé) ; double-clic → feuille.
    spot.addEventListener("click", () => this.focusToken(c));
    spot.addEventListener("dblclick", () => this.openSheet(c));
    return spot;
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
  /** Source d'image selon le réglage, avec repli si vidéo/manquante. */
  imgFor(c) {
    const mode = game.settings.get(MODULE_ID, "imageMode");
    const token = c.token?.texture?.src || c.img;
    const actor = c.actor?.img;
    let src = mode === "token" ? (token || actor) : (actor || token);
    if (!src || VIDEO_RE.test(src)) {
      const alt = mode === "token" ? actor : token;
      src = (alt && !VIDEO_RE.test(alt)) ? alt : MYSTERY_MAN;
    }
    return src;
  }

  /** Comme imgFor, mais pour un Token placé sur la scène (cible / sélection). */
  imgForToken(token) {
    const mode = game.settings.get(MODULE_ID, "imageMode");
    const tokenSrc = token.document?.texture?.src;
    const actorSrc = token.actor?.img;
    let src = mode === "token" ? (tokenSrc || actorSrc) : (actorSrc || tokenSrc);
    if (!src || VIDEO_RE.test(src)) {
      const alt = mode === "token" ? actorSrc : tokenSrc;
      src = (alt && !VIDEO_RE.test(alt)) ? alt : MYSTERY_MAN;
    }
    return src;
  }

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
      try { token.control({ releaseOthers: true }); } catch (e) { console.warn("[Combat Overlay] control:", e); }
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

  toggleCollapsed() {
    const on = !this.root.classList.contains("co-collapsed");
    this.root.classList.toggle("co-collapsed", on);
    localStorage.setItem(this.collapsedKey, on ? "1" : "0");
    const r = this.root.getBoundingClientRect();
    this.setPos(r.left, r.top);
    // Met à jour l'icône du toggle immédiatement.
    const icon = this.root.querySelector(".co-toggle i");
    if (icon) icon.className = `fas fa-chevron-${on ? "down" : "up"}`;
    const toggle = this.root.querySelector(".co-toggle");
    if (toggle) toggle.dataset.tooltip = on ? "Ré-étendre" : "Minimiser";
  }

  // ── Position (drag + mémorisation) ───────────────────────────────────────
  clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

  setPos(left, top) {
    const bw = this.root.offsetWidth || 200;
    const bh = this.root.offsetHeight || 60;
    left = this.clamp(left, 4, window.innerWidth - bw - 4);
    top = this.clamp(top, 4, window.innerHeight - bh - 4);
    this.root.style.left = `${Math.round(left)}px`;
    this.root.style.top = `${Math.round(top)}px`;
    this.root.style.right = this.root.style.bottom = "auto";
  }

  savePos() {
    const r = this.root.getBoundingClientRect();
    localStorage.setItem(this.posKey, JSON.stringify({ left: r.left, top: r.top }));
  }

  readPos() {
    try { return JSON.parse(localStorage.getItem(this.posKey)); } catch { return null; }
  }

  applyPosition() {
    const saved = this.readPos();
    if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
      return this.setPos(saved.left, saved.top);
    }
    this.setPos(10, 80); // par défaut : coin supérieur gauche de la scène.
  }

  onResize() {
    if (!this.root) return;
    const r = this.root.getBoundingClientRect();
    this.setPos(r.left, r.top);
  }

  initDrag(handle) {
    handle.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      const r = this.root.getBoundingClientRect();
      const offX = ev.clientX - r.left;
      const offY = ev.clientY - r.top;
      handle.setPointerCapture(ev.pointerId);
      const onMove = (e) => this.setPos(e.clientX - offX, e.clientY - offY);
      const onUp = () => {
        handle.releasePointerCapture(ev.pointerId);
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        this.savePos();
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
    });
  }
}
