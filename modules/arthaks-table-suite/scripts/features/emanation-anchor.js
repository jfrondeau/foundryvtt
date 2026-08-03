/**
 * Ancrage automatique des émanations — Module Foundry VTT v14 · Système dnd5e 5.x
 *
 * Quand un sort à cible « émanation » (type `radius` de dnd5e) est lancé avec le
 * placement d'un gabarit prévu (case « Placer un gabarit » laissée cochée), on REMPLACE
 * le gabarit natif — un MeasuredTemplate qu'il faut glisser-déposer à la main — par une
 * Region d'émanation CENTRÉE et ATTACHÉE au token sélectionné, exactement comme le bouton
 * Émanation de la barre de gabarits. La Region suit et tourne avec le token.
 *
 * Mécanique (deux hooks dnd5e, coopérant sur le MÊME `usageConfig`) :
 *  1) `dnd5e.preUseActivity` : avant le placement, si l'émanation est éligible et qu'un
 *     token d'ancrage existe, on met `usageConfig.create.measuredTemplate = false`. C'est
 *     le SEUL point d'annulation PROPRE du gabarit natif : `Activity#_finalizeUsage`
 *     n'appelle `#placeTemplate()` que si ce flag est vrai. (Annuler via
 *     `dnd5e.preCreateActivityTemplate` en retournant `false` ferait planter dnd5e :
 *     `AbilityTemplate.fromActivity` renvoie alors `null`, itéré par un `for…of` → erreur.)
 *  2) `dnd5e.postUseActivity` : une fois le sort résolu (consommation + montée en niveau
 *     appliquées), on crée la Region attachée via `RegionDocument.createTokenEmanation`.
 *     Si l'utilisateur a re-coché la case dans le dialogue (`results.templates` non vide),
 *     on ne fait rien — il a explicitement demandé un placement manuel.
 *
 * Couvre AUSSI l'émanation dessinée « à la main » en mode gabarit (contrôle Regions natif
 * OU bouton Émanation de la barre de gabarits), via un hook `preCreateRegion` : toute forme
 * `emanation` créée en mode gabarit et pas encore attachée est ancrée au token sélectionné.
 *
 * Piloté par le réglage MONDE `autoAnchorEmanation` (le MJ l'active pour toute la table).
 * Les hooks tournent sur le client QUI LANCE le sort (donc pas de doublon) ; c'est ce
 * client qui crée la Region (d'où la garde de permission `REGION_CREATE`).
 *
 * La Region porte le flag d'appartenance `flags.<MODULE_ID>.owner` : la poubelle de la
 * barre de gabarits (clearMine) la nettoie donc au même titre que les gabarits dessinés.
 */

import { MODULE_ID } from "../const.js";
import { makeNotify, t } from "../lib/common.js";

const NS = MODULE_ID;                          // namespace du flag d'appartenance
const notify = makeNotify("Émanation");

// Type de cible dnd5e correspondant à une émanation (cf. DND5E.areaTargetTypes.radius,
// le seul dont le gabarit est « adjustedSize », c.-à-d. dimensionné sur un token).
const EMANATION_TARGET_TYPE = "radius";

// Clé (Symbol, donc invisible à toute sérialisation / deepClone) posée sur `usageConfig`
// pour transmettre l'ancre décidée en `preUseActivity` jusqu'à la création différée en
// `postUseActivity`. On s'appuie sur le fait que le MÊME objet `usageConfig` est passé par
// référence aux deux hooks tout au long du cycle d'usage (muté en place, jamais réassigné).
const ANCHOR = Symbol("atsEmanationAnchor");

// ═══════════════════════════════════════════════════════════════════════════════
// ANCRAGE DES ÉMANATIONS
// ═══════════════════════════════════════════════════════════════════════════════
export class EmanationAnchor {
  /** Gardes d'idempotence de l'installation des hooks. */
  static _installed = false;

