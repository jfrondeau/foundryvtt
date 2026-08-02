/**
 * Arthak's Table Rolls Bar — Module Foundry VTT v13/v14 · Système dnd5e
 *
 * Barre flottante qui CAPTE et AFFICHE les jets d'attaque et de dégâts du système
 * dnd5e NATIF (aucune dépendance à un module de jet tiers), pour se passer du chat
 * autour de la table : on voit l'action posée, le résultat d'attaque (les d20 avec
 * indicateur normal / avantage / désavantage) et — à venir — les dégâts par type et
 * les boutons d'application.
 *
 * Principe (voir note mémoire) : le module n'est PAS un moteur de jet. Foundry/dnd5e
 * roule les dés (clic = normal, alt = avantage, ctrl = désavantage — raccourcis natifs
 * du système). Cette barre écoute les messages de chat produits par ces jets et en
 * reconstruit un affichage compact. La source de vérité est le message : ses `rolls`
 * (objets Roll évalués) et ses `flags.dnd5e` (type de jet, activité/objet source,
 * message d'origine reliant attaque et dégâts).
 *
 * ⚠️ INCOMPATIBILITÉ — modules qui remplacent les cartes de jet natives de dnd5e :
 * la capture repose sur la structure du message natif (`flags.dnd5e.roll.type`). Un module
 * de jet tiers qui reformate ou supprime cette carte casse la capture : la barre reste
 * bloquée sur « En attente d'un jet… ». Cas confirmé : **Ready Set Roll Reforged**
 * (`rsreforged`). À désactiver sur le monde pour utiliser cette barre.
 *
 * Étape 1-2 (ce fichier) : squelette de barre + capture des jets d'ATTAQUE, affichés
 * en pile de lignes (action + d20 + total + indicateur d'état), chaque ligne retirable
 * par ✕. L'avantage/désavantage à la demande, les dégâts et l'application viennent aux
 * étapes suivantes. Instrumenté par des logs (`makeNotify`) pour valider en jeu la
 * structure réelle des messages dnd5e installés.
 *
 * Interaction :
 *  - Poignée (⋮⋮) → glisser pour déplacer / ancrer la barre.
 *  - Bouton ↻ → orientation horizontale / verticale (une fois ancrée).
 *  - Bouton ⟨ / ⟩ → minimise / ré-étend la barre (état mémorisé par utilisateur).
 *  - ✕ sur une ligne → retire ce jet de la pile.
 */

import { MODULE_ID } from "../const.js";
import { makeNotify, t } from "../lib/common.js";
import { FloatingBar } from "../lib/floating-bar.js";

const BAR_ID = "ats-rolls-bar";
const notify = makeNotify("Rolls Bar");

// Modes d'avantage d20 de dnd5e (repli si CONFIG absent au moment de la lecture).
const ADV_FALLBACK = { NORMAL: 0, ADVANTAGE: 1, DISADVANTAGE: -1 };

/**
 * Un événement satisfait-il un keybinding dnd5e (ex. « skipDialogAdvantage ») ? Réplique la
 * détection du système (mêmes modificateurs Ctrl/Cmd, Shift, Alt) pour interpréter nous-mêmes
 * Alt = avantage / Ctrl = désavantage quand on saute le dialogue de configuration : c'est
 * normalement ce dialogue qui applique l'état d'avantage, donc en le court-circuitant on doit
 * relire les touches et les appliquer aux options du jet.
 * @param {Event} event  Événement déclencheur (clic sur l'action).
 * @param {string} action  Action de keybinding dnd5e.
 * @returns {boolean}
 */
function keybindPressed(event, action) {
  if (!event) return false;
  try {
    const KM = foundry.helpers.interaction.KeyboardManager;
    const active = {};
    const add = (key, pressed) => {
      active[key] = pressed;
      (KM.MODIFIER_CODES[key] ?? []).forEach((n) => { active[n] = pressed; });
    };
    add(KM.MODIFIER_KEYS.CONTROL, event.ctrlKey || event.metaKey);
    add(KM.MODIFIER_KEYS.SHIFT, event.shiftKey);
    add(KM.MODIFIER_KEYS.ALT, event.altKey);
    return (game.keybindings.get("dnd5e", action) ?? []).some((b) => {
      if (game.keyboard.downKeys.has(b.key) && b.modifiers.every((m) => active[m])) return true;
      if (b.modifiers.length) return false;
      return active[b.key];
    });
  } catch {
    return false;
  }
}

/**
 * Événement synthétique reflétant l'état COURANT des modificateurs clavier (Alt/Ctrl/Shift),
 * pour détecter les touches quand aucun événement de clic n'est disponible (les hooks de jet de
 * dnd5e 5.3 ne transportent pas l'événement, et `usageConfig.event` peut être absent).
 * @returns {({altKey:boolean, ctrlKey:boolean, metaKey:boolean, shiftKey:boolean}|null)}
 */
function currentModifierEvent() {
  try {
    const KM = foundry.helpers.interaction.KeyboardManager;
    const kb = game.keyboard;
    if (!kb?.isModifierActive) return null;
    return {
      altKey: kb.isModifierActive(KM.MODIFIER_KEYS.ALT),
      ctrlKey: kb.isModifierActive(KM.MODIFIER_KEYS.CONTROL),
      metaKey: false,
      shiftKey: kb.isModifierActive(KM.MODIFIER_KEYS.SHIFT),
    };
  } catch {
    return null;
  }
}

export class RollsBar extends FloatingBar {
  static instance = null;

  /** État des touches (avantage/désavantage) capturé au clic, consommé par le jet suivant. */
  static _pendingKeys = null;

