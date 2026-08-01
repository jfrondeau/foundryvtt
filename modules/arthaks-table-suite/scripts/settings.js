/**
 * Enregistrement centralisé des réglages et raccourcis de la suite.
 *
 * Il n'y a PAS de réglage « Activer » par barre : une barre tourne sur un client dès que
 * l'audience de ce client ne la masque pas (matrice de masquage, cf. hide-hud.js). Les
 * réglages PROPRES à chaque barre sont enregistrés en `config: false` et présentés dans un
 * panneau dédié (bouton « Configurer… » via registerMenu), pour garder la page de
 * configuration native courte et lisible.
 *
 * i18n : toutes les chaînes visibles sont des CLÉS (namespace « ATS. », cf. lang/*.json).
 * Foundry localise automatiquement les `name`/`hint`/`label` des réglages, menus et
 * keybindings, ainsi que les valeurs de `choices` et le `window.title` des panneaux.
 */
import { MODULE_ID } from "./const.js";
import { BARS } from "./features/registry.js";
import { SpellTemplateBar } from "./features/template-bar.js";
import { CombatOverlay } from "./features/combat-bar.js";
import { TokenActionBar } from "./features/token-bar.js";
import { HideHud, HideConfig, HIDE_DEFAULTS } from "./features/hide-hud.js";
import { makeSettingsPanel } from "./lib/settings-panel.js";
import { FloatingBar } from "./lib/floating-bar.js";

/**
 * Bord d'ancrage des barres flottantes : « Libre » (glisser-déposer, position
 * continue mémorisée) ou un bord de l'écran. L'orientation est INDÉPENDANTE du bord
 * (réglage séparé + bouton ↻) ; la position le long du bord est continue et posée au
 * glisser. Voir FloatingBar.applyDock. (Valeurs = clés i18n, localisées par Foundry.)
 */
const EDGE_CHOICES = {
  free: "ATS.choices.edge.free",
  top: "ATS.choices.edge.top",
  bottom: "ATS.choices.edge.bottom",
  left: "ATS.choices.edge.left",
  right: "ATS.choices.edge.right",
};

/** Orientation de la barre, indépendante du bord (bascule aussi via le bouton ↻). */
const ORIENT_CHOICES = { h: "ATS.choices.orient.h", v: "ATS.choices.orient.v" };

/** Choix d'image commun aux réglages imageMode / featuredImageMode. */
const IMAGE_CHOICES = { actor: "ATS.choices.image.actor", token: "ATS.choices.image.token" };

// ── Panneaux de configuration par barre (bouton « Configurer… ») ──────────────
// Chaque panneau présente les clés listées, dans cet ordre. Les réglages restent
// enregistrés plus bas (avec name/hint/onChange) mais en `config: false`.
// Chaque panneau présente aussi « dockMargin » (réglage GLOBAL commun aux barres) :
// c'est le seul accès à ce réglage quand le HUD joueur est masqué (les panneaux par
// barre s'ouvrent alors par clic droit sur la poignée, hors page de config native).
const TemplateBarConfig = makeSettingsPanel(
  "ats-template-config", "ATS.panel.template.title", "fa-solid fa-ruler-combined",
  ["templateDock", "templateOrientation", "dockMargin", "templateButtonSize"],
);

const CombatBarConfig = makeSettingsPanel(
  "ats-combat-config", "ATS.panel.combat.title", "fa-solid fa-swords",
  [
    "combatDock", "combatOrientation", "dockMargin", "combatCurrentInline", "showImages", "imageMode", "featuredImageMode",
    "hideInitInCombat", "showNextButton", "rowSize", "currentImageSize",
    "autoControlToken", "autoPanToken",
  ],
);

const TokenBarConfig = makeSettingsPanel(
  "ats-token-config", "ATS.panel.token.title", "fa-solid fa-hand-fist",
  [
    "dockPosition", "tokenOrientation", "dockMargin", "tokenButtonSize", "includeInventory", "onlyEquippedWeapons",
    "includeFeatures", "includeSpells", "showGroupLabels", "dedupeByName",
    "alwaysShowFeatureNames",
  ],
);

