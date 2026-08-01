/**
 * Enregistrement centralisé des réglages et raccourcis de la suite.
 *
 * Il n'y a PAS de réglage « Activer » par barre : une barre tourne sur un client dès que
 * l'audience de ce client ne la masque pas (matrice de masquage, cf. hide-hud.js). Les
 * réglages PROPRES à chaque barre sont enregistrés en `config: false` et présentés dans un
 * panneau dédié (bouton « Configurer… » via registerMenu), pour garder la page de
 * configuration native courte et lisible.
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
 * glisser. Voir FloatingBar.applyDock.
 */
const EDGE_CHOICES = {
  free: "Libre (glisser-déposer)",
  top: "Bord haut",
  bottom: "Bord bas",
  left: "Bord gauche",
  right: "Bord droit",
};

/** Orientation de la barre, indépendante du bord (bascule aussi via le bouton ↻). */
const ORIENT_CHOICES = { h: "Horizontale", v: "Verticale" };

// ── Panneaux de configuration par barre (bouton « Configurer… ») ──────────────
// Chaque panneau présente les clés listées, dans cet ordre. Les réglages restent
// enregistrés plus bas (avec name/hint/onChange) mais en `config: false`.
// Chaque panneau présente aussi « dockMargin » (réglage GLOBAL commun aux barres) :
// c'est le seul accès à ce réglage quand le HUD joueur est masqué (les panneaux par
// barre s'ouvrent alors par clic droit sur la poignée, hors page de config native).
const TemplateBarConfig = makeSettingsPanel(
  "ats-template-config", "Barre de gabarits · Réglages", "fa-solid fa-ruler-combined",
  ["templateDock", "templateOrientation", "dockMargin", "templateButtonSize"],
);

const CombatBarConfig = makeSettingsPanel(
  "ats-combat-config", "Suivi de combat · Réglages", "fa-solid fa-swords",
  [
    "combatDock", "combatOrientation", "dockMargin", "combatCurrentInline", "showImages", "imageMode", "featuredImageMode",
    "hideInitInCombat", "showNextButton", "rowSize", "currentImageSize",
    "autoControlToken", "autoPanToken",
  ],
);

const TokenBarConfig = makeSettingsPanel(
  "ats-token-config", "Barre d'action du token · Réglages", "fa-solid fa-hand-fist",
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
    label: "Barre de gabarits", hint: "Ancrage et taille des boutons de la barre de gabarits.",
  }],
  [CombatOverlay, {
    menuKey: "combatBarMenu", panel: CombatBarConfig, icon: "fa-solid fa-swords",
    label: "Suivi de combat", hint: "Ancrage, images, tailles et automatisations de l'overlay de combat.",
  }],
  [TokenActionBar, {
    menuKey: "tokenBarMenu", panel: TokenBarConfig, icon: "fa-solid fa-hand-fist",
    label: "Barre d'action du token", hint: "Ancrage, contenu (armes, features, sorts) et affichage de la barre.",
  }],
]);

/**
 * Enregistre le réglage de BORD d'ancrage d'une barre (présenté dans son panneau).
 * @param {string} key      Clé du réglage (déclarée par la barre via `dockSettingKey`).
 * @param {string} name     Libellé affiché.
 * @param {string} def      Bord par défaut (« free » | top | bottom | left | right).
 * @param {() => void} onChange Rappel appliquant l'ancrage sur l'instance vivante.
 */