  /** Instancie et démarre la barre (idempotent). Démarrée par la matrice de masquage. */
  static start() {
    if (this.instance) return;
    this.instance = new this();
    this.instance.init();
  }

  /**
   * Court-circuite la fenêtre de configuration de jet de dnd5e (« fast-forward ») : les jets
   * d'attaque et de dégâts partent directement, sans dialogue intermédiaire. L'état
   * normal / avantage / désavantage reste piloté par les raccourcis NATIFS du système (clic =
   * normal, Alt = avantage, Ctrl = désavantage), lus AVANT ce hook — on ne fait que masquer la
   * fenêtre. Piloté par le réglage « rollsSkipDialog ».
   *
   * Enregistré UNE seule fois, indépendamment du cycle de vie de la barre : le raccourci doit
   * fonctionner sur le client qui lance le jet même si la barre y est masquée. À appeler au
   * hook « ready » (cf. main.js).
   */
  static installRollShortcuts() {
    if (this._shortcutsInstalled) return;
    this._shortcutsInstalled = true;

    // 1) L'événement de clic (Alt/Ctrl) n'est disponible qu'à l'usage de l'activité — les hooks
    //    de jet de dnd5e 5.3 ne le transportent pas. On y capture l'état des touches (avec repli
    //    sur l'état clavier live, car `usageConfig.event` peut être absent) pour l'appliquer au
    //    jet d'attaque qui suit.
    Hooks.on("dnd5e.preUseActivity", (activity, usageConfig) => {
      try {
        if (!game.settings.get(MODULE_ID, "rollsSkipDialog")) return true;
        const event = usageConfig?.event ?? currentModifierEvent();
        RollsBar._pendingKeys = {
          advantage: keybindPressed(event, "skipDialogAdvantage"),
          disadvantage: keybindPressed(event, "skipDialogDisadvantage"),
        };
      } catch (err) {
        console.error("[Arthak's Table · Rolls Bar] preUseActivity :", err);
      }
      return true;
    });

    // 2) Sur le jet : saute la fenêtre de configuration et applique l'état d'avantage capturé
    //    au clic (ou l'état clavier live), que dnd5e ne détecte plus seul faute d'événement.
    const handler = (hookName) => (config, dialog) => {
      try {
        if (!game.settings.get(MODULE_ID, "rollsSkipDialog")) return true;
        const isAttack = hookName.includes("Attack");
        const pending = RollsBar._pendingKeys ?? {};
        const event = config?.event ?? currentModifierEvent();
        const advantage = isAttack && (!!config?.advantage
          || !!pending.advantage || keybindPressed(event, "skipDialogAdvantage"));
        const disadvantage = isAttack && (!!config?.disadvantage
          || !!pending.disadvantage || keybindPressed(event, "skipDialogDisadvantage"));

        if (config) {
          if (advantage) config.advantage = true;
          if (disadvantage) config.disadvantage = true;
          config.fastForward = true;
          for (const roll of config.rolls ?? []) {
            roll.options ??= {};
            if (advantage) roll.options.advantage = true;
            if (disadvantage) roll.options.disadvantage = true;
            if (config.isCritical != null) roll.options.isCritical ??= config.isCritical;
          }
        }
        if (dialog && typeof dialog === "object") dialog.configure = false;
      } catch (err) {
        console.error("[Arthak's Table · Rolls Bar] fast-forward :", err);
      }
      return true;
    };

    // On couvre les variantes de nom de hook selon la version dnd5e installée.
    for (const hook of ["dnd5e.preRollAttack", "dnd5e.preRollAttackV2", "dnd5e.preRollDamage", "dnd5e.preRollDamageV2"]) {
      Hooks.on(hook, handler(hook));
    }
  }

  /**
   * Applique un ajustement d'état persisté sur le message de chat (flag invisible `adjust`).
   * Foundry propage nativement la mise à jour du document à TOUS les écrans (MJ, TV, joueurs), et
   * même aux clients qui rechargent : chacun re-dérive sa ligne. Appelé au hook `updateChatMessage`.
   * @param {ChatMessage} msg
   */
  onUpdateMessage(msg) {
    try {
      const flags = msg?.flags?.[MODULE_ID];
      if (!flags) return;
      const originId = msg.flags?.dnd5e?.originatingMessage ?? msg.id;
      const entry = this._byOrigin.get(originId);
      if (!entry) return;
      const adj = flags.adjust;
      if (adj && entry.attack) {
        if (Array.isArray(adj.rawDice)) entry.attack.rawDice = adj.rawDice;
        if (adj.mode) entry.attack.mode = adj.mode;
      }
      if (flags.damage) entry.damage = flags.damage;
      this.render();
    } catch (err) {
      console.error("[Arthak's Table · Rolls Bar] updateChatMessage :", err);
    }
  }

  constructor() {
    super("rolls");
    /** Pile des lignes de jet affichées, la plus récente en tête. */
    this.entries = [];
    /**
     * Corrélation attaque ↔ dégâts d'une MÊME action : les messages de jet dnd5e
     * partagent `flags.dnd5e.originatingMessage` (l'id de la carte d'usage). On indexe
     * les lignes par cet id pour rattacher plus tard les dégâts à la bonne attaque.
     */
    this._byOrigin = new Map();
    /** Toggle de cible d'application : « targeted » (défaut) ou « selected ». */
    this._targetMode = "targeted";
  }

  get bar() { return this.el; }
  set bar(v) { this.el = v; }

  // ── Cycle de vie ─────────────────────────────────────────────────────────
  init() {
    document.querySelectorAll(`body > #${BAR_ID}`).forEach((el) => el.remove());
    this.el = document.createElement("div");
    this.el.id = BAR_ID;
    document.body.appendChild(this.el);

    this.registerHooks();
    this.attachViewportHandlers();
    this.render();
    notify.info(t("ATS.rolls.ready"));
  }

