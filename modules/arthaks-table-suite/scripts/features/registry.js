/**
 * Registre déclaratif des barres flottantes de la suite.
 *
 * Chaque entrée associe une classe (interface commune : `static start()` idempotent,
 * `static instance`, `destroy()`) à son identifiant court `barKey` et son libellé.
 * `main.js` et `settings.js` itèrent ce registre au lieu de câbler chaque barre à la main.
 *
 * Il n'y a PLUS de réglage « Activer » par barre : une barre tourne sur un client dès lors
 * que l'audience de ce client ne la masque pas (matrice de masquage, cf. hide-hud.js). Le
 * masquage lui-même n'a pas d'interrupteur : il s'applique en continu selon la matrice.
 *
 * `barKey` (celui passé à FloatingBar, servant de namespace localStorage) est aussi la clé
 * stable dans la matrice de masquage (`bar-<barKey>`). `label` est le libellé court réutilisé
 * par la section « Barres du module » du panneau de masquage.
 */
import { SpellTemplateBar } from "./template-bar.js";
import { CombatOverlay } from "./combat-bar.js";
import { TokenActionBar } from "./token-bar.js";

// `label` est une clé i18n (localisée au point d'affichage, cf. hide-hud.js).
export const BARS = [
  { cls: SpellTemplateBar, barKey: "template", label: "ATS.menu.template.label" },
  { cls: CombatOverlay,    barKey: "combat",   label: "ATS.menu.combat.label" },
  { cls: TokenActionBar,   barKey: "token",    label: "ATS.menu.token.label" },
];