  /**
   * Branche les hooks du cycle d'usage des activités dnd5e (une seule fois). Appelé au
   * hook « ready ». Les hooks re-lisent le réglage à chaque appel : basculer le réglage
   * prend effet en direct, sans réinstallation.
   */
  static install() {
    if (this._installed) return;
    this._installed = true;
    Hooks.on("dnd5e.preUseActivity", (activity, usageConfig) => this._onPreUse(activity, usageConfig));
    Hooks.on("dnd5e.postUseActivity", (activity, usageConfig, results) => this._onPostUse(activity, usageConfig, results));
    Hooks.on("preCreateRegion", (doc, data, options, userId) => this._onPreCreateRegion(doc, data, userId));
    // Mémorise le dernier token contrôlé : passer au contrôle Regions désélectionne les
    // tokens, donc à la création de la région `controlled` est souvent vide. Ce repli permet
    // d'ancrer sur le token qu'on venait de sélectionner avant de dessiner.
    Hooks.on("controlToken", (token, controlled) => { if (controlled) this._lastControlledTokenId = token.id; });
    notify.info(t("ATS.emanation.ready"));
  }

  /** Id du dernier token contrôlé (repli d'ancrage quand la sélection est perdue). */
  static _lastControlledTokenId = null;

  /** Le réglage monde d'ancrage automatique est-il activé ? */
  static get enabled() {
    return game.settings.get(MODULE_ID, "autoAnchorEmanation") === true;
  }

  /**
   * Résout le token sur lequel ancrer l'émanation : le token SÉLECTIONNÉ s'il est unique,
   * sinon, en repli, l'unique token du lanceur présent sur la scène. `null` si l'ancre est
   * ambiguë (aucune sélection exploitable) — on laisse alors le placement natif.
   * @param {Activity} activity Activité dnd5e en cours de lancement.
   * @returns {TokenDocument|null}
   */
  static resolveAnchorToken(activity) {
    const controlled = canvas.tokens?.controlled ?? [];
    if (controlled.length === 1) return controlled[0].document;
    // Repli : le token du lanceur, s'il est unique sur la scène courante.
    const own = activity?.actor?.getActiveTokens?.(false, true) ?? [];
    if (own.length === 1) return own[0];
    return null;
  }

  /**
   * Avant le placement du gabarit d'un sort : supprime le gabarit natif si l'émanation est
   * éligible à l'ancrage, et mémorise le token d'ancrage pour la création différée.
   * @param {Activity} activity
   * @param {object} usageConfig Configuration d'usage (mutée en place tout au long du cycle).
   */
  static _onPreUse(activity, usageConfig) {
    if (!this.enabled) return;
    // On n'agit que si un gabarit ALLAIT être placé (case cochée par défaut / l'utilisateur).
    if (usageConfig?.create === false || !usageConfig?.create?.measuredTemplate) return;
    if (activity?.target?.template?.type !== EMANATION_TARGET_TYPE) return;
    // C'est ce client (le lanceur) qui créera la Region : il lui faut la permission.
    if (!game.user.hasPermission("REGION_CREATE")) return;

    const token = this.resolveAnchorToken(activity);
    if (!token) return; // ancre ambiguë → placement natif manuel conservé

    // Annulation PROPRE du gabarit natif (cf. en-tête). La Region sera créée en postUse.
    usageConfig.create.measuredTemplate = false;
    usageConfig[ANCHOR] = token.uuid;
  }

  /**
   * Après la résolution du sort : crée la Region d'émanation attachée au token mémorisé.
   * @param {Activity} activity
   * @param {object} usageConfig
   * @param {object} results Résultats de l'usage (dont `templates` réellement placés).
   */
  static async _onPostUse(activity, usageConfig, results) {
    const tokenUuid = usageConfig?.[ANCHOR];
    if (tokenUuid === undefined) return;
    delete usageConfig[ANCHOR];

    // L'utilisateur a re-coché « Placer un gabarit » dans le dialogue → un gabarit natif a
    // bien été placé : on n'ajoute pas de Region par-dessus (placement manuel assumé).
    if (results?.templates?.length) return;

    try {
      const token = fromUuidSync(tokenUuid);
      if (!token) return; // token disparu entre le lancer et la résolution
      const range = activity?.target?.template?.size;
      if (!(range > 0)) return;
      await this._placeEmanation(token, range, activity);
    } catch (err) {
      notify.warn(t("ATS.emanation.fail"));
      console.error(err);
    }
  }

