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
 * masquage de l'interface est piloté par son propre réglage « hidePlayerHud ».
 */
import { MODULE_ID } from "./const.js";
import { registerSettings, registerKeybindings } from "./settings.js";
import { SpellTemplateBar } from "./features/template-bar.js";
import { CombatOverlay } from "./features/combat-bar.js";
import { TokenActionBar } from "./features/token-bar.js";
import { HideHud } from "./features/hide-hud.js";

Hooks.once("init", () => {
  registerSettings();
  registerKeybindings();
});

Hooks.once("ready", () => {
  if (game.settings.get(MODULE_ID, "enableTemplateBar")) SpellTemplateBar.start();
  if (game.settings.get(MODULE_ID, "enableCombatBar"))   CombatOverlay.start();
  if (game.settings.get(MODULE_ID, "enableTokenBar"))    TokenActionBar.start();
  HideHud.apply();
});
