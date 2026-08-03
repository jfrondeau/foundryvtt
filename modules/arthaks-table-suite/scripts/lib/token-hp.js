/**
 * Moteur d'application des PV — source unique de vérité de la suite.
 *
 * Regroupe la logique « appliquer un delta PV à un ou plusieurs tokens » qui vivait dans
 * CombatOverlay : elle ne dépend d'AUCUN état de combat (uniquement du token / de l'acteur),
 * on la partage donc entre la barre de combat (panneau cible, édition inline du badge PV) et
 * le raccourci « / » HORS combat (petit champ flottant sur le token sélectionné).
 *
 * Convention de saisie (reprise de macro/TokenHp.js) : « 8 » = dégâts, « +8 » = soin,
 * « -8 » = dégâts. Application via le moteur natif dnd5e (`actor.applyDamage`, qui gère les
 * PV temporaires) + bascule du statut « dead » quand le solde passe sous 1.
 */

import { makeNotify, t } from "./common.js";

const notify = makeNotify("PV");

export class TokenHp {
  /** Victimes qui recevront les PV : cibles (T) en priorité, sinon sélection. */
  static resolveVictims() {
    const targets = Array.from(game.user.targets ?? []);
    if (targets.length) return targets;
    return Array.from(canvas.tokens?.controlled ?? []);
  }

  /**
   * Interprète une saisie PV (convention TokenHp.js : « 8 » = dégâts, « +8 » =
   * soin, « -8 » = dégâts) et renvoie le delta signé (négatif = dégâts), ou
   * null si vide / invalide / nul.
   */
  static parseHpDelta(rawValue) {
    const raw = String(rawValue).trim();
    if (!raw) return null;
    // Entier optionnellement signé UNIQUEMENT : rejette « 3.5 », « 1,000 », « 12x » que parseInt
    // tronquait silencieusement en 3 / 1 / 12.
    if (!/^[+-]?\d+$/.test(raw)) { notify.warn(t("ATS.combat.hpInvalid")); return null; }
    const hasSign = raw.startsWith("+") || raw.startsWith("-");
    const parsed = Number(raw);
    const delta = hasSign ? parsed : -Math.abs(parsed);
    return delta === 0 ? null : delta;
  }

  /**
   * Applique un delta PV à un seul token via le moteur natif dnd5e (applyDamage
   * gère les PV temporaires) et met à jour le statut Dead. Renvoie
   * { before, after, died } ou null si l'application a échoué / été refusée.
   */
  static async applyDeltaToToken(token, delta) {
    const actor = token.actor;
    if (!actor) { notify.warn(t("ATS.combat.noActor", { name: token.name })); return null; }
    if (typeof actor.applyDamage !== "function") { notify.warn(t("ATS.combat.applyDamageMissing", { name: token.name })); return null; }
    if (!actor.isOwner) { notify.warn(t("ATS.combat.noPermission", { name: token.name })); return null; }
    const before = actor.system?.attributes?.hp?.value;
    try {
      await actor.applyDamage(-delta); // applyDamage : positif = dégâts.
      const after = actor.system?.attributes?.hp?.value;
      // Statut Dead auto : appliqué si le solde < 1, retiré si les PV remontent.
      const dying = Number(after) < 1;
      const wasDead = TokenHp.hasDeadStatus(token);
      let died = false;
      if (dying && !wasDead) { await TokenHp.setDeadStatus(token, true); died = true; }
      else if (!dying && wasDead) await TokenHp.setDeadStatus(token, false);
      return { before, after, died };
    } catch (err) {
      notify.warn(t("ATS.combat.hpFail", { name: token.name }));
      console.error(err);
      return null;
    }
  }

  /** Applique une saisie PV à un seul token (édition inline du badge PV). */
  static async applyHpToOne(token, rawValue) {
    const delta = TokenHp.parseHpDelta(rawValue);
    if (delta === null) return;
    const res = await TokenHp.applyDeltaToToken(token, delta);
    if (!res) return;
    const label = delta < 0 ? t("ATS.combat.damage") : t("ATS.combat.heal");
    const deltaStr = `${delta > 0 ? "+" : ""}${delta}`;
    notify.info(t("ATS.combat.hpApplyOne", { label, delta: deltaStr, name: token.name, before: res.before, after: res.after }));
    if (res.died) notify.warn(t("ATS.combat.death", { names: token.name }));
  }

