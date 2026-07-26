/**
 * Arthak's Table Token Bar — Module Foundry VTT v13/v14 · Système dnd5e
 *
 * Barre flottante remplie DYNAMIQUEMENT avec les objets utilisables du token
 * sélectionné, en sections : INVENTAIRE → FEATURES → SORTS. Affichée pour tous,
 * mise à jour au changement de sélection et quand les objets de l'acteur changent.
 * (Portage du script hotbar « ActionBar.js » en module.)
 *
 * Contenu :
 *  - Inventaire = armes (équipées par défaut) + consommables utilisables.
 *  - Features   = dons "feat" réellement actionnables (effet réel, consommation
 *                 de ressource ou charges), + rappels listés (ex. Multiattack,
 *                 affichés en premier). Badge « charges restantes / total ».
 *  - Sorts      = Cantrips (niveau 0) à part, puis un groupe par niveau de sort,
 *                 dont l'en-tête affiche « emplacements restants / total ».
 *                 Compatible dnd5e v3/v4/v5.
 *
 * Interaction :
 *  - Clic gauche → utilise l'objet (item.use()).
 *  - Clic droit  → ouvre la fiche de l'objet.
 *  - Poignée (⋮⋮) → glisser pour déplacer la barre (position mémorisée).
 *  - Bouton ⟨ / ⟩ → minimise / ré-étend la barre (état mémorisé par utilisateur).
 *
 * Tout le comportement (groupes, taille, armes équipées, dédoublonnage, features
 * « rappel ») est configurable via les réglages du module.
 */

import { MODULE_ID } from "../const.js";
import { makeNotify } from "../lib/common.js";
import { FloatingBar } from "../lib/floating-bar.js";

const BAR_ID = "selected-token-actions";
const notify = makeNotify("Token Bar");

// Configuration vivante, rafraîchie depuis les réglages à chaque rendu.
let CFG = {};

// Réglages de cette fonctionnalité : centralisés dans settings.js.

// ═══════════════════════════════════════════════════════════════════════════════
// DÉTECTION DES OBJETS (lit CFG, rafraîchi à chaque rendu)
// ═══════════════════════════════════════════════════════════════════════════════
// Liste des activities d'un objet (dnd5e v4). Vide en v3.
function activities(item) {
  const acts = item.system?.activities;
  if (!acts) return [];
  return acts.contents ?? (typeof acts[Symbol.iterator] === "function" ? [...acts] : []);
}

// Une activity produit-elle un effet mécanique réel ? On exige de VRAIS dés ou
// une formule (number/denomination/formula) pour les dégâts et le soin — un
// simple `bonus` de soin (ex. Disciple of Life = "+3") est un rider passif et
// ne compte PAS.
function activityHasRealEffect(act) {
  if (!act) return false;
  if (act.type === "attack" || act.attack) return true;
  if (act.type === "save"   || act.save)   return true;
  const dmg = act.damage?.parts ?? [];
  if (dmg.some(p => p?.number || p?.custom?.formula)) return true;
  const h = act.healing;
  if (h && (h.number || h.custom?.formula)) return true;
  return false;
}

// Une activity est « active » si elle a un effet réel OU consomme une ressource
// (charges, emplacement, Channel Divinity…). Distingue Preserve Life (consomme)
// des riders passifs comme Blessed Healer (ne consomme rien).
function isActiveActivity(act) {
  if (!act) return false;
  if (act.consumption?.targets?.length) return true;
  return activityHasRealEffect(act);
}

// L'objet a-t-il un usage limité (charges) ? (dnd5e v3 et v4)
function hasUses(item) {
  const u = item.system?.uses;
  if (!u) return false;
  if (u.max != null && u.max !== "" && Number(u.max) !== 0) return true; // v4 : formule/nombre
  if (Number(u.value) > 0) return true;                                  // v3
  return false;
}

// Arme (attaque). Optionnellement restreinte aux armes équipées.
function isWeapon(item) {
  if (item.type !== "weapon") return false;
  if (CFG.onlyEquippedWeapons && "equipped" in (item.system ?? {}) && !item.system.equipped) {
    return false;
  }
  return true;
}

// L'objet consomme-t-il une ressource/attribut de l'acteur ? (ex. resources.legact
// pour les actions légendaires, resources.legres pour la résistance légendaire)
function consumesActorResource(item) {
  const acts = activities(item);
  if (acts.some(a => (a.consumption?.targets ?? []).some(t => t.type === "attribute"))) return true;
  const c = item.system?.consume; // dnd5e v3
  return c?.type === "attribute" && !!c.target;
}

