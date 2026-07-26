/**
 * Enregistrement centralisé des réglages et raccourcis de la suite.
 *
 * Un réglage d'activation par barre (« enableXxx », scope monde) permet au MJ de
 * choisir ce qui tourne sur l'écran de table ; son onChange démarre/arrête la barre
 * à chaud, sans rechargement. Les réglages propres à chaque fonctionnalité suivent,
 * préfixés par leur zone pour rester lisibles dans la longue liste de configuration.
 */
import { MODULE_ID } from "./const.js";
import { BARS } from "./features/registry.js";
import { SpellTemplateBar } from "./features/template-bar.js";
import { CombatOverlay } from "./features/combat-bar.js";
import { TokenActionBar } from "./features/token-bar.js";
import { HideHud, GmHideConfig } from "./features/hide-hud.js";

/** Démarre ou détruit une barre selon l'état de son réglage d'activation. */
function toggleFeature(cls, on) {
  if (on) cls.start();
  else cls.instance?.destroy();
}

/**
 * Choix d'ancrage communs aux barres flottantes : « Libre » (glisser-déposer) ou
 * un bord de l'écran × un alignement. Gauche/droite ancrent en vertical, haut/bas
 * en horizontal (voir FloatingBar.applyDock).
 */
const DOCK_CHOICES = {
  free: "Libre (glisser-déposer)",
  "bottom-left": "Bas · gauche",
  "bottom-center": "Bas · centre",
  "bottom-right": "Bas · droite",
  "top-left": "Haut · gauche",
  "top-center": "Haut · centre",
  "top-right": "Haut · droite",
  "left-top": "Gauche · haut",
  "left-center": "Gauche · centre",
  "left-bottom": "Gauche · bas",
  "right-top": "Droite · haut",
  "right-center": "Droite · centre",
  "right-bottom": "Droite · bas",
};

/**
 * Enregistre un réglage d'ancrage pour une barre.
 * @param {string} key      Clé du réglage (déclarée par la barre via `dockSettingKey`).
 * @param {string} name     Libellé affiché.
 * @param {string} def      Ancrage par défaut.
 * @param {() => void} onChange Rappel appliquant l'ancrage sur l'instance vivante.
 */
function registerDock(key, name, def, onChange) {
  game.settings.register(MODULE_ID, key, {
    name,
    hint: "Ancre la barre sur un bord de l'écran (gauche/droite = vertical, haut/bas = horizontal). " +
          "« Libre » = glisser-déposer, position mémorisée. Astuce : glisser la barre près d'un bord l'y ancre aussi.",
    scope: "client", config: true, type: String,
    choices: DOCK_CHOICES,
    default: def,
    onChange,
  });
}