  /** Applique une saisie PV partagée à toutes les victimes (AoE / champ flottant). */
  static async applyHpToVictims(rawValue, victims = null) {
    const delta = TokenHp.parseHpDelta(rawValue);
    if (delta === null) return;
    // Cibles affichées si fournies (WYSIWYG), sinon résolution au vol. applyDeltaToToken ignore
    // proprement une cible dont l'acteur a disparu entre-temps.
    victims = victims ?? TokenHp.resolveVictims();
    if (!victims.length) { notify.warn(t("ATS.combat.noTargetShort")); return; }

    const log = [];
    const dead = [];
    for (const token of victims) {
      const res = await TokenHp.applyDeltaToToken(token, delta);
      if (!res) continue;
      log.push(`${token.name}: ${res.before}→${res.after}`);
      if (res.died) dead.push(token.name);
    }
    const label = delta < 0 ? t("ATS.combat.damage") : t("ATS.combat.heal");
    const deltaStr = `${delta > 0 ? "+" : ""}${delta}`;
    if (log.length) notify.info(t("ATS.combat.hpApplyMany", { label, delta: deltaStr, log: log.join(" | ") }));
    if (dead.length) notify.warn(t("ATS.combat.death", { names: dead.join(", ") }));
  }

  /** L'acteur porte-t-il le statut « dead » via l'un de ses effets ? (prédicat partagé) */
  static actorHasDead(actor) {
    return actor?.effects?.some(e => e.statuses?.has("dead") || e.flags?.core?.statusId === "dead") ?? false;
  }

  /** Le token (ou son acteur) porte-t-il le statut « dead » ? */
  static hasDeadStatus(token) {
    if (token.document?.statuses?.has("dead")) return true;
    return TokenHp.actorHasDead(token.actor);
  }

  /**
   * Applique / retire le statut « dead » (overlay tête de mort) sur l'acteur du token.
   * Repris de TokenHp.js, priorité à l'API moderne dnd5e/Foundry v14.
   */
  static async setDeadStatus(token, active) {
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

  /**
   * Petit champ PV flottant HORS combat (raccourci « / ») : ancré près du token
   * sélectionné, saisie clavier rapide (Entrée applique, Échap/blur ferme). Applique
   * aux cibles (T) sinon à la sélection, via le même moteur que le panneau de combat.
   * Renvoie true si le champ a été ouvert, false sinon (aucune victime, ou saisie déjà
   * en cours dans un champ).
   */
  static promptQuickHp() {
    // Ne pas capter la touche quand on tape déjà dans un champ.
    const ae = document.activeElement;
    if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable)) return false;
    // Un seul champ à la fois.
    document.getElementById("ats-hp-quick")?.remove();

    const victims = TokenHp.resolveVictims();
    if (!victims.length) { notify.warn(t("ATS.combat.noTarget")); return false; }

    const box = document.createElement("div");
    box.id = "ats-hp-quick";

    const caption = document.createElement("div");
    caption.className = "ats-hp-quick-caption";
    caption.textContent = victims.length > 1
      ? t("ATS.combat.targets", { count: victims.length })
      : victims[0].name;
    box.appendChild(caption);

    const input = document.createElement("input");
    input.className = "ats-hp-quick-input";
    input.type = "text";
    input.inputMode = "numeric";
    input.placeholder = t("ATS.combat.hpDeltaPlaceholder");
    input.dataset.tooltip = t("ATS.combat.hpDeltaTooltip");
    box.appendChild(input);

    const close = () => box.remove();
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        const value = input.value;
        input.value = "";
        // Applique sur les victimes GELÉES à l'ouverture (WYSIWYG), puis ferme (comme le champ AoE).
        TokenHp.applyHpToVictims(value, victims).finally(close);
      } else if (ev.key === "Escape") {
        close();
      }
    });
    // Perte du focus (clic ailleurs) SANS avoir appliqué → on ferme.
    input.addEventListener("blur", close, { once: true });

    // Positionnement à l'écran : au-dessus du 1er token visé (coordonnées monde → écran
    // via la transformée du plateau) ; repli au centre si le canvas n'est pas prêt.
    let left = window.innerWidth / 2;
    let top = window.innerHeight / 2;
    try {
      const c = victims[0].center;
      const pt = canvas.stage.worldTransform.apply(new PIXI.Point(c.x, c.y));
      left = pt.x;
      top = pt.y;
    } catch { /* repli au centre */ }
    box.style.left = `${Math.round(left)}px`;
    box.style.top = `${Math.round(top)}px`;

    document.body.appendChild(box);
    input.focus();
    input.select?.();
    return true;
  }
}