function registerDock(key, name, def, onChange) {
  game.settings.register(MODULE_ID, key, {
    name,
    hint: "Colle la barre sur un bord de l'écran ; le long du bord elle s'ancre à un repère " +
          "(début / centre / fin), posé au glisser. « Libre » = glisser-déposer libre. " +
          "L'orientation est indépendante (réglage ci-dessous + bouton ↻). Astuce : plusieurs " +
          "barres sur un même bord se rangent côte à côte, jamais l'une sur l'autre.",
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
    name: "Orientation de la barre",
    hint: "Horizontale ou verticale, indépendamment du bord d'ancrage. Aussi accessible par le bouton ↻ de la barre.",
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
    name: "Barres · Marge d'ancrage à l'écran (px)",
    hint: "Écart entre une barre ancrée et le bord de l'écran. 0 = collée au bord.",
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
  registerDock("templateDock", "Ancrage de la barre", "free",
    () => SpellTemplateBar.instance?.applyDock());
  registerOrientation("templateOrientation",
    () => SpellTemplateBar.instance?.applyDock());

  game.settings.register(MODULE_ID, "templateButtonSize", {
    name: "Taille des boutons (px)",
    hint: "Taille des boutons de la barre de gabarits.",
    scope: "client", config: false, type: Number, default: 40,
    onChange: () => SpellTemplateBar.instance?.applyButtonSize(),
  });

  // ── Suivi de combat (panneau CombatBarConfig) ───────────────────────────────
  const syncCombat = () => CombatOverlay.instance?.sync();
  const sizeCombat = () => CombatOverlay.instance?.applySizes();

  registerDock("combatDock", "Ancrage de la barre", "free",
    () => CombatOverlay.instance?.applyDock());
  registerOrientation("combatOrientation",
    () => CombatOverlay.instance?.applyDock());

  game.settings.register(MODULE_ID, "combatCurrentInline", {
    name: "Courant affiché dans la liste",
    hint: "Le combattant à son tour s'agrandit EN PLACE dans la liste, avec les cibles flottantes à sa droite. Désactivé : ancien affichage — portrait du courant et cibles regroupés dans une colonne à droite.",
    scope: "client", config: false, type: Boolean, default: true,
    onChange: syncCombat,
  });

  game.settings.register(MODULE_ID, "showImages", {
    name: "Afficher les portraits",
    hint: "Rail avec les images des combattants (créature / personnage). Désactivé : pastilles compactes avec initiales.",
    scope: "client", config: false, type: Boolean, default: true,
    onChange: syncCombat,
  });

  game.settings.register(MODULE_ID, "imageMode", {
    name: "Image des combattants (liste)",
    hint: "Vignettes de la liste / du rail : portrait de la fiche d'acteur ou image du token placé sur la scène.",
    scope: "world", config: false, type: String,
    choices: { actor: "Portrait de l'acteur", token: "Image du token" },
    default: "actor",
    onChange: syncCombat,
  });

  game.settings.register(MODULE_ID, "featuredImageMode", {
    name: "Image du courant et des cibles",
    hint: "Grand portrait du combattant courant et des cibles : portrait de la fiche d'acteur ou image du token. Indépendant du réglage des vignettes de la liste.",
    scope: "world", config: false, type: String,
    choices: { actor: "Portrait de l'acteur", token: "Image du token" },
    default: "actor",
    onChange: syncCombat,
  });

  game.settings.register(MODULE_ID, "hideInitInCombat", {
    name: "Masquer l'initiative en combat",
    hint: "L'initiative n'est utile qu'au réglage : on la masque une fois le combat lancé (rééditable via le bouton d'options ⋮). Désactivé : petit chiffre dans le coin de la vignette. Réglage commun à la table (MJ).",
    scope: "world", config: false, type: Boolean, default: true,
    onChange: syncCombat,
  });

  game.settings.register(MODULE_ID, "showNextButton", {
    name: "Afficher les boutons de tour",
    hint: "Ajoute une ligne de boutons « tour précédent / suivant » sous l'en-tête (MJ). Désactivé par défaut : les raccourcis « . » et « , » suffisent. Réglage réservé au MJ.",
    scope: "world", config: false, type: Boolean, default: false,
    onChange: syncCombat,
  });

  game.settings.register(MODULE_ID, "rowSize", {
    name: "Taille des vignettes du rail (px)",
    hint: "Diamètre des vignettes de combattants dans le rail.",
    scope: "client", config: false, type: Number, default: 46,
    onChange: sizeCombat,
  });

  game.settings.register(MODULE_ID, "currentImageSize", {
    name: "Taille du portrait du combattant courant (px)",
    hint: "Grand portrait du combattant courant (et des cibles). Réglage commun à la table (affecte aussi la vue des joueurs).",
    scope: "world", config: false, type: Number, default: 132,
    onChange: sizeCombat,
  });

  game.settings.register(MODULE_ID, "autoControlToken", {
    name: "Sélectionner le token du combattant courant",
    hint: "À chaque changement de tour, sélectionne sur la scène le token du combattant courant (pour l'utilisateur qui le possède).",
    scope: "world", config: false, type: Boolean, default: true,
  });

  game.settings.register(MODULE_ID, "autoPanToken", {
    name: "Centrer la caméra sur le combattant courant (MJ)",
    hint: "À chaque changement de tour, centre la vue du MJ sur le token courant. N'affecte pas la caméra des joueurs.",
    scope: "world", config: false, type: Boolean, default: true,
  });

  // ── Barre d'action du token (panneau TokenBarConfig) ────────────────────────
  const reRenderToken = () => TokenActionBar.instance?.render();

  registerDock("dockPosition", "Ancrage de la barre", "bottom",
    () => TokenActionBar.instance?.applyDock());
  registerOrientation("tokenOrientation",
    () => TokenActionBar.instance?.applyDock());

  game.settings.register(MODULE_ID, "tokenButtonSize", {
    name: "Taille des boutons (px)",
    hint: "Taille des icônes d'objet de la barre.",
    scope: "client", config: false, type: Number, default: 42,
    onChange: reRenderToken,
  });

  game.settings.register(MODULE_ID, "includeInventory", {
    name: "Afficher les armes",
    hint: "Armes (équipées par défaut).",
    scope: "client", config: false, type: Boolean, default: true,
    onChange: reRenderToken,
  });

  game.settings.register(MODULE_ID, "onlyEquippedWeapons", {
    name: "Armes équipées uniquement",
    hint: "N'afficher que les armes actuellement équipées.",
    scope: "client", config: false, type: Boolean, default: true,
    onChange: reRenderToken,
  });

  game.settings.register(MODULE_ID, "includeFeatures", {
    name: "Afficher les features",
    hint: "Dons réellement actionnables (effet réel, consommation de ressource ou charges), avec compteur de charges.",
    scope: "client", config: false, type: Boolean, default: true,
    onChange: reRenderToken,
  });

  game.settings.register(MODULE_ID, "includeSpells", {
    name: "Afficher les sorts",
    hint: "Cantrips (niveau 0) puis sorts groupés par niveau, avec les emplacements restants / total.",
    scope: "client", config: false, type: Boolean, default: true,
    onChange: reRenderToken,
  });

  game.settings.register(MODULE_ID, "showGroupLabels", {
    name: "Afficher les en-têtes de groupe",
    hint: "Mince ligne de libellés de section (Armes, Features, Cantrips, N1…) et compteurs d'emplacements, au-dessus des icônes.",
    scope: "client", config: false, type: Boolean, default: true,
    onChange: reRenderToken,
  });

  game.settings.register(MODULE_ID, "dedupeByName", {
    name: "Masquer les doublons",
    hint: "Masque les objets de même nom (garde le premier).",
    scope: "client", config: false, type: Boolean, default: true,
    onChange: reRenderToken,
  });

  game.settings.register(MODULE_ID, "alwaysShowFeatureNames", {
    name: "Features « rappel » toujours affichées",
    hint: "Noms de features toujours affichées même sans effet mécanique (séparés par des virgules). Correspondance par sous-chaîne, casse ignorée.",
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
    name: "Masquage · Interface, onglets et barres",
    label: "Configurer le masquage",
    hint: "Choisir, par audience (MJ, écran de table « TV », autres joueurs), les éléments à masquer : " +
          "éléments du HUD, onglets de la sidebar et barres de la suite. Le MJ pilote tous les écrans.",
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
}