// Sort affichable : cantrip (niveau 0), méthode spéciale (atwill/innate/pact),
// ou sort préparé. (dnd5e v4/v5 : system.method + system.prepared)
function isUsableSpellItem(spell) {
  if (spell.type !== "spell") return false;
  if (Number(spell.system?.level) === 0) return true;
  const method = spell.system?.method;
  if (method && method !== "spell") return true;
  return !!spell.system?.prepared;
}

// Charges d'un objet (dnd5e v3/v4/v5) → { remaining, max } ou null.
// v4/v5 : uses.spent (restant = max - spent) ; v3 : uses.value (déjà le restant).
// Couvre aussi « recharge X-Y » (souffle de dragon) : uses.max vaut 1.
function itemUses(item) {
  const u = item.system?.uses;
  const max = Number(u?.max);
  if (!(max > 0)) return null;
  const remaining = (u.spent != null) ? (max - Number(u.spent)) : Number(u.value ?? 0);
  return { remaining, max };
}

// Compteur à afficher en badge sur un bouton : d'abord les charges propres de
// l'objet (inclut « recharge »), sinon la ressource d'acteur consommée
// (actions/résistance légendaires…). → { remaining, max } ou null.
function buttonCounter(item, actor) {
  const own = itemUses(item);
  if (own) return own;

  const readRes = (target) => {
    if (!target) return null;
    const path = String(target).replace(/\.value$/, ""); // "resources.legact.value" → "resources.legact"
    const res = foundry.utils.getProperty(actor?.system ?? {}, path);
    if (res && Number(res.max) > 0) return { remaining: Number(res.value ?? 0), max: Number(res.max) };
    return null;
  };

  for (const a of activities(item)) {
    for (const t of a.consumption?.targets ?? []) {
      if (t.type === "attribute") {
        const r = readRes(t.target);
        if (r) return r;
      }
    }
  }
  const c = item.system?.consume; // dnd5e v3
  if (c?.type === "attribute") {
    const r = readRes(c.target);
    if (r) return r;
  }
  return null;
}

// Feature (don) affichée si : nom en liste blanche « rappel », OU au moins une
// activity active (effet réel/consommation), OU usage limité (charges).
function isFeature(item) {
  if (item.type !== "feat") return false;
  const name = (item.name ?? "").toLowerCase();
  if (CFG.alwaysShowFeatureNames?.some(n => name.includes(n.toLowerCase()))) return true;
  if (activities(item).some(isActiveActivity)) return true;
  if (consumesActorResource(item)) return true;   // ex. résistance légendaire (legres)
  return hasUses(item);
}