  registerHooks() {
    // Capture au moment où le message de jet est créé (rolls déjà évalués). Le hook ne se
    // déclenche que sur les clients qui REÇOIVENT le message : la visibilité chat (public /
    // privé MJ / self / aveugle) est donc en partie respectée d'office ; on la reconfirme via
    // `message.visible` dans onChatMessage.
    this.hookIds.createChatMessage = Hooks.on("createChatMessage", (msg) => this.onChatMessage(msg));
    // Ajustements d'état (avantage/désavantage) synchronisés entre écrans via un flag du message.
    this.hookIds.updateChatMessage = Hooks.on("updateChatMessage", (msg) => this.onUpdateMessage(msg));
  }

  // destroy() : hérité de FloatingBar (retire le hook, l'élément, l'instance).

  // ── Capture des jets ───────────────────────────────────────────────────────
  /**
   * Point d'entrée : un message de chat vient d'être créé. On ne traite que les messages
   * de JET dnd5e (flags.dnd5e.roll.type), et seulement si ce client a le droit de le voir.
   * @param {ChatMessage} msg
   */
  onChatMessage(msg) {
    try {
      const rollType = this.rollTypeOf(msg);
      if (!rollType) return;

      // Respect de la visibilité chat : si CE client n'a pas le droit de voir le message, on
      // n'affiche pas la ligne (whisper / blind / self). Le MJ voit tout.
      if (msg.visible === false) return;

      if (rollType === "attack") this.captureAttack(msg);
      else if (rollType === "damage" || rollType === "healing") this.captureDamage(msg, rollType === "healing");
    } catch (err) {
      console.error("[Arthak's Table · Rolls Bar] échec de capture :", err);
    }
  }

  /** Type de jet dnd5e du message (« attack » | « damage » | « healing » | …), ou null. */
  rollTypeOf(msg) {
    return msg?.system?.roll?.type ?? msg?.flags?.dnd5e?.roll?.type ?? null;
  }

  /**
   * Capture un jet d'attaque : reconstruit la ligne (action source + d20 + total + état),
   * la crée ou met à jour selon son message d'origine, puis re-rend la pile.
   * @param {ChatMessage} msg
   */
  captureAttack(msg) {
    const roll = msg.rolls?.[0];
    if (!roll) return;

    const originId = msg.flags?.dnd5e?.originatingMessage ?? msg.id;
    const attack = this.parseAttack(roll);
    const targets = this.parseTargets(msg);

    let entry = this._byOrigin.get(originId);
    if (entry) {
      entry.attack = attack;
      if (targets.length) entry.targets = targets;
    } else {
      const action = this.resolveAction(msg);
      entry = {
        id: originId,
        msgId: msg.id,
        actorName: msg.alias ?? "",
        actionName: action.name,
        actionImg: action.img,
        actionDesc: action.desc,
        actionUuid: action.uuid,
        // Contrôles interactifs (bascule d'état, lancer/appliquer les dégâts) réservés au MJ ou
        // au propriétaire de l'acteur du jet, comme le défaut dnd5e.
        canControl: this.canControl(msg),
        // Activité source, pour lancer les dégâts à la demande depuis la barre.
        activityUuid: msg.flags?.dnd5e?.activity?.uuid ?? null,
        attackMode: msg.flags?.dnd5e?.roll?.attackMode ?? null,
        targets,
        attack,
        damage: null,
      };
      this._byOrigin.set(originId, entry);
      this.entries.unshift(entry);
      this.trim();
    }
    this.render();
  }

  /** Cibles du jet (nom, image, CA) depuis les flags dnd5e du message. */
  parseTargets(msg) {
    return (msg.flags?.dnd5e?.targets ?? []).map((tg) => ({
      name: tg.name ?? "",
      img: tg.img ?? null,
      ac: Number(tg.ac),
    }));
  }

  /** Ce client peut-il piloter cette ligne (MJ, ou propriétaire de l'acteur du jet) ? */
  canControl(msg) {
    if (game.user.isGM) return true;
    try {
      const actor = ChatMessage.getSpeakerActor?.(msg.speaker) ?? game.actors.get(msg.speaker?.actor);
      return !!actor?.isOwner;
    } catch {
      return false;
    }
  }

  /**
   * Capture les dégâts (ou soins) d'une action : les rattache à la ligne existante (même
   * `originatingMessage` que l'attaque) ou en crée une nouvelle (ex. sort à sauvegarde sans
   * attaque). Puis re-rend.
   * @param {ChatMessage} msg
   * @param {boolean} isHealing  Le jet est-il un soin ?
   */
  captureDamage(msg, isHealing) {
    const rolls = msg.rolls ?? [];
    if (!rolls.length) return;

    const originId = msg.flags?.dnd5e?.originatingMessage ?? msg.id;
    const damage = this.parseDamage(msg, isHealing);

    let entry = this._byOrigin.get(originId);
    if (entry) {
      entry.damage = damage;
    } else {
      const action = this.resolveAction(msg);
      entry = {
        id: originId,
        msgId: msg.id,
        actorName: msg.alias ?? "",
        actionName: action.name,
        actionImg: action.img,
        actionDesc: action.desc,
        actionUuid: action.uuid,
        canControl: this.canControl(msg),
        targets: this.parseTargets(msg),
        attack: null,
        damage,
      };
      this._byOrigin.set(originId, entry);
      this.entries.unshift(entry);
      this.trim();
    }
    this.render();
  }