/**
 * Descripteur du bouton « Configurer… » (registerMenu) de chaque barre, associé à
 * sa classe. Chaque bouton ouvre le panneau de réglages propres à la barre.
 */
const BAR_MENUS = new Map([
  [SpellTemplateBar, {
    menuKey: "templateBarMenu", panel: TemplateBarConfig, icon: "fa-solid fa-ruler-combined",
    label: "ATS.menu.template.label", hint: "ATS.menu.template.hint",
  }],
  [CombatOverlay, {
    menuKey: "combatBarMenu", panel: CombatBarConfig, icon: "fa-solid fa-swords",
    label: "ATS.menu.combat.label", hint: "ATS.menu.combat.hint",
  }],
  [TokenActionBar, {
    menuKey: "tokenBarMenu", panel: TokenBarConfig, icon: "fa-solid fa-hand-fist",
    label: "ATS.menu.token.label", hint: "ATS.menu.token.hint",
  }],
]);

/**
 * Enregistre le réglage de BORD d'ancrage d'une barre (présenté dans son panneau).
 * @param {string} key      Clé du réglage (déclarée par la barre via `dockSettingKey`).
 * @param {string} name     Clé i18n du libellé affiché.
 * @param {string} def      Bord par défaut (« free » | top | bottom | left | right).
 * @param {() => void} onChange Rappel appliquant l'ancrage sur l'instance vivante.
 */
function registerDock(key, name, def, onChange) {
  game.settings.register(MODULE_ID, key, {
    name,
    hint: "ATS.dock.hint",
    scope: "client", config: false, type: String,
    choices: EDGE_CHOICES,
    default: def,
    onChange,
  });
}

/**
 * Enregistre le réglage d'ORIENTATION d'une barre (indépendant du bord ; bouton ↻).
 * @param {string} key      Clé du réglage (déclarée par la barre via `orientSettingKey`).
 * @param {() => void} onChange Rappel appliquant l'orientation sur l'instance vivante.
 */
function registerOrientation(key, onChange) {
  game.settings.register(MODULE_ID, key, {
    name: "ATS.orient.name",
    hint: "ATS.orient.hint",
    scope: "client", config: false, type: String,
    choices: ORIENT_CHOICES,
    default: "h",
    onChange,
  });
}

