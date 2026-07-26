/**
 * Registre déclaratif des barres flottantes activables.
 *
 * Chaque entrée décrit le réglage d'activation (scope monde) et la classe associée
 * (interface commune : `static start()` idempotent, `static instance`, `destroy()`).
 * `main.js` et `settings.js` itèrent ce registre au lieu de câbler chaque barre à la
 * main. Hide HUD n'y figure PAS : son interrupteur est le réglage « hidePlayerHud ».
 */
import { SpellTemplateBar } from "./template-bar.js";
import { CombatOverlay } from "./combat-bar.js";
import { TokenActionBar } from "./token-bar.js";

export const BARS = [
  {
    cls: SpellTemplateBar,
    enable: "enableTemplateBar",
    name: "Activer · Barre de gabarits",
    hint: "Barre flottante de gabarits de sort (mode gabarit Regions de dnd5e).",
  },
  {
    cls: CombatOverlay,
    enable: "enableCombatBar",
    name: "Activer · Suivi de combat",
    hint: "Overlay de suivi de combat compact superposé à la scène.",
  },
  {
    cls: TokenActionBar,
    enable: "enableTokenBar",
    name: "Activer · Barre d'action du token",
    hint: "Barre d'actions (armes, features, sorts) du token sélectionné.",
  },
];
