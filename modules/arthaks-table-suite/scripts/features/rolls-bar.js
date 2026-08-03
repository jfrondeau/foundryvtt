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
      if (flags.targets) entry.targets = flags.targets;
      if (flags.damage) entry.damage = flags.damage;
      if (flags.saves) entry.saves = this.savesToMap(flags.saves);
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
    // Re-ciblage à chaud : cibler un token sur le canvas APRÈS le jet met à jour la dernière ligne.
    this.hookIds.targetToken = Hooks.on("targetToken", (user) => this.onTargetChange(user));
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
      // Respect de la visibilité chat : si CE client n'a pas le droit de voir le message, on
      // n'affiche pas la ligne (whisper / blind / self). Le MJ voit tout.
      if (msg.visible === false) return;

      const rollType = this.rollTypeOf(msg);
      // Pas un message de JET : peut être une CARTE D'USAGE d'un sort à sauvegarde (Flamme sacrée…),
      // captée pour afficher DD + cibles AVANT même les dégâts.
      if (!rollType) { this.maybeCaptureSaveUsage(msg); return; }

      if (rollType === "attack") this.captureAttack(msg);
      else if (rollType === "damage" || rollType === "healing") this.captureDamage(msg, rollType === "healing");
      // Jet de sauvegarde natif (bouton de la carte, feuille de perso…) : rattaché à la ligne du
      // sort dont l'acteur est une cible, pour que les joueurs puissent lancer leur save au chat.
      else if (rollType === "save") this.captureSaveRoll(msg);
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
    this.maybeAutoDamage(entry, msg);
  }

  /**
   * Roule automatiquement les dégâts d'une attaque OU d'un sort à sauvegarde dès sa capture, pour
   * épargner un clic à la table. Ne s'exécute que si le réglage `rollsAutoDamage` est actif, que la
   * ligne a une activité et pas encore de dégâts, et que CE client est l'AUTEUR du jet/de la carte —
   * règle « un seul rouleur » : le flag de dégâts (voir `persistDamage`) réplique ensuite le résultat
   * sur les autres écrans, ce qui évite un double lancer (le MJ possède aussi les jets des joueurs).
   * Pour une attaque, un 20 naturel sur le dé gardé déclenche le crit d'emblée (voir `rollDamageFor`).
   * @param {object} entry  Ligne de la pile.
   * @param {ChatMessage} msg  Message source (attaque, ou carte d'usage du sort à sauvegarde).
   */
  maybeAutoDamage(entry, msg) {
    if ((!entry?.attack && !entry?.save) || entry.damage || entry._autoRolling) return;
    if (!entry.activityUuid || !entry.canControl) return;
    if (!game.settings.get(MODULE_ID, "rollsAutoDamage")) return;
    if (msg?.author?.id !== game.user.id) return;

    entry._autoRolling = true;
    this.rollDamageFor(entry).finally(() => { entry._autoRolling = false; });
  }

  /**
   * Roule les dégâts de base d'une ligne puis applique le crit si le dé gardé est un 20 naturel.
   * Point d'entrée commun à l'auto-roll (maybeAutoDamage) et au bouton manuel (renderRollDamage) :
   * un seul lancer, le sens (dégât / soin) et le crit s'ajustent APRÈS via le sélecteur Norm/Crit/
   * Soin (voir setModifier).
   * @param {object} entry
   */
  async rollDamageFor(entry) {
    const ok = await this.rollBaseDamage(entry, { heal: false });
    // Crit d'emblée sur un 20 naturel — attaques seulement (un sort à sauvegarde ne critique pas).
    if (ok && entry.attack && this.keptDie(entry.attack)?.value === 20) await this.setModifier(entry, "crit");
  }

  /**
   * Cibles du jet (uuid d'acteur, nom, image, CA) depuis les flags dnd5e du message. L'`uuid`
   * (issu de `getTargetDescriptors`) est conservé : il permet de lancer la sauvegarde de la cible
   * et d'y appliquer les dégâts (sorts à sauvegarde), là où l'attaque n'a besoin que du nom/CA.
   */
  parseTargets(msg) {
    return (msg.flags?.dnd5e?.targets ?? []).map((tg) => ({
      uuid: tg.uuid ?? null,
      name: tg.name ?? "",
      img: tg.img ?? null,
      ac: Number(tg.ac),
    }));
  }

  /**
   * Instantané des cibles ACTUELLEMENT ciblées sur le canvas (`game.user.targets`), dans la MÊME
   * forme que `parseTargets` — l'`uuid` est celui de l'ACTEUR (comme les descripteurs dnd5e), requis
   * pour lancer la sauvegarde / appliquer les dégâts par cible. Tokens sans acteur ignorés.
   * @returns {{uuid:string,name:string,img:string,ac:number}[]}
   */
  snapshotCurrentTargets() {
    return [...(game.user.targets ?? [])]
      .filter((token) => token?.actor?.uuid)
      .map((token) => ({
        uuid: token.actor.uuid,
        name: token.actor.name ?? token.name ?? "",
        img: token.document?.texture?.src ?? token.actor.img ?? null,
        ac: Number(token.actor.system?.attributes?.ac?.value),
      }));
  }

  /**
   * Re-ciblage à chaud de la DERNIÈRE ligne : quand ce client (re)cible un token sur le canvas après
   * le jet, on remplace `entry.targets` de la ligne la plus récente par les cibles courantes, puis on
   * rend et synchronise (flag `targets`, débouncé car le ciblage émet un event par token). Les jets de
   * sauvegarde des cibles retirées sont élagués (les nouvelles restent « en attente », relançables via
   * le bouton DD). Réservé à la dernière ligne contrôlable : on ne remonte jamais aux lignes anciennes.
   * @param {User} user  Auteur du changement de ciblage (le hook est diffusé à tous les clients).
   */
  onTargetChange(user) {
    if (user !== game.user) return; // `game.user.targets` est local : seul le cibleur peut snapshotter
    const entry = this.entries[0];
    if (!entry?.canControl || !(entry.attack || entry.save)) return;

    entry.targets = this.snapshotCurrentTargets();
    if (entry.saves) {
      entry.saves = Object.fromEntries(
        Object.entries(entry.saves).filter(([uuid]) => entry.targets.some((tg) => tg.uuid === uuid)),
      );
    }
    this.render();

    // Persistance groupée : un seul flag écrit après la rafale d'events de ciblage.
    clearTimeout(this._persistTargetsTimer);
    this._persistTargetsTimer = setTimeout(() => {
      if (this._destroyed) return;
      this.persistTargets(entry);
      if (entry.save) this.persistSaves(entry);
    }, 200);
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
    const activityUuid = msg.flags?.dnd5e?.activity?.uuid ?? null;
    const save = this.parseSave(activityUuid ? fromUuidSync(activityUuid, { strict: false }) : null, msg);

    let entry = this._byOrigin.get(originId);
    if (entry) {
      entry.damage = damage;
      // Un sort à sauvegarde dont les dégâts arrivent sans carte d'usage captée : complète la ligne.
      if (save && !entry.save) entry.save = save;
      entry.activityUuid ??= activityUuid;
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
        activityUuid,
        attackMode: msg.flags?.dnd5e?.roll?.attackMode ?? null,
        targets: this.parseTargets(msg),
        attack: null,
        save,
        saves: {},
        damage,
      };
      this._byOrigin.set(originId, entry);
      this.entries.unshift(entry);
      this.trim();
    }
    this.render();
  }

  /**
   * Décrit la sauvegarde d'une activité (DD, caractéristique, effet sur réussite) pour les sorts à
   * jet de sauvegarde. Best-effort : lit d'abord l'activité résolue (`activity.save`), et retombe
   * sur le flag `damageOnSave` du message de dégâts si l'activité n'est pas résoluble.
   * @param {object|null} activity  Activité dnd5e résolue (SaveActivity), ou null.
   * @param {ChatMessage} [msg]     Message de dégâts (repli pour `onSave`).
   * @returns {({dc:number, ability:(string|null), onSave:string}|null)}
   */
  parseSave(activity, msg = null) {
    if (!activity?.save) return null;
    const dc = Number(activity.save.dc?.value);
    if (!Number.isFinite(dc)) return null;
    const ability = activity.save.ability?.first?.()
      ?? [...(activity.save.ability ?? [])][0] ?? null;
    const onSave = activity.damage?.onSave ?? msg?.flags?.dnd5e?.roll?.damageOnSave ?? "half";
    return { dc, ability, onSave };
  }

  /**
   * Capte la CARTE D'USAGE d'une activité à sauvegarde et crée/actualise sa ligne AVANT les dégâts :
   * la ligne montre alors le sort, son DD et ses cibles, chacune munie d'un bouton pour lancer sa
   * sauvegarde. Ignoré si le message n'est pas une carte d'activité à sauvegarde. La ligne est
   * indexée par son id (= `originatingMessage` des dégâts à venir), donc les dégâts la complètent.
   * @param {ChatMessage} msg
   */
  maybeCaptureSaveUsage(msg) {
    const activityUuid = msg.flags?.dnd5e?.activity?.uuid;
    if (!activityUuid) return;
    const activity = fromUuidSync(activityUuid, { strict: false });
    const save = this.parseSave(activity);
    if (!save) return; // pas une activité à sauvegarde

    const originId = msg.flags?.dnd5e?.originatingMessage ?? msg.id;
    const targets = this.parseTargets(msg);

    let entry = this._byOrigin.get(originId);
    if (entry) {
      entry.save = save;
      entry.activityUuid ??= activityUuid;
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
        canControl: this.canControl(msg),
        activityUuid,
        attackMode: null,
        targets,
        attack: null,
        save,
        saves: {},
        damage: null,
      };
      this._byOrigin.set(originId, entry);
      this.entries.unshift(entry);
      this.trim();
    }
    entry.saves ??= {};
    this.render();
    // Auto-roll des dégâts du sort (comme les attaques) si le réglage est actif — côté lanceur.
    this.maybeAutoDamage(entry, msg);
  }

  /**
   * Rattache un jet de sauvegarde NATIF (bouton de la carte, feuille…) à la ligne du sort dont
   * l'acteur est une cible — permet aux joueurs de lancer leur save au chat tout en alimentant la
   * barre. La réussite est lue sur le D20Roll (`isSuccess`, sinon total ≥ DD). Pas de persistance :
   * le message natif est diffusé à tous les clients, chacun capte le même jet.
   * @param {ChatMessage} msg
   */
  captureSaveRoll(msg) {
    const roll = msg.rolls?.[0];
    if (!roll) return;
    const actor = ChatMessage.getSpeakerActor?.(msg.speaker) ?? game.actors.get(msg.speaker?.actor);
    const uuid = actor?.uuid;
    if (!uuid) return;

    // Ligne à sauvegarde la plus récente contenant cette cible.
    const entry = this.entries.find((e) => e.save && (e.targets ?? []).some((tg) => tg.uuid === uuid));
    if (!entry) return;

    const total = Number(roll.total);
    const dc = Number.isFinite(roll.options?.target) ? roll.options.target : entry.save.dc;
    const success = roll.isSuccess ?? (Number.isFinite(dc) ? total >= dc : null);
    entry.saves ??= {};
    entry.saves[uuid] = { total, success, ability: msg.flags?.dnd5e?.roll?.ability ?? entry.save.ability };
    this.render();
  }

  /**
   * Lance la sauvegarde de TOUTES les cibles du sort en un clic (bouton « DD X CARAC »), puis rend et
   * synchronise une seule fois. Les jets se suivent (animation 3D par cible). Cibles non contrôlées
   * ignorées avec un avertissement (le MJ possède normalement les monstres ciblés).
   * @param {object} entry  Ligne du sort.
   */
  async rollAllSaves(entry) {
    if (!entry?.save) return;
    const targets = (entry.targets ?? []).filter((tg) => tg.uuid);
    if (!targets.length) { notify.warn(t("ATS.rolls.noTarget")); return; }

    // Évalue d'abord TOUTES les sauvegardes (rapide, sans animation) puis anime les dés ENSEMBLE :
    // tout tombe d'un coup au lieu de s'enchaîner cible après cible.
    const rolls = [];
    for (const tgt of targets) {
      const roll = await this.evalSave(entry, tgt);
      if (roll) rolls.push(roll);
    }
    if (!rolls.length) return;
    await this.animateRolls(rolls);
    this.render();
    this.persistSaves(entry);
  }

  /**
   * Cœur du jet de sauvegarde d'une cible : ÉVALUE (SANS carte de chat, create:false) et stocke le
   * résultat dans `entry.saves[uuid]`, mais N'ANIME PAS et ne rend/synchronise pas — l'appelant
   * groupe l'animation (tous les dés d'un coup) et le rendu. Retourne le `D20Roll`, ou null.
   * @param {object} entry
   * @param {object} tgt
   * @returns {Promise<Roll|null>}
   */
  async evalSave(entry, tgt) {
    if (!entry?.save || !tgt?.uuid) return null;
    const actor = await fromUuid(tgt.uuid);
    if (typeof actor?.rollSavingThrow !== "function") { notify.warn(t("ATS.rolls.saveMissing", { name: tgt.name })); return null; }
    if (!actor.isOwner) { notify.warn(t("ATS.rolls.noPermission", { name: tgt.name })); return null; }

    let rolls;
    try {
      rolls = await actor.rollSavingThrow(
        { ability: entry.save.ability, target: entry.save.dc },
        { configure: false },
        { create: false },
      );
    } catch (err) {
      console.error("[Arthak's Table · Rolls Bar] evalSave :", err);
      notify.warn(t("ATS.rolls.saveFail", { name: tgt.name }));
      return null;
    }
    const roll = rolls?.[0];
    if (!roll) return null;

    const total = Number(roll.total);
    const dc = entry.save.dc;
    const success = roll.isSuccess ?? (Number.isFinite(dc) ? total >= dc : null);
    entry.saves ??= {};
    entry.saves[tgt.uuid] = { total, success, ability: entry.save.ability };
    return roll;
  }

  /**
   * Persiste les jets de sauvegarde sur le message (flag invisible), propagés à tous les écrans.
   * ⚠️ Sérialisé en TABLEAU et non en objet indexé par uuid : un uuid d'acteur contient des points
   * (`Scene.x.Token.y.Actor.z`) et Foundry `expandObject` les prendrait pour des chemins imbriqués
   * s'ils étaient des CLÉS d'objet — cassant la relecture (`entry.saves[uuid]` deviendrait undefined,
   * puce grise). En tableau, l'uuid n'est qu'une VALEUR : aucun développement de chemin.
   * @param {object} entry
   */
  async persistSaves(entry) {
    const msg = game.messages.get(entry.msgId);
    if (!msg) return;
    try {
      const arr = Object.entries(entry.saves ?? {}).map(([uuid, r]) => ({ uuid, ...r }));
      await msg.setFlag(MODULE_ID, "saves", arr);
    } catch (err) {
      console.error("[Arthak's Table · Rolls Bar] persistSaves :", err);
    }
  }

  /** Reconstruit la map { uuid → résultat } depuis le flag `saves` (tableau, cf. `persistSaves`). */
  savesToMap(saves) {
    if (Array.isArray(saves)) return Object.fromEntries(saves.filter((r) => r?.uuid).map((r) => [r.uuid, r]));
    return saves ?? {};
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
      const { dice } = this.extractDice(roll);
      parts.push({ type, subtotal, formula: roll.formula, dice });
    }
    const isCritical = (rolls ?? []).some((r) => r.options?.isCritical || r.isCritical);
    return { parts, total, isCritical, isHealing: !!isHealing };
  }

  /**
   * Extrait les dés gardés d'un `Roll` évalué (faces + valeurs actives, hors dés écartés/relancés)
   * et leur somme. Mutualisé entre la capture d'un message et le lancer des dés critiques.
   * @param {Roll} roll
   * @returns {{ dice:{faces:number,values:number[]}[], sum:number }}
   */
  extractDice(roll) {
    const dice = [];
    let sum = 0;
    for (const term of roll.terms ?? []) {
      if (Array.isArray(term.results) && term.faces) {
        const values = term.results.filter((r) => r.active !== false && !r.discarded && !r.rerolled).map((r) => r.result);
        dice.push({ faces: term.faces, values });
        sum += values.reduce((a, b) => a + b, 0);
      }
    }
    return { dice, sum };
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
    this.el.appendChild(this.makeHeader("rb", { icon: "fa-dice-d20", title: t("ATS.menu.rolls.label") }));

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
    } else if (entry.save) {
      // Sort à sauvegarde : section Sauvegarde (DD) PUIS section Cibles, séparées comme Attaque|Cibles.
      row.appendChild(this.renderSaveDC(entry));
      const targets = this.renderTargets(entry);
      if (targets) row.appendChild(targets);
    }

    if (entry.damage) {
      row.appendChild(this.renderDamage(entry));
      // Applicateur : SECTION À PART (son propre div), à droite du résultat après un séparateur. Pour
      // un sort à sauvegarde, l'applicateur respecte le jet de chaque cible (plein / selon onSave).
      if (entry.canControl) {
        row.appendChild(entry.save ? this.renderSaveApply(entry) : this.renderApplyControls(entry));
      }
    } else if (entry.canControl && entry.activityUuid && (entry.attack || entry.save)
      && !game.settings.get(MODULE_ID, "rollsAutoDamage")) {
      // Icône de lancer à la demande (attaque ou sort à sauvegarde), seulement quand l'auto-roll est
      // désactivé — sinon les dégâts se remplissent seuls à la capture (voir maybeAutoDamage).
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

    // Ligne interne « résultat » (total + dés + bonus) : garde total/dés/bonus sur UNE ligne, sous
    // laquelle le sélecteur d'état se place — sans élargir le bloc (colonne ajustée au contenu).
    const line = document.createElement("div");
    line.className = "rb-atk-line";

    const totalEl = document.createElement("span");
    totalEl.className = "rb-atk-total";
    totalEl.textContent = total ?? "—";
    line.appendChild(totalEl);

    const dice = document.createElement("span");
    dice.className = "rb-atk-dice";
    (attack.rawDice ?? []).forEach((v, i) => {
      if (i > 0) dice.appendChild(document.createTextNode(" / "));
      const d = document.createElement("span");
      d.className = i === kept.index ? "rb-kept" : "rb-drop";
      d.textContent = v;
      dice.appendChild(d);
    });
    line.appendChild(dice);

    if (attack.bonus) {
      const bonus = document.createElement("span");
      bonus.className = "rb-atk-bonus";
      bonus.textContent = attack.bonus > 0 ? `+${attack.bonus}` : `${attack.bonus}`;
      line.appendChild(bonus);
    }

    wrap.appendChild(line);
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
   * Section « Cibles », commune à l'attaque et au sort à sauvegarde : une puce par cible, colorée
   * vert/rouge, JAMAIS cliquable (le lancer se fait ailleurs — dé au clic pour l'attaque, libellé DD
   * pour le sort). Aiguille selon le type de ligne. Null s'il n'y a pas de cible.
   * @param {object} entry
   */
  renderTargets(entry) {
    if (!(entry.targets ?? []).length) return null;
    if (entry.attack) return this.renderAttackTargets(entry);
    if (entry.save) return this.renderSaveTargets(entry);
    return null;
  }

  /**
   * Cibles d'une ATTAQUE avec touche/échec calculé par la barre : 20 naturel = coup critique,
   * 1 naturel = échec, sinon total (dé gardé courant + bonus) ≥ CA. Recalculé à chaque rendu,
   * donc toujours cohérent avec l'ajustement d'état.
   * @param {object} entry
   */
  renderAttackTargets(entry) {
    const targets = entry.targets ?? [];
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

  /** Libellé court et localisé d'une caractéristique (via CONFIG.DND5E), en majuscules. */
  abilityLabel(ability) {
    if (!ability) return "";
    const cfg = CONFIG?.DND5E?.abilities?.[ability];
    const label = cfg?.abbreviation ?? cfg?.label ?? ability;
    return t(label).toUpperCase();
  }

  /**
   * Section « Sauvegarde » d'un sort (analogue de la section Attaque) : le seul libellé « DD X CARAC »,
   * détaché par son propre filet séparateur. Cliquable si on contrôle la scène : lance la sauvegarde
   * de TOUTES les cibles d'un coup (le résultat s'affiche ensuite dans la section Cibles voisine) ;
   * sinon survol = rappel de l'effet sur réussite.
   * @param {object} entry
   */
  renderSaveDC(entry) {
    const save = entry.save;
    const box = document.createElement("div");
    box.className = "rb-saves";

    const dc = document.createElement("span");
    dc.className = "rb-save-dc";
    dc.textContent = t("ATS.rolls.saveDC", { dc: save.dc, ability: this.abilityLabel(save.ability) });
    if (entry.canControl && (entry.targets ?? []).some((tg) => tg.uuid)) {
      dc.classList.add("rb-clickable");
      dc.dataset.tooltip = t("ATS.rolls.rollAllSaves");
      dc.addEventListener("click", () => this.rollAllSaves(entry));
    } else {
      dc.dataset.tooltip = t(`ATS.rolls.onSave.${save.onSave ?? "half"}`);
    }
    box.appendChild(dc);
    return box;
  }

  /**
   * Section « Cibles » d'un sort à sauvegarde, RÉUTILISANT le rendu des cibles d'attaque (puces
   * `rb-target`, non cliquables) : réussite de la save = vert, échec = rouge (même polarité couleur
   * que touché/manqué), le total du jet remplace la CA. Recalculée à chaque rendu depuis `entry.saves`.
   * @param {object} entry
   */
  renderSaveTargets(entry) {
    const box = document.createElement("div");
    box.className = "rb-targets";
    for (const tgt of entry.targets ?? []) {
      const res = tgt.uuid ? entry.saves?.[tgt.uuid] ?? null : null;
      const success = res?.success ?? null;

      const chip = document.createElement("span");
      chip.className = `rb-target ${success === true ? "rb-hit" : success === false ? "rb-miss" : "rb-unknown"}`;
      if (res) chip.dataset.tooltip = success ? t("ATS.rolls.saved") : t("ATS.rolls.failed");

      const icon = document.createElement("i");
      icon.className = `fas ${success === true ? "fa-check" : success === false ? "fa-xmark" : "fa-question"}`;
      chip.appendChild(icon);

      const name = document.createElement("span");
      name.className = "rb-target-name";
      name.textContent = tgt.name;
      chip.appendChild(name);

      if (res) {
        const total = document.createElement("span");
        total.className = "rb-target-ac";
        total.textContent = res.total;
        chip.appendChild(total);
      }
      box.appendChild(chip);
    }
    return box;
  }

  /**
   * Applicateur d'un sort à sauvegarde : un seul bouton qui applique les dégâts À CHAQUE cible selon
   * son jet (échec = plein, réussite = selon `onSave`). Remplace les multiplicateurs manuels, sans
   * objet du toggle ciblés/sélectionnés (les cibles sont celles du sort). Survol = rappel de l'effet.
   * @param {object} entry
   */
  renderSaveApply(entry) {
    const row = document.createElement("div");
    row.className = "rb-apply rb-apply-save";

    const b = document.createElement("span");
    b.className = "rb-save-apply";
    b.dataset.tooltip = t("ATS.rolls.applySaveHint", { onSave: t(`ATS.rolls.onSave.${entry.save?.onSave ?? "half"}`) });
    const i = document.createElement("i");
    i.className = "fas fa-shield-halved";
    b.appendChild(i);
    const lbl = document.createElement("span");
    lbl.className = "rb-save-apply-lbl";
    lbl.textContent = t("ATS.rolls.applySave");
    b.appendChild(lbl);
    b.addEventListener("click", () => this.applySaveDamage(entry));
    row.appendChild(b);
    return row;
  }

  /**
   * Applique les dégâts d'un sort à sauvegarde à CHAQUE cible du sort selon son jet : échec (ou save
   * non lancé) = plein ; réussite = selon `onSave` (aucun / moitié / plein). Résolution par acteur
   * (via `actor.applyDamage`, qui gère résistances/immunités), une seule fois par cible.
   * @param {object} entry
   */
  async applySaveDamage(entry) {
    const dmg = entry.damage;
    if (!dmg) { notify.warn(t("ATS.rolls.noDamageYet")); return; }
    const targets = (entry.targets ?? []).filter((tg) => tg.uuid);
    if (!targets.length) { notify.warn(t("ATS.rolls.noTarget")); return; }

    const damages = this.buildApplyDamages(dmg);
    const onSaveMult = { none: 0, half: 0.5, full: 1 }[entry.save?.onSave] ?? 0.5;

    for (const tgt of targets) {
      const actor = await fromUuid(tgt.uuid);
      if (typeof actor?.applyDamage !== "function") { notify.warn(t("ATS.rolls.applyMissing", { name: tgt.name })); continue; }
      if (!actor.isOwner) { notify.warn(t("ATS.rolls.noPermission", { name: tgt.name })); continue; }
      // Un SOIN n'est pas réduit par une sauvegarde : plein pour tous. Un dégât applique la réduction
      // selon le jet (échec/non-lancé = plein, réussite = onSave). Multiplicateur TOUJOURS positif :
      // le sens (soin) vient du type « healing » dans `damages` (voir buildApplyDamages).
      const multiplier = dmg.isHealing ? 1 : (entry.saves?.[tgt.uuid]?.success === true ? onSaveMult : 1);
      if (multiplier === 0) continue; // sauvegarde réussie sans dégât résiduel
      try {
        await actor.applyDamage(damages, { multiplier });
      } catch (err) {
        console.error("[Arthak's Table · Rolls Bar] applySaveDamage :", err);
        notify.warn(t("ATS.rolls.applyFail", { name: tgt.name }));
      }
    }
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

    // Comme l'attaque : RÉSULTAT en haut, MODIFICATEUR (bascule Norm / Crit) en dessous. Le toggle
    // n'existe que pour les dégâts roulés par la barre (présence de `baseParts`) ; pour des dégâts
    // captés d'un message natif, simple badge statique inline dans le résumé. L'applicateur est une
    // section à part (voir renderEntry).
    const togglable = !!((entry.attack || entry.save) && entry.canControl && dmg.baseParts);

    const summary = document.createElement("div");
    summary.className = "rb-dmg-summary";
    // Détail des dés au SURVOL (harmonisé avec la formule d'attaque), plutôt qu'un dépli au clic.
    summary.dataset.tooltip = this.damageDetailTooltip(groups);

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

    if (!togglable && dmg.isCritical) {
      const crit = document.createElement("span");
      crit.className = "rb-dmg-crit";
      crit.textContent = t("ATS.rolls.critShort");
      summary.appendChild(crit);
    }

    box.appendChild(summary);
    // Modificateur Norm / Crit / Soin SOUS le résultat (comme la ligne d'attaque).
    if (togglable) box.appendChild(this.renderModifierControl(entry));
    return box;
  }

  /**
   * Construit le détail des dés d'un jet de dégâts pour le TOOLTIP de survol : une ligne par type
   * (« Feu — 2d6: 3, 5  +2 = 10 »), lignes jointes par `<br>` (le tooltip Foundry rend le HTML).
   * @param {{ type:string, subtotal:number, dice:{faces:number,values:number[]}[], flat:number }[]} groups
   * @returns {string}
   */
  damageDetailTooltip(groups) {
    return groups.map((g) => {
      const label = this.damageTypeLabel(g.type);
      const bits = g.dice.map((d) => `${d.values.length}d${d.faces}: ${d.values.join(", ")}`);
      if (g.flat) bits.push(g.flat > 0 ? `+${g.flat}` : `${g.flat}`);
      return `${label ? label + " — " : ""}${bits.join("  ")} = ${g.subtotal}`;
    }).join("<br>");
  }

  /**
   * Sélecteur de modificateur des dégâts, 3 états : Norm / Crit / Soin (voir `setModifier`). L'état
   * courant se dérive de `isHealing` (Soin) et `isCritical` (Crit), sinon Norm.
   * @param {object} entry
   */
  renderModifierControl(entry) {
    const dmg = entry.damage;
    const current = dmg.isHealing ? "heal" : dmg.isCritical ? "crit" : "normal";
    const box = document.createElement("span");
    box.className = "rb-crit-ctl";
    // Un sort à sauvegarde ne peut pas être critique : on n'offre que Norm / Soin.
    const modes = entry.save ? ["normal", "heal"] : ["normal", "crit", "heal"];
    for (const key of modes) {
      const seg = document.createElement("span");
      seg.className = `rb-crit-seg rb-mod-${key}${current === key ? " rb-crit-on" : ""}`;
      seg.textContent = t(`ATS.rolls.critToggle.${key}`);
      seg.dataset.tooltip = t(`ATS.rolls.critSet.${key}`);
      seg.addEventListener("click", () => this.setModifier(entry, key));
      box.appendChild(seg);
    }
    return box;
  }

  /**
   * Barre d'application : multiplicateurs (×1 · ½ · ¼ · ×2) qui appliquent DIRECTEMENT au clic,
   * puis EN DERNIER le toggle de cible (ciblés / sélectionnés). Le crit ne double que les dés.
   * @param {object} entry
   */
  renderApplyControls(entry) {
    const row = document.createElement("div");
    row.className = `rb-apply${entry.damage?.isHealing ? " rb-apply-heal" : ""}`;

    // Multiplicateurs (application directe ; le crit est déjà géré au lancer).
    for (const [kind, label] of [["x1", "×1"], ["half", "½"], ["quarter", "¼"], ["x2", "×2"]]) {
      const b = document.createElement("span");
      b.className = `rb-mult rb-mult-${kind}`;
      b.textContent = label;
      b.dataset.tooltip = t(`ATS.rolls.mult.${kind}`);
      b.addEventListener("click", () => this.applyDamage(entry, kind));
      row.appendChild(b);
    }

    // Toggle cible EN DERNIER : ciblés (défaut) / sélectionnés.
    const targeted = this._targetMode !== "selected";
    const tgt = document.createElement("span");
    tgt.className = "rb-apply-toggle";
    tgt.dataset.tooltip = targeted ? t("ATS.rolls.targetTargeted") : t("ATS.rolls.targetSelected");
    const tgtIcon = document.createElement("i");
    tgtIcon.className = `fas ${targeted ? "fa-crosshairs" : "fa-expand"}`;
    tgt.appendChild(tgtIcon);
    tgt.addEventListener("click", () => { this._targetMode = targeted ? "selected" : "targeted"; this.render(); });
    row.appendChild(tgt);
    return row;
  }

  /**
   * Icône unique de lancer des dégâts, affichée tant qu'ils ne sont pas roulés ET que l'auto-roll
   * est désactivé (voir renderEntry). Un clic roule les dégâts de base (crit auto sur un 20
   * naturel) ; le sens (dégât / soin) et le crit s'ajustent ensuite via le sélecteur Norm/Crit/Soin.
   * @param {object} entry
   */
  renderRollDamage(entry) {
    const box = document.createElement("div");
    box.className = "rb-rolldmg";

    const b = document.createElement("span");
    b.className = "rb-rd-btn rb-rd-dmg";
    const i = document.createElement("i");
    i.className = "fas fa-burst";
    b.appendChild(i);
    b.dataset.tooltip = t("ATS.rolls.rollDamageHint");
    b.addEventListener("click", () => this.rollDamageFor(entry));
    box.appendChild(b);
    return box;
  }

  /**
   * Roule les dégâts (ou soins) de BASE de l'activité — jamais critiques : le crit est un DELTA
   * ajouté ensuite (voir `setModifier`), pour rester basculable sans relancer les dés de base. SANS
   * carte de chat (create:false), animés en 3D (Dice So Nice), synchronisés via un flag du message.
   * @param {object} entry
   * @param {{heal:boolean}} opts
   * @returns {Promise<boolean>}  Vrai si des dégâts ont été roulés.
   */
  async rollBaseDamage(entry, { heal }) {
    const activity = entry.activityUuid ? fromUuidSync(entry.activityUuid, { strict: false }) : null;
    if (typeof activity?.rollDamage !== "function") { notify.warn(t("ATS.rolls.noActivity")); return false; }

    let rolls;
    try {
      const config = { isCritical: false };
      if (entry.attackMode) config.attackMode = entry.attackMode;
      rolls = await activity.rollDamage(config, { configure: false }, { create: false });
    } catch (err) {
      console.error("[Arthak's Table · Rolls Bar] rollBaseDamage :", err);
      notify.warn(t("ATS.rolls.rollDamageFail"));
      return false;
    }
    if (!rolls?.length) return false;

    await this.animateRolls(rolls);

    const dmg = this.parseDamageFromRolls(rolls, heal);
    // Dés de base FIGÉS : le crit ajoutera un jeu de dés à part (critParts), sans les toucher.
    dmg.baseParts = dmg.parts;
    dmg.critParts = null;
    dmg.isCritical = false;
    this.recomputeDamage(dmg);
    entry.damage = dmg;
    this.render();
    // Synchronise l'affichage des dégâts sur les autres écrans (même mécanisme que l'ajustement).
    this.persistDamage(entry);
    return true;
  }

  /**
   * Applique le modificateur des dégâts déjà roulés APRÈS coup, sélecteur à 3 états :
   *  - « normal » : dégâts de base ;
   *  - « crit »   : ajoute le delta de dés critiques (un jeu de dés de même composition que la base
   *                 = doublement des dés, bonus plat jamais doublé), roulé UNE fois puis mis en
   *                 cache (basculer n'ajoute/retire que ce delta, sans relancer) ;
   *  - « heal »   : marque le résultat comme SOIN (appliqué en gain de PV, teinté vert), sans
   *                 critique — utile en mode auto-roll où l'on ne choisit plus au lancer.
   * Ne s'applique qu'aux dégâts roulés par la barre (présence de `baseParts`).
   * @param {object} entry  Ligne de la pile.
   * @param {string} mode   « normal » | « crit » | « heal ».
   */
  async setModifier(entry, mode) {
    const dmg = entry?.damage;
    if (!dmg?.baseParts) return;
    const crit = mode === "crit";
    const heal = mode === "heal";
    if (!!dmg.isCritical === crit && !!dmg.isHealing === heal) return;

    if (crit) await this.ensureCritDice(entry);
    dmg.isCritical = crit;
    dmg.isHealing = heal;
    this.recomputeDamage(dmg);
    this.render();
    this.persistDamage(entry);
  }

  /**
   * Roule (une seule fois) et met en cache les dés critiques additionnels sur `dmg.critParts`, à
   * partir de la composition des dés de base. Sans effet si déjà en cache ou si aucun dé de base.
   * @param {object} entry
   */
  async ensureCritDice(entry) {
    const dmg = entry?.damage;
    if (!dmg?.baseParts || dmg.critParts) return;
    const critParts = [];
    const rolls = [];
    for (const part of dmg.baseParts) {
      const formula = this.critFormulaFor(part);
      if (!formula) continue; // part sans dé (bonus plat seul) : pas de dé critique
      let roll;
      try {
        roll = await new Roll(formula).evaluate();
      } catch (err) {
        console.error("[Arthak's Table · Rolls Bar] dés critiques :", err);
        continue;
      }
      rolls.push(roll);
      const { dice, sum } = this.extractDice(roll);
      critParts.push({ type: part.type, subtotal: sum, formula, dice });
    }
    // Tous les dés critiques (un par type) animés ENSEMBLE.
    await this.animateRolls(rolls);
    dmg.critParts = critParts;
  }

  /**
   * Formule des dés critiques d'une part = un jeu de dés identique à ses dés de base (regroupés par
   * face), p.ex. « 2d6 + 1d4 ». Chaîne vide si la part n'a aucun dé (bonus plat seul).
   * @param {{dice:{faces:number,values:number[]}[]}} part
   * @returns {string}
   */
  critFormulaFor(part) {
    const byFaces = new Map();
    for (const d of part.dice ?? []) {
      if (d.faces && d.values?.length) byFaces.set(d.faces, (byFaces.get(d.faces) ?? 0) + d.values.length);
    }
    return [...byFaces.entries()].map(([faces, count]) => `${count}d${faces}`).join(" + ");
  }

  /**
   * Recompose les parts et le total EFFECTIFS d'un objet dégâts depuis ses dés de base et — si le
   * crit est actif — ses dés critiques. Appelé après chaque roll ou bascule d'état.
   * @param {object} dmg
   */
  recomputeDamage(dmg) {
    const parts = [...(dmg.baseParts ?? [])];
    if (dmg.isCritical && dmg.critParts) parts.push(...dmg.critParts);
    dmg.parts = parts;
    dmg.total = parts.reduce((s, p) => s + (Number(p.subtotal) || 0), 0);
  }

  /**
   * Anime une série de jets en 3D (Dice So Nice), synchronisés sur tous les écrans (dont la TV).
   * Repli silencieux si DSN n'est pas installé.
   * @param {Roll[]} rolls
   */
  async animateRolls(rolls) {
    if (!game.dice3d) return;
    // En PARALLÈLE : tous les dés d'un même lot (un 1d6 + 1d4, ou toutes les sauvegardes d'un
    // sort) tombent ENSEMBLE plutôt qu'en file. `Promise.all` attend la fin de la dernière anim.
    await Promise.all((rolls ?? []).map((r) =>
      Promise.resolve(game.dice3d.showForRoll(r, game.user, true)).catch(() => { /* animation optionnelle */ }),
    ));
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

  /**
   * Persiste les cibles re-ciblées à chaud sur le message (flag invisible), propagées à tous les
   * écrans via `onUpdateMessage`. Sûr en tableau tel quel : l'uuid d'acteur (avec ses points) n'est
   * qu'une VALEUR ici, jamais une clé d'objet — aucun développement de chemin par `expandObject`.
   * @param {object} entry
   */
  async persistTargets(entry) {
    const msg = game.messages.get(entry.msgId);
    if (!msg) return;
    try {
      await msg.setFlag(MODULE_ID, "targets", entry.targets ?? []);
    } catch (err) {
      console.error("[Arthak's Table · Rolls Bar] persistTargets :", err);
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

    const damages = this.buildApplyDamages(dmg);
    // Multiplicateur TOUJOURS positif : le soin passe par le TYPE « healing » (voir buildApplyDamages),
    // que dnd5e négative de lui-même. Un multiplicateur négatif provoquerait une double négation sur
    // un vrai soin (type déjà « healing ») → dégâts au lieu de soins.
    const multiplier = { x1: 1, half: 0.5, quarter: 0.25, x2: 2 }[kind] ?? 1;

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

  /**
   * Construit le tableau `damages` passé à `actor.applyDamage`, en respectant le SENS (dégât/soin).
   * ⚠️ dnd5e ne pilote PAS le soin par le signe du multiplicateur mais par le TYPE de dégât : une
   * entrée de type « healing » est négativée par `calculateDamage` (donc soigne). On envoie donc, en
   * mode soin, un unique lot `{ value: total, type: "healing" }` (multiplicateur positif) — fiable
   * pour un dégât basculé en soin comme pour un vrai sort de soin (type déjà « healing », qui serait
   * doublement négativé par un multiplicateur négatif → dégâts).
   * @param {object} dmg  Objet dégâts de la ligne.
   * @returns {{value:number, type:string}[]}
   */
  buildApplyDamages(dmg) {
    const groups = this.damageByType(dmg);
    if (dmg.isHealing) {
      const total = groups.reduce((s, g) => s + (Number(g.subtotal) || 0), 0);
      return [{ value: total, type: "healing" }];
    }
    return groups.map((g) => ({ value: g.subtotal, type: g.type || "" }));
  }

  // ── Minimiser (squelette + icône dans FloatingBar) ─────────────────────────
  get collapsedClass() { return "rb-collapsed"; }

  // ── Position / ancrage ─────────────────────────────────────────────────────
  get dockSettingKey() { return "rollsDock"; }
  get orientSettingKey() { return "rollsOrientation"; }
  get defaultEdge() { return "free"; }
  get defaultOrientation() { return "h"; }
}