/** Enregistre tous les réglages de la suite (appelé au hook « init »). */
export function registerSettings() {
  // ── Bouton « Configurer… » par barre ────────────────────────────────────────
  // Plus de case « Activer » : une barre tourne dès qu'une audience l'affiche (matrice de
  // masquage). On n'enregistre que le panneau de réglages propres à chaque barre.
  for (const { cls } of BARS) {
    const meta = BAR_MENUS.get(cls);
    if (!meta) continue;
    // Rend le panneau accessible depuis la barre elle-même (clic droit sur la
    // poignée → FloatingBar.openSettings), seul accès quand le HUD est masqué.
    cls.SettingsPanel = meta.panel;
    // restricted:false → le bouton apparaît AUSSI dans les réglages des joueurs : ils
    // personnalisent leur propre écran (réglages de portée client). Le panneau désactive
    // de lui-même les réglages de portée monde côté joueur (settings-panel.js), donc rien
    // de sensible n'est modifiable. Le masquage MJ (hideMenu), lui, reste restreint.
    game.settings.registerMenu(MODULE_ID, meta.menuKey, {
      name: meta.label,
      label: meta.label,
      hint: meta.hint,
      icon: meta.icon,
      type: meta.panel,
      restricted: false,
    });
  }

  // ── Ancrage commun à toutes les barres (réglage global, visible) ────────────
  game.settings.register(MODULE_ID, "dockMargin", {
    name: "ATS.settings.dockMargin.name",
    hint: "ATS.settings.dockMargin.hint",
    scope: "client", config: true, type: Number, default: 8,
    onChange: () => FloatingBar.layoutAll(),
  });

  // Mode table : duplique chaque barre en une copie pivotée à 180° au coin opposé, pour les
  // joueurs assis en face. Réglage MONDE, édité dans le panneau de masquage ; il ne s'applique
  // QU'À l'écran de table (joueur TV), cf. FloatingBar.tableMode.
  game.settings.register(MODULE_ID, "tableMode", {
    scope: "world", config: false, type: Boolean, default: false,
    onChange: () => FloatingBar.layoutAll(),
  });

  // ── Barre de gabarits (panneau TemplateBarConfig) ───────────────────────────
  registerDock("templateDock", "ATS.dock.name", "free",
    () => SpellTemplateBar.instance?.applyDock());
  registerOrientation("templateOrientation",
    () => SpellTemplateBar.instance?.applyDock());

  game.settings.register(MODULE_ID, "templateButtonSize", {
    name: "ATS.settings.templateButtonSize.name",
    hint: "ATS.settings.templateButtonSize.hint",
    scope: "client", config: false, type: Number, default: 40,
    onChange: () => SpellTemplateBar.instance?.applyButtonSize(),
  });

  // ── Suivi de combat (panneau CombatBarConfig) ───────────────────────────────
  const syncCombat = () => CombatOverlay.instance?.sync();
  const sizeCombat = () => CombatOverlay.instance?.applySizes();

  registerDock("combatDock", "ATS.dock.name", "free",
    () => CombatOverlay.instance?.applyDock());
  registerOrientation("combatOrientation",
    () => CombatOverlay.instance?.applyDock());

  game.settings.register(MODULE_ID, "combatCurrentInline", {
    name: "ATS.settings.combatCurrentInline.name",
    hint: "ATS.settings.combatCurrentInline.hint",
    scope: "client", config: false, type: Boolean, default: true,
    onChange: syncCombat,
  });

  game.settings.register(MODULE_ID, "showImages", {
    name: "ATS.settings.showImages.name",
    hint: "ATS.settings.showImages.hint",
    scope: "client", config: false, type: Boolean, default: true,
    onChange: syncCombat,
  });

  game.settings.register(MODULE_ID, "imageMode", {
    name: "ATS.settings.imageMode.name",
    hint: "ATS.settings.imageMode.hint",
    scope: "world", config: false, type: String,
    choices: IMAGE_CHOICES,
    default: "actor",
    onChange: syncCombat,
  });

  game.settings.register(MODULE_ID, "featuredImageMode", {
    name: "ATS.settings.featuredImageMode.name",
    hint: "ATS.settings.featuredImageMode.hint",
    scope: "world", config: false, type: String,
    choices: IMAGE_CHOICES,
    default: "actor",
    onChange: syncCombat,
  });

  game.settings.register(MODULE_ID, "hideInitInCombat", {
    name: "ATS.settings.hideInitInCombat.name",
    hint: "ATS.settings.hideInitInCombat.hint",
    scope: "world", config: false, type: Boolean, default: true,
    onChange: syncCombat,
  });

  game.settings.register(MODULE_ID, "showNextButton", {
    name: "ATS.settings.showNextButton.name",
    hint: "ATS.settings.showNextButton.hint",
    scope: "world", config: false, type: Boolean, default: false,
    onChange: syncCombat,
  });

  game.settings.register(MODULE_ID, "rowSize", {
    name: "ATS.settings.rowSize.name",
    hint: "ATS.settings.rowSize.hint",
    scope: "client", config: false, type: Number, default: 46,
    onChange: sizeCombat,
  });

  game.settings.register(MODULE_ID, "currentImageSize", {
    name: "ATS.settings.currentImageSize.name",
    hint: "ATS.settings.currentImageSize.hint",
    scope: "world", config: false, type: Number, default: 132,
    onChange: sizeCombat,
  });

  game.settings.register(MODULE_ID, "autoControlToken", {
    name: "ATS.settings.autoControlToken.name",
    hint: "ATS.settings.autoControlToken.hint",
    scope: "world", config: false, type: Boolean, default: true,
  });

  game.settings.register(MODULE_ID, "autoPanToken", {
    name: "ATS.settings.autoPanToken.name",
    hint: "ATS.settings.autoPanToken.hint",
    scope: "world", config: false, type: Boolean, default: true,
  });

  // ── Barre d'action du token (panneau TokenBarConfig) ────────────────────────
  const reRenderToken = () => TokenActionBar.instance?.render();

  registerDock("dockPosition", "ATS.dock.name", "bottom",
    () => TokenActionBar.instance?.applyDock());
  registerOrientation("tokenOrientation",
    () => TokenActionBar.instance?.applyDock());

  game.settings.register(MODULE_ID, "tokenButtonSize", {
    name: "ATS.settings.tokenButtonSize.name",
    hint: "ATS.settings.tokenButtonSize.hint",
    scope: "client", config: false, type: Number, default: 42,
    onChange: reRenderToken,
  });

  game.settings.register(MODULE_ID, "includeInventory", {
    name: "ATS.settings.includeInventory.name",
    hint: "ATS.settings.includeInventory.hint",
    scope: "client", config: false, type: Boolean, default: true,
    onChange: reRenderToken,
  });

  game.settings.register(MODULE_ID, "onlyEquippedWeapons", {
    name: "ATS.settings.onlyEquippedWeapons.name",
    hint: "ATS.settings.onlyEquippedWeapons.hint",
    scope: "client", config: false, type: Boolean, default: true,
    onChange: reRenderToken,
  });

  game.settings.register(MODULE_ID, "includeFeatures", {
    name: "ATS.settings.includeFeatures.name",
    hint: "ATS.settings.includeFeatures.hint",
    scope: "client", config: false, type: Boolean, default: true,
    onChange: reRenderToken,
  });

  game.settings.register(MODULE_ID, "includeSpells", {
    name: "ATS.settings.includeSpells.name",
    hint: "ATS.settings.includeSpells.hint",
    scope: "client", config: false, type: Boolean, default: true,
    onChange: reRenderToken,
  });

  game.settings.register(MODULE_ID, "showGroupLabels", {
    name: "ATS.settings.showGroupLabels.name",
    hint: "ATS.settings.showGroupLabels.hint",
    scope: "client", config: false, type: Boolean, default: true,
    onChange: reRenderToken,
  });

  game.settings.register(MODULE_ID, "dedupeByName", {
    name: "ATS.settings.dedupeByName.name",
    hint: "ATS.settings.dedupeByName.hint",
    scope: "client", config: false, type: Boolean, default: true,
    onChange: reRenderToken,
  });

  game.settings.register(MODULE_ID, "alwaysShowFeatureNames", {
    name: "ATS.settings.alwaysShowFeatureNames.name",
    hint: "ATS.settings.alwaysShowFeatureNames.hint",
    scope: "client", config: false, type: String, default: "Multiattack, Spellcasting",
    onChange: reRenderToken,
  });

  // ── Masquage de l'interface par AUDIENCE (matrice, scope monde) ─────────────
  // Le MJ configure ; chaque client résout son audience et applique sa colonne. La
  // matrice { gm, tv, others } et le joueur TV sont édités via le panneau dédié ;
  // les onChange (monde) ré-appliquent le masquage sur tous les clients connectés.
  game.settings.register(MODULE_ID, "hideMatrix", {
    scope: "world", config: false, type: Object,
    default: foundry.utils.deepClone(HIDE_DEFAULTS),
    onChange: () => HideHud.apply(),
  });

  game.settings.register(MODULE_ID, "tvUser", {
    scope: "world", config: false, type: String, default: "",
    onChange: () => HideHud.apply(),
  });

  game.settings.registerMenu(MODULE_ID, "hideMenu", {
    name: "ATS.menu.hide.name",
    label: "ATS.menu.hide.label",
    hint: "ATS.menu.hide.hint",
    icon: "fa-solid fa-eye-slash",
    type: HideConfig,
    restricted: true,
  });

  // Migration du masquage granulaire MJ hérité (ancien réglage client « gmHidden »,
  // stocké en localStorage) vers la colonne MJ de la nouvelle matrice, si celle-ci est
  // encore vierge. Best-effort, exécuté par le MJ uniquement (la matrice est de portée monde).
  Hooks.once("ready", () => {
    try {
      if (!game.user.isGM) return;
      const matrix = game.settings.get(MODULE_ID, "hideMatrix") ?? {};
      if (matrix.gm && Object.keys(matrix.gm).length) return; // colonne MJ déjà renseignée
      const legacy = JSON.parse(localStorage.getItem(`${MODULE_ID}.gmHidden`) || "null");
      if (!legacy || typeof legacy !== "object" || !Object.keys(legacy).length) return;
      const next = foundry.utils.deepClone(matrix);
      next.gm = legacy;
      game.settings.set(MODULE_ID, "hideMatrix", next);
    } catch (err) {
      console.warn("[Arthak's Table] migration du masquage MJ:", err);
    }
  });

  // Migration des valeurs d'ancrage héritées (« bottom-center », « left-center »… →
  // bord seul + orientation). Une passe par client, l'ancrage étant de portée client.
  Hooks.once("ready", () => {
    const migrate = (edgeKey, orientKey) => {
      const raw = game.settings.get(MODULE_ID, edgeKey);
      if (typeof raw !== "string" || !raw.includes("-")) return; // déjà au nouveau format
      const edge = raw.split("-")[0];
      const normalized = ["top", "bottom", "left", "right"].includes(edge) ? edge : "free";
      game.settings.set(MODULE_ID, edgeKey, normalized);
      if (orientKey) game.settings.set(MODULE_ID, orientKey, (edge === "left" || edge === "right") ? "v" : "h");
    };
    migrate("dockPosition", "tokenOrientation");
    migrate("templateDock", "templateOrientation");
    migrate("combatDock", "combatOrientation");

    // Migration de l'état d'ancrage localStorage : { pos (fraction), seq } → { align, order }.
    // L'ancre est dérivée de la fraction (tiers) ; l'ordre reprend le rang d'arrivée.
    const migrateDockState = (barKey) => {
      const lsKey = `${MODULE_ID}.${barKey}.dock.${game.user.id}`;
      let state;
      try { state = JSON.parse(localStorage.getItem(lsKey)); } catch { return; }
      if (!state || typeof state !== "object" || state.align !== undefined) return; // déjà migré/absent
      const pos = Number(state.pos);
      const align = !Number.isFinite(pos) ? "center" : pos < 1 / 3 ? "start" : pos < 2 / 3 ? "center" : "end";
      const order = Number.isFinite(Number(state.seq)) ? Number(state.seq) : Date.now();
      localStorage.setItem(lsKey, JSON.stringify({ align, order }));
    };
    ["template", "combat", "token"].forEach(migrateDockState);
  });
}