/** Enregistre tous les réglages de la suite (appelé au hook « init »). */
export function registerSettings() {
  // ── Activation des fonctionnalités (une entrée par barre du registre) ───────
  for (const { cls, enable, name, hint } of BARS) {
    game.settings.register(MODULE_ID, enable, {
      name, hint,
      scope: "world", config: true, type: Boolean, default: true,
      onChange: (v) => toggleFeature(cls, v),
    });
  }

  // ── Barre de gabarits ──────────────────────────────────────────────────────
  game.settings.register(MODULE_ID, "templateButtonSize", {
    name: "Gabarits · Taille des boutons (px)",
    hint: "Taille des boutons de la barre de gabarits.",
    scope: "client", config: true, type: Number, default: 40,
    onChange: () => SpellTemplateBar.instance?.applyButtonSize(),
  });

  registerDock("templateDock", "Gabarits · Ancrage de la barre", "free",
    () => SpellTemplateBar.instance?.applyDock());

  // ── Suivi de combat ────────────────────────────────────────────────────────
  const syncCombat = () => CombatOverlay.instance?.sync();
  const sizeCombat = () => CombatOverlay.instance?.applySizes();

  registerDock("combatDock", "Combat · Ancrage de la barre", "free",
    () => CombatOverlay.instance?.applyDock());

  game.settings.register(MODULE_ID, "imageMode", {
    name: "Combat · Image des combattants",
    hint: "Portrait de la fiche d'acteur ou image du token placé sur la scène.",
    scope: "world", config: true, type: String,
    choices: { actor: "Portrait de l'acteur", token: "Image du token" },
    default: "actor",
    onChange: syncCombat,
  });

  game.settings.register(MODULE_ID, "showImages", {
    name: "Combat · Afficher les portraits",
    hint: "Rail avec les images des combattants (créature / personnage). Désactivé : pastilles compactes avec initiales.",
    scope: "client", config: true, type: Boolean, default: true,
    onChange: syncCombat,
  });

  game.settings.register(MODULE_ID, "hideInitInCombat", {
    name: "Combat · Masquer l'initiative en combat",
    hint: "L'initiative n'est utile qu'au réglage : on la masque une fois le combat lancé (rééditable via le bouton d'options ⋮). Désactivé : petit chiffre dans le coin de la vignette.",
    scope: "client", config: true, type: Boolean, default: true,
    onChange: syncCombat,
  });

  game.settings.register(MODULE_ID, "showNextButton", {
    name: "Combat · Afficher le bouton « Tour suivant »",
    hint: "Ajoute un bouton de passage au tour suivant dans l'en-tête. Désactivé par défaut : le raccourci « . » suffit.",
    scope: "client", config: true, type: Boolean, default: false,
    onChange: syncCombat,
  });

  game.settings.register(MODULE_ID, "rowSize", {
    name: "Combat · Taille des vignettes du rail (px)",
    hint: "Diamètre des vignettes de combattants dans le rail.",
    scope: "client", config: true, type: Number, default: 46,
    onChange: sizeCombat,
  });

  game.settings.register(MODULE_ID, "currentImageSize", {
    name: "Combat · Taille du portrait du combattant courant (px)",
    hint: "Grand portrait du combattant courant (et des cibles), affiché à côté du rail.",
    scope: "client", config: true, type: Number, default: 132,
    onChange: sizeCombat,
  });

  game.settings.register(MODULE_ID, "autoControlToken", {
    name: "Combat · Sélectionner le token du combattant courant",
    hint: "À chaque changement de tour, sélectionne sur la scène le token du combattant courant (pour l'utilisateur qui le possède).",
    scope: "world", config: true, type: Boolean, default: true,
  });

  game.settings.register(MODULE_ID, "autoPanToken", {
    name: "Combat · Centrer la caméra sur le combattant courant (MJ)",
    hint: "À chaque changement de tour, centre la vue du MJ sur le token courant. N'affecte pas la caméra des joueurs.",
    scope: "world", config: true, type: Boolean, default: true,
  });

  // ── Barre d'action du token ────────────────────────────────────────────────
  const reRenderToken = () => TokenActionBar.instance?.render();

  game.settings.register(MODULE_ID, "tokenButtonSize", {
    name: "Token · Taille des boutons (px)",
    hint: "Taille des icônes d'objet de la barre.",
    scope: "client", config: true, type: Number, default: 42,
    onChange: reRenderToken,
  });

  game.settings.register(MODULE_ID, "includeInventory", {
    name: "Token · Afficher les armes",
    hint: "Armes (équipées par défaut).",
    scope: "client", config: true, type: Boolean, default: true,
    onChange: reRenderToken,
  });

  game.settings.register(MODULE_ID, "onlyEquippedWeapons", {
    name: "Token · Armes équipées uniquement",
    hint: "N'afficher que les armes actuellement équipées.",
    scope: "client", config: true, type: Boolean, default: true,
    onChange: reRenderToken,
  });

  game.settings.register(MODULE_ID, "includeFeatures", {
    name: "Token · Afficher les features",
    hint: "Dons réellement actionnables (effet réel, consommation de ressource ou charges), avec compteur de charges.",
    scope: "client", config: true, type: Boolean, default: true,
    onChange: reRenderToken,
  });

  game.settings.register(MODULE_ID, "includeSpells", {
    name: "Token · Afficher les sorts",
    hint: "Cantrips (niveau 0) puis sorts groupés par niveau, avec les emplacements restants / total.",
    scope: "client", config: true, type: Boolean, default: true,
    onChange: reRenderToken,
  });

  game.settings.register(MODULE_ID, "showGroupLabels", {
    name: "Token · Afficher les en-têtes de groupe",
    hint: "Mince ligne de libellés de section (Armes, Features, Cantrips, N1…) et compteurs d'emplacements, au-dessus des icônes.",
    scope: "client", config: true, type: Boolean, default: true,
    onChange: reRenderToken,
  });

  registerDock("dockPosition", "Token · Ancrage de la barre", "bottom-center",
    () => TokenActionBar.instance?.applyDock());

  game.settings.register(MODULE_ID, "dedupeByName", {
    name: "Token · Masquer les doublons",
    hint: "Masque les objets de même nom (garde le premier).",
    scope: "client", config: true, type: Boolean, default: true,
    onChange: reRenderToken,
  });

  game.settings.register(MODULE_ID, "alwaysShowFeatureNames", {
    name: "Token · Features « rappel » toujours affichées",
    hint: "Noms de features toujours affichées même sans effet mécanique (séparés par des virgules). Correspondance par sous-chaîne, casse ignorée.",
    scope: "client", config: true, type: String, default: "Multiattack, Spellcasting",
    onChange: reRenderToken,
  });

  // ── Masquage de l'interface joueur ─────────────────────────────────────────
  // Pas de toggle « enable » dédié : « hidePlayerHud » EST son interrupteur.
  game.settings.register(MODULE_ID, "hidePlayerHud", {
    name: "Masquage · Masquer l'interface des joueurs",
    hint: "Réservé au MJ. Pour les JOUEURS uniquement : ne conserve que le canvas et les barres de la table. Le MJ garde son interface complète.",
    scope: "world", config: true, type: Boolean, default: false,
    onChange: () => HideHud.apply(),
  });

  game.settings.register(MODULE_ID, "showChat", {
    name: "Masquage · Conserver le chat",
    hint: "Conserver le journal de chat (chat-scroll) visible pour les joueurs quand l'interface est masquée. Le champ de saisie (chat-form) reste masqué.",
    scope: "world", config: true, type: Boolean, default: true,
    onChange: () => HideHud.apply(),
  });

  // ── Masquage granulaire de la vue MJ (scope client, par écran) ──────────────
  // État { [key]: true } des éléments masqués. Non affiché dans la liste : édité
  // via le panneau dédié ci-dessous ; l'onChange ré-applique la feuille de style.
  game.settings.register(MODULE_ID, "gmHidden", {
    scope: "client", config: false, type: Object, default: {},
    onChange: () => HideHud.applyGmHide(),
  });

  game.settings.registerMenu(MODULE_ID, "gmHideMenu", {
    name: "Masquage MJ · Éléments masqués",
    label: "Configurer le masquage (MJ)",
    hint: "Choisir individuellement les éléments à retirer de VOTRE écran de MJ (barre de macros, panneau joueurs, saisie du chat, onglets de la sidebar…). N'affecte que votre client.",
    icon: "fa-solid fa-eye-slash",
    type: GmHideConfig,
    restricted: true,
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