  /**
   * Reconstruit les dégâts affichables depuis les `DamageRoll` du message : une part par jet
   * (type, sous-total, formule, dés gardés), le total, et l'état critique. Les types sont
   * regroupés à l'affichage (voir `damageByType`).
   * @param {ChatMessage} msg
   * @param {boolean} isHealing
   */
  parseDamage(msg, isHealing) {
    const dmg = this.parseDamageFromRolls(msg.rolls ?? [], isHealing);
    if (msg.flags?.dnd5e?.roll?.critical) dmg.isCritical = true;
    return dmg;
  }

  /**
   * Construit les dégâts affichables (parts par type/dés, total, état critique) depuis un tableau
   * de `DamageRoll` évalués — utilisé aussi bien à la capture d'un message qu'au lancer direct
   * depuis la barre. Résultat en objets simples (sérialisables → synchronisables via flag).
   * @param {Roll[]} rolls
   * @param {boolean} isHealing
   */
  parseDamageFromRolls(rolls, isHealing) {
    const parts = [];
    let total = 0;
    for (const roll of rolls ?? []) {
      const type = roll.options?.type ?? "";
      const subtotal = Number(roll.total) || 0;
      total += subtotal;
      const dice = [];
      for (const term of roll.terms ?? []) {
        if (Array.isArray(term.results) && term.faces) {
          dice.push({
            faces: term.faces,
            values: term.results.filter((r) => r.active !== false && !r.discarded && !r.rerolled).map((r) => r.result),
          });
        }
      }
      parts.push({ type, subtotal, formula: roll.formula, dice });
    }
    const isCritical = (rolls ?? []).some((r) => r.options?.isCritical || r.isCritical);
    return { parts, total, isCritical, isHealing: !!isHealing };
  }

  /**
   * Regroupe les parts de dégâts par type (sous-totaux et dés cumulés), et calcule le bonus
   * plat de chaque type (sous-total − somme des dés).
   * @param {object} damage
   * @returns {{ type:string, subtotal:number, dice:{faces:number,values:number[]}[], flat:number }[]}
   */
  damageByType(damage) {
    const map = new Map();
    for (const p of damage.parts ?? []) {
      const cur = map.get(p.type) ?? { type: p.type, subtotal: 0, dice: [] };
      cur.subtotal += p.subtotal;
      for (const d of p.dice) cur.dice.push(d);
      map.set(p.type, cur);
    }
    const out = [...map.values()];
    for (const g of out) {
      const diceSum = g.dice.reduce((s, d) => s + d.values.reduce((a, b) => a + b, 0), 0);
      g.flat = g.subtotal - diceSum;
    }
    return out;
  }

  /** Libellé localisé d'un type de dégâts/soin (via CONFIG.DND5E), ou la clé brute en dernier recours. */
  damageTypeLabel(type) {
    if (!type) return "";
    const cfg = CONFIG?.DND5E?.damageTypes?.[type] ?? CONFIG?.DND5E?.healingTypes?.[type];
    return cfg?.label ? t(cfg.label) : type;
  }

  /** Plafonne la pile au nombre de jets conservés (réglage), en retirant les plus anciens. */
  trim() {
    const max = Math.max(1, Number(game.settings.get(MODULE_ID, "rollsMaxEntries")) || 2);
    while (this.entries.length > max) {
      const dropped = this.entries.pop();
      if (dropped && this._byOrigin.get(dropped.id) === dropped) this._byOrigin.delete(dropped.id);
    }
  }

  /**
   * Résout l'action source d'un message (activité dnd5e 5.x, sinon objet), pour le titre,
   * l'icône et la carte de survol affichés. Best-effort : retombe sur le `flavor` du message.
   *
   * On privilégie l'OBJET source (le nom « Greataxe » et son icône) plutôt que l'activité
   * générique (« Attack » et son icône de dé), pour coller à ce que le joueur a cliqué. L'UUID
   * de l'objet permet le survol riche natif de dnd5e (carte identique au chat, voir renderEntry).
   * @param {ChatMessage} msg
   * @returns {{ name: string, img: (string|null), desc: string, uuid: (string|null) }}
   */
  resolveAction(msg) {
    const d = msg.flags?.dnd5e ?? {};
    let activity = null;
    let item = null;
    let itemUuid = null;
    try {
      if (d.activity?.uuid) activity = fromUuidSync(d.activity.uuid, { strict: false });
      item = activity?.item ?? null;
      itemUuid = item?.uuid ?? null;
      if (!itemUuid) itemUuid = d.item?.uuid ?? d.use?.itemUuid ?? null;
      if (!item && d.item?.uuid) item = fromUuidSync(d.item.uuid, { strict: false });
      if (!item && d.use?.itemUuid) item = fromUuidSync(d.use.itemUuid, { strict: false });
    } catch { /* uuid non résoluble : on retombe sur le flavor */ }

    const name = item?.name || activity?.name || msg.flavor || t("ATS.rolls.unknownAction");
    const img = item?.img || activity?.img || null;

    // Description texte brut de repli (survol quand l'UUID n'est pas résoluble par dnd5e).
    let desc = "";
    const raw = item?.system?.description?.value;
    if (raw) desc = String(raw).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 240);