/** Enregistre les raccourcis clavier de combat (appelé au hook « init »). */
export function registerKeybindings() {
  // « . » : tour suivant (le MJ pilote le combat → raccourci réservé au MJ).
  game.keybindings.register(MODULE_ID, "nextTurn", {
    name: "ATS.keybind.nextTurn.name",
    hint: "ATS.keybind.nextTurn.hint",
    editable: [{ key: "Period" }],
    restricted: true,
    onDown: () => CombatOverlay.advanceTurn(+1),
  });

  // « , » : tour précédent.
  game.keybindings.register(MODULE_ID, "prevTurn", {
    name: "ATS.keybind.prevTurn.name",
    hint: "ATS.keybind.prevTurn.hint",
    editable: [{ key: "Comma" }],
    restricted: true,
    onDown: () => CombatOverlay.advanceTurn(-1),
  });

  // « / » : place le curseur dans le champ PV du panneau cible (saisie clavier
  // rapide à la table). Cible : les tokens ciblés (T), sinon le token sélectionné.
  game.keybindings.register(MODULE_ID, "focusHp", {
    name: "ATS.keybind.focusHp.name",
    hint: "ATS.keybind.focusHp.hint",
    editable: [{ key: "Slash" }],
    restricted: true,
    onDown: () => CombatOverlay.focusHp(),
  });
}
