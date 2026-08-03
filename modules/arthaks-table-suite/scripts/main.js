/**
 * Arthak's Table — point d'entrée de la suite.
 *
 * Suite de fonctionnalités pour jouer EN PRÉSENTIEL autour d'une vraie table avec un
 * écran partagé : les joueurs lancent leurs vrais dés, Foundry sert d'écran de jeu.
 *  - Barre de gabarits de sort (mode gabarit Regions de dnd5e) ;
 *  - Suivi de combat compact superposé à la scène ;
 *  - Barre d'action du token sélectionné ;
 *  - Masquage de l'interface des joueurs (écran de table épuré).
 *
 * Chaque barre est activable indépendamment via ses réglages (scope monde) ; le
 * masquage de l'interface est piloté par une matrice par audience (MJ / écran de
 * table « TV » / autres joueurs), cf. HideHud.
 */
import { registerSettings, registerKeybindings } from "./settings.js";
import { HideHud } from "./features/hide-hud.js";
import { RollsBar } from "./features/rolls-bar.js";
import { TokenTeleport } from "./features/teleport.js";

Hooks.once("init", () => {
  registerSettings();
  registerKeybindings();
});

Hooks.once("ready", () => {
  // Court-circuit de la fenêtre de configuration de jet dnd5e (fast-forward), indépendant de
  // l'affichage de la barre des jets, donc enregistré ici plutôt que dans son cycle de vie.
  RollsBar.installRollShortcuts();
  // Téléport des tokens (MJ) : branche l'écoute des clics du plateau, indépendante de
  // l'affichage des barres — d'où l'installation ici plutôt que dans une barre.
  TokenTeleport.install();
  // Plus de réglage « Activer » : HideHud.apply() démarre les barres que l'audience de ce
  // client affiche (et masque le reste de l'interface selon la matrice).
  HideHud.apply();
});
