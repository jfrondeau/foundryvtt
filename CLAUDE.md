# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Contexte du projet

`arthaks-table-suite` (« Arthak's Table ») est un module **Foundry VTT v14** (compat. min. v13) pour le système **dnd5e 5.x**. Il vise le jeu **en présentiel** autour d'une vraie table avec un écran partagé : les joueurs lancent leurs vrais dés, Foundry sert d'écran de jeu commun. Le module doit **aider le MJ sans lui ajouter de travail** — pilotage au clavier (pas de souris), gestion des PV minimale en combat, actions des monstres à portée de main.

Communiquer en **français**. Les commentaires (doc JSDoc en tête de chaque fichier/méthode) sont en français ; les identifiants (classes, méthodes, variables) sont en anglais.

## Commandes

- **Déployer** : `pwsh ./deploy.ps1` (tous les modules) ou `pwsh ./deploy.ps1 arthaks-table-suite` (un seul). Cible **LOCALE par défaut** — l'install Foundry de cette machine, `%LOCALAPPDATA%\FoundryVTT\Data\modules`. Ajouter **`-Remote`** pour viser le serveur réseau (robocopy en miroir vers `\\192.168.68.59\foundryuserdata\Data\modules`). Puis **F5 dans Foundry** pour recharger.
- **Pas de build, pas de lint, pas de tests** : ES modules purs chargés directement par Foundry. Aucune étape de compilation.
- **Foundry n'est pas lançable depuis cet environnement.** On ne peut pas vérifier l'UI en direct ici. Ne pas enchaîner de refontes non testées : instrumenter avec des logs (`makeNotify`), avancer par petits pas, ou valider en simulation. Voir la note mémoire « Vérifier l'UI, pas itérer à l'aveugle ».

## Architecture

Un **seul module** regroupe quatre fonctionnalités indépendantes, toutes sous le même `MODULE_ID = "arthaks-table-suite"` (`scripts/const.js`) — réglages, keybindings et flags partagent ce namespace unique. Point d'entrée : `scripts/main.js` (hooks `init` → `registerSettings`/`registerKeybindings` ; `ready` → `HideHud.apply()`).

### Les trois barres flottantes

`scripts/features/{template-bar,combat-bar,token-bar}.js` — chacune étend `FloatingBar` (`scripts/lib/floating-bar.js`) et suit une **interface commune** : `static instance`, `static start()` idempotent, `destroy()`. Le registre déclaratif `scripts/features/registry.js` (`BARS`) associe chaque classe à un `barKey` court (`template`/`combat`/`token`) et un `label` ; `main.js`, `settings.js` et `hide-hud.js` itèrent ce registre plutôt que de câbler chaque barre.

- **`SpellTemplateBar`** — dessine des gabarits de sort via le **« template mode » du contrôle Regions de dnd5e** (⚠️ pas de `MeasuredTemplate` : chaque gabarit est une `Region` nommée « Cercle [Nom] »… et marquée du flag `flags.<MODULE_ID>.owner`).
- **`CombatOverlay`** — suivi de combat compact superposé à la scène ; vues Setup / Combat ; raccourcis MJ « . » (tour suivant), « , » (précédent), « / » (focus champ PV de la cible).
- **`TokenActionBar`** — barre d'actions du token sélectionné (armes / features / sorts), remplie dynamiquement. Portage du macro `macro/ActionBar.js`.

`FloatingBar` factorise tout le comportement partagé : position/minimisation persistées **par utilisateur en localStorage**, glisser-déposer, et surtout l'**ancrage (docking)**. Règle unique du docking : une barre colle à un **bord** (`top`/`bottom`/`left`/`right`) puis coule **le long** de ce bord selon une **ancre discrète** `start`/`center`/`end` + un rang d'arrivée `order` — les barres d'un même (bord, ancre) se rangent bout à bout, **jamais superposées**. L'orientation (h/v) est **indépendante** du bord (bouton ↻). La disposition est une **passe globale** `FloatingBar.layoutAll()` (toute barre qui bouge la relance). Le **mode table** (`tableMode`, écran TV uniquement) duplique chaque barre en copie miroir 180° au coin opposé, pour les joueurs assis en face.

### Masquage de l'interface (HideHud)

`scripts/features/hide-hud.js` — **matrice de masquage par audience** (réglage `hideMatrix`, **scope monde**). Le MJ configure ce qui est masqué pour trois audiences : `gm` (son écran), `tv` (l'écran de table partagé — un joueur désigné par le réglage `tvUser`), `others` (les autres joueurs). Chaque client résout **son** audience (`currentAudienceKey()`) et applique la colonne correspondante. Trois sections masquables (registre `HIDEABLE`) : **Interface** (HUD, via feuille de style injectée `#ahh-audience-hide`), **Onglets** de la sidebar (même mécanisme CSS), **Barres** de la suite (bascule `display:none` + relayout). Il n'y a **plus de réglage « Activer » par barre** : une barre tourne sur un client dès que sa colonne d'audience ne la masque pas (`reconcileBars`).

⚠️ Foundry v14 : `chat-scroll` / `chat-form` sont des **classes**, pas des id.

### Réglages

`scripts/settings.js` centralise tout l'enregistrement. Les réglages propres à chaque barre sont enregistrés en **`config: false`** et présentés dans un **panneau dédié** (`scripts/lib/settings-panel.js`, `makeSettingsPanel` → `ApplicationV2` en DOM brut, sans Handlebars) ouvert par un bouton « Configurer… » (`registerMenu`). Ce même panneau est aussi accessible par **clic droit sur la poignée** d'une barre (`FloatingBar.openSettings`) — seul accès aux réglages quand le HUD joueur est masqué. `settings.js` contient aussi des **migrations** best-effort au hook `ready` (ancien masquage MJ localStorage → matrice ; anciens ancrages « bottom-center » → bord + orientation).

Portées : `dockMargin`, tailles et contenus de barre sont **client** ; `hideMatrix`, `tvUser`, `tableMode` et les réglages « communs à la table » (images, init, tailles partagées) sont **monde** (écrits par le MJ, appliqués en direct via `onChange`).

### Internationalisation (i18n)

Le module est **bilingue anglais / français** via le système i18n natif de Foundry — **sans** Handlebars (le rendu DOM brut est conservé). Fichiers de langue : `lang/en.json`, `lang/fr.json`, déclarés dans `module.json` (`"languages"`). Toutes les chaînes visibles sont des **clés** sous le namespace **`ATS.`** (`ATS.settings.<clé>.name`/`.hint`, `ATS.menu.*`, `ATS.keybind.*`, `ATS.choices.*`, `ATS.panel.*.title`, `ATS.dock.*`, `ATS.orient.*`).

Deux mécanismes de résolution, à ne pas confondre :
- **Localisation automatique par Foundry** — les `name`/`hint`/`label` d'un `game.settings.register`, d'un `registerMenu`, d'un keybinding, ainsi que `window.title` d'un `ApplicationV2` : Foundry résout la clé tout seul. On met la clé, rien de plus.
- **Localisation manuelle** — tout texte construit en DOM brut (labels de `HIDEABLE`/`AUDIENCES`, tooltips de `floating-bar.js`, boutons de `HideConfig`, messages `notify.*`) : appeler `t(clé)` / `t(clé, data)` (helper de `scripts/lib/common.js`, enveloppe `game.i18n.localize`/`format`). ⚠️ Le panneau générique `settings-panel.js` **court-circuite** la localisation auto de Foundry (il lit `cfg.name`/`cfg.hint`/`choices` et les affiche directement) : il doit donc localiser lui-même via `game.i18n.localize` — d'où les appels au rendu.

Règle : **aucune chaîne visible en dur** dans le code. Ajouter une clé aux **deux** fichiers de langue. Exceptions légitimes : valeurs de données non traduisibles (ex. le défaut `"Multiattack, Spellcasting"` de `alwaysShowFeatureNames`, qui matche des noms de features dnd5e), et `title`/`description` du manifeste `module.json` (non localisables par ce mécanisme).

## Conventions du dépôt

- **DOM brut, pas de framework** : les UI (barres, panneaux, `HideConfig`) sont construites en `document.createElement`, jamais de templates Handlebars. Rester cohérent avec ça.
- **Utilitaires partagés** dans `scripts/lib/common.js` : `makeNotify(tag)` → logger préfixé `[Arthak's Table · <tag>]` (`.warn` notifie aussi l'utilisateur via `ui.notifications`).
- Chaque fichier/classe/méthode publique porte une **doc JSDoc en français** expliquant l'intention.
- Le dossier **`macro/`** contient les scripts UI autonomes d'origine (ActionBar, TemplateBar, TokenAura, TokenHp), portés dans le module — référence historique.
- `modules/examples/` est **gitignoré** : modules tiers de référence (token-action-hud, monks-common-display) pour étude, pas du code du projet.