// Retire les doublons de même nom (garde le premier).
function dedupeByName(items) {
  if (!CFG.dedupeByName) return items;
  const seen = new Set();
  return items.filter(i => {
    const key = (i.name ?? "").toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Une feature est-elle un « rappel » de la liste blanche (ex. Multiattack) ?
function isReminderFeature(item) {
  const name = (item.name ?? "").toLowerCase();
  return Boolean(CFG.alwaysShowFeatureNames?.some(n => name.includes(n.toLowerCase())));
}

// Construit les sections ordonnées : Inventaire → Features → Sorts (cantrips
// puis un groupe par niveau de sort, avec son compteur d'emplacements).
// Chaque section = { label, cssClass, items[], slotText? }.
function buildSections(actor) {
  const byName = (a, b) => a.name.localeCompare(b.name);
  // Features : les rappels (Multiattack…) d'abord, puis le reste alphabétique.
  const byReminderThenName = (a, b) => {
    const ra = isReminderFeature(a), rb = isReminderFeature(b);
    if (ra !== rb) return ra ? -1 : 1;
    return byName(a, b);
  };
  const sections = [];

  // Inventaire : armes (équipées par défaut).
  if (CFG.includeInventory) {
    const items = dedupeByName(actor.items.filter(isWeapon)).sort(byName);
    if (items.length) sections.push({ label: "Armes", cssClass: null, items });
  }

  // Features actionnables (badge de charges sur les boutons).
  if (CFG.includeFeatures) {
    const items = dedupeByName(actor.items.filter(isFeature)).sort(byReminderThenName);
    if (items.length) sections.push({ label: "Features", cssClass: "ab-feature", items });
  }

  // Sorts : cantrips à part, puis un groupe par niveau (avec slots restants/total).
  if (CFG.includeSpells) {
    // Un seul passage : regroupe les sorts par niveau (0 = cantrips) dans une Map.
    const byLevel = new Map();
    for (const s of actor.items.filter(isUsableSpellItem)) {
      const lvl = Number(s.system?.level) || 0;
      (byLevel.get(lvl) ?? byLevel.set(lvl, []).get(lvl)).push(s);
    }
    const prep = (lvl) => dedupeByName(byLevel.get(lvl) ?? []).sort(byName);

    const cantrips = prep(0);
    if (cantrips.length) sections.push({ label: "Cantrips", cssClass: "ab-cantrip", items: cantrips });

    for (let lvl = 1; lvl <= 9; lvl++) {
      const items = prep(lvl);
      if (!items.length) continue;
      const slot = actor.system?.spells?.[`spell${lvl}`];
      const slotText = (slot && Number(slot.max) > 0) ? `${slot.value ?? 0}/${slot.max}` : "";
      sections.push({ label: `N${lvl}`, cssClass: "ab-spell", items, slotText });
    }
  }

  return sections;
}

// ═══════════════════════════════════════════════════════════════════════════════
// BARRE
// ═══════════════════════════════════════════════════════════════════════════════
export class TokenActionBar extends FloatingBar {
  static instance = null;

  /** Instancie et démarre la barre (idempotent). Appelé selon le réglage d'activation. */
  static start() {
    if (this.instance) return;
    if (game.system.id !== "dnd5e") {
      notify.warn(`Cette fonctionnalité cible le système dnd5e (système actuel : ${game.system.id}).`);
    }
    this.instance = new this();
    this.instance.init();
  }

  constructor() {
    super("token");
    this._activeActorId = null;     // acteur actuellement affiché (rafraîchissement ciblé)
  }

  get bar() { return this.el; }
  set bar(v) { this.el = v; }

  // ── Cycle de vie ─────────────────────────────────────────────────────────
  init() {
    document.querySelectorAll(`body > #${BAR_ID}`).forEach(el => el.remove());
    this.bar = document.createElement("div");
    this.bar.id = BAR_ID;
    document.body.appendChild(this.bar);

    this.registerHooks();
    window.addEventListener("resize", this.onResize);
    this.render();
    notify.info("Barre d'action prête.");
  }

  registerHooks() {
    this.hookIds.controlToken = Hooks.on("controlToken", () => this.render());
    const refreshOnItem = (item) => {
      if (item?.parent?.id && item.parent.id === this._activeActorId) this.render();
    };
    this.hookIds.createItem = Hooks.on("createItem", refreshOnItem);
    this.hookIds.updateItem = Hooks.on("updateItem", refreshOnItem);
    this.hookIds.deleteItem = Hooks.on("deleteItem", refreshOnItem);
  }

  // destroy() : hérité de FloatingBar.

  // Rafraîchit CFG depuis les réglages (les fonctions de détection lisent CFG).
  readCfg() {
    const names = String(game.settings.get(MODULE_ID, "alwaysShowFeatureNames") ?? "")
      .split(",").map(s => s.trim()).filter(Boolean);
    CFG = {
      includeInventory: game.settings.get(MODULE_ID, "includeInventory"),
      includeFeatures:  game.settings.get(MODULE_ID, "includeFeatures"),
      includeSpells:    game.settings.get(MODULE_ID, "includeSpells"),
      showGroupLabels:  game.settings.get(MODULE_ID, "showGroupLabels"),
      onlyEquippedWeapons: game.settings.get(MODULE_ID, "onlyEquippedWeapons"),
      dedupeByName: game.settings.get(MODULE_ID, "dedupeByName"),
      alwaysShowFeatureNames: names,
      buttonSize: Number(game.settings.get(MODULE_ID, "tokenButtonSize")) || 42,
    };
  }

  /**
   * Token dont on affiche les actions : exactement UN token sélectionné dont on
   * a la PERMISSION (`actor.isOwner`). Aucune mémorisation.
   *  - MJ : possède tout → la barre s'affiche pour tout token sélectionné (monstre inclus).
   *  - Joueur : uniquement ses tokens ; sur un token non permis (ou aucune/plusieurs
   *    sélections), la barre disparaît.
   */
  resolveToken() {
    const controlled = canvas.tokens?.controlled ?? [];
    const sole = controlled.length === 1 ? controlled[0] : null;
    return sole?.actor?.isOwner ? sole : null;
  }

  // ── Rendu ──────────────────────────────────────────────────────────────────
  render() {
    this.readCfg();
    const token = this.resolveToken();
    this.bar.replaceChildren();

    if (!token) {
      this._activeActorId = null;
      this.bar.style.display = "none";
      return;
    }

    const actor = token.actor;
    this._activeActorId = actor.id;
    this.bar.style.display = "flex";

    // Poignée de déplacement (toujours visible, ancrée ou libre).
    this.bar.appendChild(this.makeHandle("ab-handle"));

    // Libellé (repliable).
    const label = document.createElement("div");
    label.className = "ab-label ab-collapsible";
    label.textContent = token.name;
    this.bar.appendChild(label);

    // Groupes (repliables) : Inventaire → Features → Sorts (cantrips + par niveau).
    const sections = buildSections(actor);
    const wrap = document.createElement("div");
    wrap.className = "ab-items ab-collapsible";

    for (const section of sections) {
      // Chaque section = un bloc vertical : mini-libellé au-dessus, icônes en dessous.
      const block = document.createElement("div");
      block.className = "ab-section";

      if (CFG.showGroupLabels && section.label) {
        const head = document.createElement("div");
        head.className = "ab-group";
        const name = document.createElement("span");
        name.className = "ab-group-name";
        name.textContent = section.label;
        head.appendChild(name);
        if (section.slotText) {
          const slot = document.createElement("span");
          slot.className = "ab-slot";
          slot.textContent = section.slotText;
          slot.dataset.tooltip = "Emplacements restants / total à ce niveau";
          head.appendChild(slot);
        }
        block.appendChild(head);
      }

      const row = document.createElement("div");
      row.className = "ab-row";
      section.items.forEach(i => row.appendChild(this.makeButton(i, section.cssClass, actor)));
      block.appendChild(row);

      wrap.appendChild(block);
    }

    if (!wrap.childElementCount) {
      const empty = document.createElement("div");
      empty.className = "ab-empty";
      empty.textContent = "Aucune action disponible.";
      wrap.appendChild(empty);
    }
    this.bar.appendChild(wrap);

    // Toggle minimiser / ré-étendre (toujours visible).
    const collapsed = localStorage.getItem(this.collapsedKey) === "1";
    const toggle = document.createElement("div");
    toggle.className = "ab-toggle";
    toggle.dataset.tooltip = collapsed ? "Ré-étendre la barre" : "Minimiser la barre";
    toggle.innerHTML = `<i class="fas fa-chevron-${collapsed ? "right" : "left"}"></i>`;
    toggle.addEventListener("click", () => this.toggleCollapsed());
    this.bar.appendChild(toggle);

    this.bar.classList.toggle("ab-collapsed", collapsed);

    // Placement + orientation une fois le contenu construit (dimensions connues).
    this.applyDock();
  }

  makeButton(item, cssClass, actor) {
    const btn = document.createElement("div");
    btn.className = `ab-btn${cssClass ? " " + cssClass : ""}`;
    btn.style.width = btn.style.height = `${CFG.buttonSize}px`;
    btn.style.backgroundImage = `url("${item.img}")`;
    btn.dataset.tooltip = item.name;

    // Badge : charges propres (features, recharge…) ou ressource d'acteur
    // consommée (actions légendaires legact, résistance légendaire legres…).
    const counter = buttonCounter(item, actor);
    if (counter) {
      const badge = document.createElement("span");
      badge.className = "ab-badge";
      badge.textContent = `${counter.remaining}/${counter.max}`;
      if (counter.remaining <= 0) badge.classList.add("ab-badge-empty");
      btn.appendChild(badge);
    }

    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      item.use?.({}, { event: ev });
    });
    btn.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      item.sheet?.render(true);
    });
    return btn;
  }

  // ── Minimiser (skeleton dans FloatingBar) ──────────────────────────────────
  get collapsedClass() { return "ab-collapsed"; }

  updateCollapseIcon(on) {
    const icon = this.bar.querySelector(".ab-toggle i");
    if (icon) icon.className = `fas fa-chevron-${on ? "right" : "left"}`;
    const toggle = this.bar.querySelector(".ab-toggle");
    if (toggle) toggle.dataset.tooltip = on ? "Ré-étendre la barre" : "Minimiser la barre";
  }

  // ── Position / ancrage ─────────────────────────────────────────────────────
  // Ancrage aux bords, orientation et reflow : hérités de FloatingBar. La barre
  // déclare seulement sa clé de réglage et son ancrage par défaut.
  get dockSettingKey() { return "dockPosition"; }
  get defaultDock() { return "bottom-center"; }
}