    return { name, img, desc, uuid: itemUuid };
  }

  /**
   * Extrait d'un `D20Roll` évalué les données d'attaque : les valeurs BRUTES des d20 (dans
   * l'ordre du jet), le bonus plat (total − dé gardé natif) et l'état initial. Le dé gardé et le
   * total sont ensuite DÉRIVÉS du mode (voir `keptDie`), pour permettre l'ajustement après coup.
   * @param {Roll} roll
   */
  parseAttack(roll) {
    const ADV = CONFIG?.Dice?.D20Roll?.ADV_MODE ?? ADV_FALLBACK;
    const d20 = roll.terms?.find((tt) => tt.faces === 20 && Array.isArray(tt.results));
    const results = d20?.results ?? [];
    const rawDice = results.map((r) => r.result);

    // Dé gardé natif (actif) pour déduire le bonus plat (total − dé gardé).
    const active = results.find((r) => r.active !== false && !r.discarded && !r.rerolled) ?? results[0];
    const keptValue = active?.result ?? rawDice[0] ?? null;
    const total = Number.isFinite(roll.total) ? roll.total : keptValue;
    const bonus = (total != null && keptValue != null) ? total - keptValue : 0;

    const am = roll.options?.advantageMode ?? ADV.NORMAL;
    const mode = am === ADV.ADVANTAGE ? "advantage" : am === ADV.DISADVANTAGE ? "disadvantage" : "normal";

    return { rawDice, bonus, mode, formula: roll.formula };
  }

  /**
   * Dé actuellement gardé selon le mode : normal = 1er dé (défaut), avantage = plus haut,
   * désavantage = plus bas. Retourne sa valeur et son index (pour la mise en avant).
   * @param {{rawDice:number[], mode:string}} attack
   * @returns {{ value:(number|null), index:number }}
   */
  keptDie(attack) {
    const d = attack.rawDice ?? [];
    if (!d.length) return { value: null, index: -1 };
    if (attack.mode === "advantage" || attack.mode === "disadvantage") {
      let idx = 0;
      for (let i = 1; i < d.length; i++) {
        if (attack.mode === "advantage" ? d[i] > d[idx] : d[i] < d[idx]) idx = i;
      }
      return { value: d[idx], index: idx };
    }
    return { value: d[0], index: 0 }; // normal → premier dé
  }

  /**
   * Ajuste l'état d'un jet APRÈS coup depuis la barre. Avantage/désavantage exigent 2 d20 :
   * si le jet n'en a qu'un (clic normal), on en roule un 2e À LA DEMANDE (une seule fois) ;
   * ensuite basculer entre états ne fait que re-choisir le dé gardé, sans relancer.
   * @param {object} entry  Ligne de la pile.
   * @param {string} mode   « normal » | « advantage » | « disadvantage ».
   */
  async setMode(entry, mode) {
    const a = entry?.attack;
    if (!a || a.mode === mode) return;
    if ((mode === "advantage" || mode === "disadvantage") && (a.rawDice?.length ?? 0) < 2) {
      try {
        const r = await new Roll("1d20").evaluate();
        // Animation 3D Dice So Nice, synchronisée sur tous les écrans (dont la TV), avant de
        // révéler le résultat. Repli silencieux si DSN n'est pas installé.
        if (game.dice3d) {
          try { await game.dice3d.showForRoll(r, game.user, true); } catch { /* animation optionnelle */ }
        }
        a.rawDice.push(r.total);
      } catch (err) {
        console.error("[Arthak's Table · Rolls Bar] 2e d20 :", err);
        return;
      }
    }
    a.mode = mode;
    this.render();
    // Persiste l'ajustement sur le message : Foundry propage la mise à jour à tous les écrans.
    this.persistAdjust(entry);
  }

  /**
   * Persiste l'ajustement d'état (mode + dés, dont l'éventuel 2e) sur le message de chat via un
   * flag invisible `adjust`. La mise à jour du document est propagée par Foundry à tous les
   * écrans (voir `onUpdateMessage`). N'écrit rien de visible dans le chat.
   * @param {object} entry
   */
  async persistAdjust(entry) {
    const msg = game.messages.get(entry.msgId);
    if (!msg) return;
    try {
      await msg.setFlag(MODULE_ID, "adjust", { mode: entry.attack.mode, rawDice: entry.attack.rawDice });
    } catch (err) {
      console.error("[Arthak's Table · Rolls Bar] persistAdjust :", err);
    }
  }

  // ── Actions de la pile ─────────────────────────────────────────────────────
  /** Retire une ligne de la pile (bouton ✕). */
  removeEntry(entry) {
    this.entries = this.entries.filter((e) => e !== entry);
    if (this._byOrigin.get(entry.id) === entry) this._byOrigin.delete(entry.id);
    this.render();
  }

  // ── Rendu ──────────────────────────────────────────────────────────────────
  render() {
    if (!this.el) return;
    this.el.replaceChildren();
    this.el.style.display = "flex";

    // En-tête commun (poignée · ↻ · pastille · repli) sur une ligne, AVANT le contenu.
    // La barre des jets n'a pas de titre : la pile suit directement l'en-tête.
    this.el.appendChild(this.makeHeader("rb", { icon: "fa-dice-d20" }));

    // Pile de lignes (repliable).
    const list = document.createElement("div");
    list.className = "rb-list rb-collapsible";
    if (!this.entries.length) {
      const empty = document.createElement("div");
      empty.className = "rb-empty";
      empty.textContent = t("ATS.rolls.waiting");
      list.appendChild(empty);
    } else {
      for (const entry of this.entries) list.appendChild(this.renderEntry(entry));
    }
    this.el.appendChild(list);

    // Application de l'état replié mémorisé (le bouton de repli est dans l'en-tête).
    this.applyCollapsedState();

    // Placement + orientation une fois le contenu construit (dimensions connues).
    this.applyDock();
  }

  /** Construit la ligne DOM d'un jet : ✕ · action (icône + nom) · attaque. */
  renderEntry(entry) {
    const row = document.createElement("div");
    row.className = "rb-entry";

    const remove = document.createElement("i");
    remove.className = "rb-remove fas fa-xmark";
    remove.dataset.tooltip = t("ATS.rolls.remove");
    remove.addEventListener("click", () => this.removeEntry(entry));
    row.appendChild(remove);

    // Action posée : icône + titre de l'objet source, carte de survol.
    const action = document.createElement("div");
    action.className = "rb-action";
    this.applyActionTooltip(action, entry);
    if (entry.actionImg) {
      const img = document.createElement("div");
      img.className = "rb-action-img";
      img.style.backgroundImage = `url("${entry.actionImg}")`;
      action.appendChild(img);
    }
    const name = document.createElement("span");
    name.className = "rb-action-name";
    name.textContent = entry.actionName;
    action.appendChild(name);
    row.appendChild(action);

    if (entry.attack) {
      row.appendChild(this.renderAttack(entry));
      const targets = this.renderTargets(entry);
      if (targets) row.appendChild(targets);
    }

    if (entry.damage) {
      row.appendChild(this.renderDamage(entry));
    } else if (entry.attack && entry.canControl && entry.activityUuid) {
      // Dégâts pas encore roulés : boutons de lancer (à la demande, une fois adv/dés figé).
      row.appendChild(this.renderRollDamage(entry));
    }

    return row;
  }

  /**
   * Pose le survol de l'action sur son bloc : quand l'UUID de l'objet source est connu, on
   * réutilise le TOOLTIP RICHE NATIF de dnd5e (carte identique à celle du chat : titre, sous-type,
   * description enrichie). Le système observe globalement l'activation du tooltip et remplace de
   * lui-même le `<section class="loading" data-uuid>` par la carte de l'objet (voir Tooltips5e). En
   * dernier recours (UUID non résoluble), on retombe sur un survol texte « Titre — description ».
   * @param {HTMLElement} el     Élément porteur du survol (bloc action).
   * @param {object} entry       Ligne de la pile.
   */
  applyActionTooltip(el, entry) {
    if (entry.actionUuid) {
      el.dataset.tooltip = `<section class="loading" data-uuid="${entry.actionUuid}"><i class="fas fa-spinner fa-spin-pulse"></i></section>`;
      el.dataset.tooltipClass = "dnd5e2 dnd5e-tooltip item-tooltip themed theme-light";
      el.dataset.tooltipDirection = "UP";
    } else {
      el.dataset.tooltip = entry.actionDesc ? `${entry.actionName} — ${entry.actionDesc}` : entry.actionName;
    }
  }

  /**
   * Bloc d'attaque : total (dérivé du dé gardé), détail des d20 (dé gardé mis en avant, dé
   * écarté barré), bonus, et sélecteur d'état (cliquable si on contrôle l'acteur du jet).
   * @param {object} entry
   */
  renderAttack(entry) {
    const attack = entry.attack;
    const kept = this.keptDie(attack);
    const total = kept.value != null ? kept.value + attack.bonus : null;

    const wrap = document.createElement("div");
    wrap.className = `rb-attack rb-mode-${attack.mode}`;
    // Survol du bloc d'attaque : la FORMULE du jet (pas la carte de l'action, réservée à la
    // section action — voir applyActionTooltip).
    if (attack.formula) wrap.dataset.tooltip = attack.formula;

    const totalEl = document.createElement("span");
    totalEl.className = "rb-atk-total";
    totalEl.textContent = total ?? "—";
    wrap.appendChild(totalEl);

    const dice = document.createElement("span");
    dice.className = "rb-atk-dice";
    (attack.rawDice ?? []).forEach((v, i) => {
      if (i > 0) dice.appendChild(document.createTextNode(" / "));
      const d = document.createElement("span");
      d.className = i === kept.index ? "rb-kept" : "rb-drop";
      d.textContent = v;
      dice.appendChild(d);
    });
    wrap.appendChild(dice);

    if (attack.bonus) {
      const bonus = document.createElement("span");
      bonus.className = "rb-atk-bonus";
      bonus.textContent = attack.bonus > 0 ? `+${attack.bonus}` : `${attack.bonus}`;
      wrap.appendChild(bonus);
    }

    wrap.appendChild(this.renderModeControl(entry));
    return wrap;
  }

  /**
   * Sélecteur d'état normal / avantage / désavantage. Cliquable si `entry.canControl` (bascule
   * après coup via `setMode`) ; sinon simple indicateur figé de l'état courant.
   * @param {object} entry
   */
  renderModeControl(entry) {
    const attack = entry.attack;
    const box = document.createElement("span");
    box.className = "rb-mode-ctl";

    if (!entry.canControl) {
      const badge = document.createElement("span");
      badge.className = "rb-atk-mode";
      badge.textContent = t(`ATS.rolls.mode.${attack.mode}`);
      box.appendChild(badge);
      return box;
    }

    for (const m of ["normal", "advantage", "disadvantage"]) {
      const seg = document.createElement("span");
      seg.className = `rb-mode-seg${m === attack.mode ? " rb-mode-on" : ""}`;
      seg.textContent = t(`ATS.rolls.mode.${m}`);
      seg.dataset.tooltip = t(`ATS.rolls.modeSet.${m}`);
      seg.addEventListener("click", () => this.setMode(entry, m));
      box.appendChild(seg);
    }
    return box;
  }

  /**
   * Cibles du jet avec touche/échec calculé par la barre : 20 naturel = coup critique,
   * 1 naturel = échec, sinon total (dé gardé courant + bonus) ≥ CA. Recalculé à chaque rendu,
   * donc toujours cohérent avec l'ajustement d'état. Null s'il n'y a pas de cible.
   * @param {object} entry
   */
  renderTargets(entry) {
    const targets = entry.targets ?? [];
    if (!targets.length || !entry.attack) return null;

    const kept = this.keptDie(entry.attack);
    const nat = kept.value;
    const total = nat != null ? nat + entry.attack.bonus : null;

    const box = document.createElement("div");
    box.className = "rb-targets";
    for (const tgt of targets) {
      let hit = null;
      if (nat === 20) hit = true;
      else if (nat === 1) hit = false;
      else if (Number.isFinite(tgt.ac) && total != null) hit = total >= tgt.ac;

      const chip = document.createElement("span");
      chip.className = `rb-target ${hit === true ? "rb-hit" : hit === false ? "rb-miss" : "rb-unknown"}`;
      chip.dataset.tooltip = nat === 20 ? t("ATS.rolls.crit") : nat === 1 ? t("ATS.rolls.fumble") : "";

      const icon = document.createElement("i");
      icon.className = `fas ${hit === true ? "fa-check" : hit === false ? "fa-xmark" : "fa-question"}`;
      chip.appendChild(icon);

      const name = document.createElement("span");
      name.className = "rb-target-name";
      name.textContent = tgt.name;
      chip.appendChild(name);

      if (Number.isFinite(tgt.ac)) {
        const ac = document.createElement("span");
        ac.className = "rb-target-ac";
        ac.textContent = t("ATS.rolls.ac", { ac: tgt.ac });
        chip.appendChild(ac);
      }
      box.appendChild(chip);
    }
    return box;
  }

  /**
   * Bloc dégâts : résumé cliquable (sous-total par type + total entre parenthèses), dépliable
   * pour le détail des dés. Null s'il n'y a pas de dégâts.
   * @param {object} entry
   */
  renderDamage(entry) {
    const dmg = entry.damage;
    if (!dmg) return null;
    const groups = this.damageByType(dmg);

    const box = document.createElement("div");
    box.className = `rb-damage${dmg.isHealing ? " rb-heal" : ""}`;

    const summary = document.createElement("div");
    summary.className = "rb-dmg-summary";
    summary.dataset.tooltip = t("ATS.rolls.toggleDetail");

    const caret = document.createElement("i");
    caret.className = `fas fa-caret-${entry._dmgOpen ? "down" : "right"} rb-dmg-caret`;
    summary.appendChild(caret);

    for (const g of groups) {
      const chip = document.createElement("span");
      chip.className = "rb-dmg-type";
      chip.appendChild(document.createTextNode(String(g.subtotal)));
      const label = this.damageTypeLabel(g.type);
      if (label) {
        const lbl = document.createElement("span");
        lbl.className = "rb-dmg-lbl";
        lbl.textContent = label;
        chip.appendChild(document.createTextNode(" "));
        chip.appendChild(lbl);
      }
      summary.appendChild(chip);
    }

    const total = document.createElement("span");
    total.className = "rb-dmg-total";
    total.textContent = `(${dmg.total})`;
    summary.appendChild(total);

    if (dmg.isCritical) {
      const crit = document.createElement("span");
      crit.className = "rb-dmg-crit";
      crit.textContent = t("ATS.rolls.critShort");
      summary.appendChild(crit);
    }

    summary.addEventListener("click", () => { entry._dmgOpen = !entry._dmgOpen; this.render(); });
    box.appendChild(summary);

    // Contrôles d'application (multiplicateurs qui appliquent directement) : MJ ou propriétaire.
    if (entry.canControl) box.appendChild(this.renderApplyControls(entry));

    if (entry._dmgOpen) {
      const detail = document.createElement("div");
      detail.className = "rb-dmg-detail";
      for (const g of groups) {
        const line = document.createElement("div");
        line.className = "rb-dmg-line";
        const label = this.damageTypeLabel(g.type);
        const bits = g.dice.map((d) => `${d.values.length}d${d.faces}: ${d.values.join(", ")}`);
        if (g.flat) bits.push(g.flat > 0 ? `+${g.flat}` : `${g.flat}`);
        line.textContent = `${label ? label + " — " : ""}${bits.join("  ")} = ${g.subtotal}`;
        detail.appendChild(line);
      }
      box.appendChild(detail);
    }

    return box;
  }

  /**
   * Barre d'application : toggle dégât/soin, toggle cible (ciblés/sélectionnés), puis les
   * multiplicateurs (×1 · ½ · ¼ · ×2 · Crit) qui appliquent DIRECTEMENT au clic. Le crit ne
   * double que les dés, pas le bonus.
   * @param {object} entry
   */
  renderApplyControls(entry) {
    const row = document.createElement("div");
    row.className = `rb-apply${entry.damage?.isHealing ? " rb-apply-heal" : ""}`;

    // Toggle cible : ciblés (défaut) / sélectionnés.
    const targeted = this._targetMode !== "selected";
    const tgt = document.createElement("span");
    tgt.className = "rb-apply-toggle";
    tgt.dataset.tooltip = targeted ? t("ATS.rolls.targetTargeted") : t("ATS.rolls.targetSelected");
    const tgtIcon = document.createElement("i");
    tgtIcon.className = `fas ${targeted ? "fa-crosshairs" : "fa-expand"}`;
    tgt.appendChild(tgtIcon);
    tgt.addEventListener("click", () => { this._targetMode = targeted ? "selected" : "targeted"; this.render(); });
    row.appendChild(tgt);

    // Multiplicateurs (application directe ; le crit est déjà géré au lancer).
    for (const [kind, label] of [["x1", "×1"], ["half", "½"], ["quarter", "¼"], ["x2", "×2"]]) {
      const b = document.createElement("span");
      b.className = `rb-mult rb-mult-${kind}`;
      b.textContent = label;
      b.dataset.tooltip = t(`ATS.rolls.mult.${kind}`);
      b.addEventListener("click", () => this.applyDamage(entry, kind));
      row.appendChild(b);
    }
    return row;
  }

  /**
   * Boutons de lancer des dégâts, affichés tant que les dégâts ne sont pas roulés : ⚔ Dégât
   * (crit auto si le dé gardé = 20), 💥 Crit (force le crit), 💚 Soin. Chaque bouton roule les
   * dés de l'activité à la demande.
   * @param {object} entry
   */
  renderRollDamage(entry) {
    const box = document.createElement("div");
    box.className = "rb-rolldmg";
    const nat20 = this.keptDie(entry.attack).value === 20;

    const make = (cls, icon, labelKey, hintKey, opts) => {
      const b = document.createElement("span");
      b.className = `rb-rd-btn ${cls}`;
      const i = document.createElement("i");
      i.className = `fas ${icon}`;
      b.appendChild(i);
      const s = document.createElement("span");
      s.textContent = t(labelKey);
      b.appendChild(s);
      b.dataset.tooltip = t(hintKey);
      b.addEventListener("click", () => this.rollDamage(entry, opts));
      return b;
    };

    box.appendChild(make("rb-rd-dmg", "fa-burst", "ATS.rolls.rollDamage", "ATS.rolls.rollDamageHint", { crit: nat20, heal: false }));
    box.appendChild(make("rb-rd-crit", "fa-explosion", "ATS.rolls.rollCrit", "ATS.rolls.rollCritHint", { crit: true, heal: false }));
    box.appendChild(make("rb-rd-heal", "fa-heart", "ATS.rolls.rollHeal", "ATS.rolls.rollHealHint", { crit: false, heal: true }));
    return box;
  }

  /**
   * Roule les dégâts (ou soins) de l'activité à la demande, SANS carte de chat (create:false),
   * animés en 3D (Dice So Nice) et synchronisés sur tous les écrans via un flag du message.
   * @param {object} entry
   * @param {{crit:boolean, heal:boolean}} opts
   */
  async rollDamage(entry, { crit, heal }) {
    const activity = entry.activityUuid ? fromUuidSync(entry.activityUuid, { strict: false }) : null;
    if (typeof activity?.rollDamage !== "function") { notify.warn(t("ATS.rolls.noActivity")); return; }

    let rolls;
    try {
      const config = { isCritical: !!crit };
      if (entry.attackMode) config.attackMode = entry.attackMode;
      rolls = await activity.rollDamage(config, { configure: false }, { create: false });
    } catch (err) {
      console.error("[Arthak's Table · Rolls Bar] rollDamage :", err);
      notify.warn(t("ATS.rolls.rollDamageFail"));
      return;
    }
    if (!rolls?.length) return;

    if (game.dice3d) {
      for (const r of rolls) {
        try { await game.dice3d.showForRoll(r, game.user, true); } catch { /* animation optionnelle */ }
      }
    }

    entry.damage = this.parseDamageFromRolls(rolls, heal);
    this.render();
    // Synchronise l'affichage des dégâts sur les autres écrans (même mécanisme que l'ajustement).
    this.persistDamage(entry);
  }

  /** Persiste les dégâts roulés sur le message (flag invisible), propagés à tous les écrans. */
  async persistDamage(entry) {
    const msg = game.messages.get(entry.msgId);
    if (!msg) return;
    try {
      await msg.setFlag(MODULE_ID, "damage", entry.damage);
    } catch (err) {
      console.error("[Arthak's Table · Rolls Bar] persistDamage :", err);
    }
  }

  /** Tokens destinataires selon le toggle : ciblés (T) ou sélectionnés (contrôlés). */
  resolveApplyTargets() {
    if (this._targetMode === "selected") return canvas.tokens?.controlled ?? [];
    return [...(game.user.targets ?? [])];
  }

  /**
   * Applique les dégâts (ou soins) déjà roulés au(x) token(s) selon le multiplicateur. Résolution
   * PAR CIBLE (via `actor.applyDamage`, qui gère résistances/immunités) — structure prête pour un
   * futur « demi-dégât aux cibles ayant réussi leur save ». Le sens (dégât/soin) vient de la façon
   * dont les dés ont été roulés (bouton Dégât vs Soin).
   * @param {object} entry
   * @param {string} kind  « x1 » | « half » | « quarter » | « x2 ».
   */
  async applyDamage(entry, kind) {
    const dmg = entry.damage;
    if (!dmg) return;

    const groups = this.damageByType(dmg);
    const damages = groups.map((g) => ({ value: g.subtotal, type: g.type || "" }));

    const base = { x1: 1, half: 0.5, quarter: 0.25, x2: 2 }[kind] ?? 1;
    const multiplier = dmg.isHealing ? -base : base; // multiplicateur négatif = soin

    const tokens = this.resolveApplyTargets();
    if (!tokens.length) { notify.warn(t("ATS.rolls.noTarget")); return; }

    for (const token of tokens) {
      const actor = token.actor;
      if (typeof actor?.applyDamage !== "function") { notify.warn(t("ATS.rolls.applyMissing", { name: token.name })); continue; }
      if (!actor.isOwner) { notify.warn(t("ATS.rolls.noPermission", { name: token.name })); continue; }
      try {
        await actor.applyDamage(damages, { multiplier });
      } catch (err) {
        console.error("[Arthak's Table · Rolls Bar] applyDamage :", err);
        notify.warn(t("ATS.rolls.applyFail", { name: token.name }));
      }
    }
  }

  // ── Minimiser (squelette + icône dans FloatingBar) ─────────────────────────
  get collapsedClass() { return "rb-collapsed"; }

  // ── Position / ancrage ─────────────────────────────────────────────────────
  get dockSettingKey() { return "rollsDock"; }
  get orientSettingKey() { return "rollsOrientation"; }
  get defaultEdge() { return "free"; }
  get defaultOrientation() { return "h"; }
}