  /**
   * Crée une Region d'émanation centrée et attachée au token, via l'API core
   * `RegionDocument.createTokenEmanation` (calcule le rayon en pixels, l'élévation et
   * l'attachement au token). Marquée du flag d'appartenance pour la poubelle de la barre.
   * @param {TokenDocument} token Token d'ancrage (persisté).
   * @param {number} rangeFeet Portée de l'émanation en unités de grille (pieds).
   * @param {Activity} activity Activité source (pour nommer d'après le sort).
   */
  static async _placeEmanation(token, rangeFeet, activity) {
    const spellName = activity?.item?.name;
    const name = spellName
      ? t("ATS.emanation.regionName", { spell: spellName, user: game.user.name })
      : `${t("ATS.template.shape.emanation")} [${game.user.name}]`;

    await CONFIG.Region.documentClass.createTokenEmanation(token, rangeFeet, {
      name,
      color: game.user.color,
      visibility: CONST.REGION_VISIBILITY.ALWAYS,
      displayMeasurements: true,
      ownership: { [game.user.id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER },
      flags: { [NS]: { owner: game.user.id, ownerName: game.user.name } },
    }, { gridBased: false });
  }

  /**
   * Émanation dessinée « à la main » en mode gabarit (contrôle Regions natif ou bouton
   * Émanation de la barre) : l'attache au token sélectionné et la centre dessus. On ne
   * touche QUE les formes `emanation` créées en mode gabarit, pas encore attachées ; les
   * vraies régions (mode gabarit inactif) sont laissées intactes. Pose aussi le flag/nom
   * d'appartenance si absent (indépendant de la barre : la poubelle nettoie ces régions).
   * @param {RegionDocument} doc Région en cours de création.
   * @param {object} data Données source de la création.
   * @param {string} userId Auteur de la création.
   */
  static _onPreCreateRegion(doc, data, userId) {
    if (userId !== game.user.id || !this.enabled) return;
    // Seulement en mode gabarit (une région-gabarit, pas une vraie région de scène) :
    // `canvas.regions.templateMode` est l'état autoritatif du bascule.
    if (!canvas.regions?.templateMode) return;
    // Seulement les émanations, et pas si déjà attachées (bouton de la barre, p. ex.).
    const shapeType = data?.shapes?.[0]?.type ?? doc.shapes?.[0]?.type;
    if (shapeType !== "emanation" || doc.attachment?.token) return;

    const token = this._resolveRegionAnchorToken(data, doc);
    if (!token) return; // ancre introuvable → région laissée telle quelle

    const update = { attachment: { token: token.id } };
    // Nom + flag d'appartenance si la barre de gabarits ne les a pas déjà posés (elle peut
    // être masquée pour cette audience, donc son hook peut ne pas tourner).
    if (!doc.flags?.[NS]?.owner) {
      update.name = `${t("ATS.template.shape.emanation")} [${game.user.name}]`;
      update.flags = { [NS]: { owner: game.user.id, ownerName: game.user.name } };
    }
    doc.updateSource(update);
  }

  /**
   * Résout le token d'ancrage d'une émanation dessinée à la main, par priorité :
   *  1) le token sélectionné (s'il est unique) ;
   *  2) le token situé sous le centre dessiné de l'émanation (le token « cliqué ») ;
   *  3) le dernier token sélectionné (la sélection est perdue en passant au contrôle Regions).
   * @param {object} data Données source de la région créée.
   * @param {RegionDocument} doc Région en cours de création.
   * @returns {TokenDocument|null}
   */
  static _resolveRegionAnchorToken(data, doc) {
    const controlled = canvas.tokens?.controlled ?? [];
    if (controlled.length === 1) return controlled[0].document;

    // Token sous le centre de la base de l'émanation (là où on a commencé à dessiner).
    const base = (data?.shapes?.[0] ?? doc.shapes?.[0])?.base;
    if (base && Number.isFinite(base.x) && Number.isFinite(base.y)) {
      const gs = canvas.grid?.size ?? 100;
      const cx = base.x + ((base.width ?? 1) * gs) / 2;
      const cy = base.y + ((base.height ?? 1) * gs) / 2;
      const hit = canvas.tokens?.placeables?.find((tk) => tk.bounds?.contains?.(cx, cy));
      if (hit) return hit.document;
    }

    if (this._lastControlledTokenId) {
      const tk = canvas.tokens?.get(this._lastControlledTokenId);
      if (tk) return tk.document;
    }
    return null;
  }
}
