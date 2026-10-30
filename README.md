# WeeSpy Connect

**Tes comptes, leurs IP et leur état de connexion, au même endroit.**

WeeSpy Connect est une petite application à ouvrir sur ton Mac pour gérer la connexion de comptes **LinkedIn, Instagram et X** sur un VPS.

Tu renseignes ton serveur, tu colles tes IP et tes comptes, puis tu lances la connexion. **Firefox travaille sur le VPS. Le Mac affiche seulement le tableau de bord.**

## Comment ça marche ?

### 1. Choisis ton VPS

Renseigne un accès SSH, par exemple `mon-vps` ou `utilisateur@adresse-du-serveur`. L’application charge l’inventaire et les sessions existantes qu’elle sait reconnaître.

### 2. Colle tes IP et tes comptes

Colle tes comptes, un par ligne. **Laisse le champ IP vide si des places sont déjà disponibles sur ton VPS.** Les comptes sont répartis dans les onglets LinkedIn, Instagram et X.

WeeSpy attribue automatiquement une **IP déjà disponible pour le réseau concerné** à chaque nouveau compte. Si tu fournis des IP supplémentaires, seules celles qui manquent sont ajoutées ; les autres sont indiquées comme non ajoutées dans le récapitulatif. Les comptes déjà présents conservent leur affectation. Une IP peut accueillir un compte de chaque réseau, dans la limite de 25 comptes par réseau.

### 3. Vérifie et connecte en un clic

Clique sur **Vérifier et connecter**. Chaque IP est réellement contrôlée depuis le VPS :

**En attente → Vérification… → IP validée ou erreur**

Une fois les IP validées, l’application ouvre automatiquement Firefox sur le VPS, renseigne les formulaires reconnus et sauvegarde les sessions sur ce serveur. Le contrôle IP ne valide pas encore le mot de passe : la ligne du compte affiche ensuite le résultat réel de la connexion.

Seuls les comptes saisis sont traités par défaut. L’option d’inclure les comptes en attente concerne uniquement les réseaux saisis, pour éviter de lancer Instagram pendant un import X.

Si un CAPTCHA ou une validation manuelle apparaît, la ligne du compte indique quoi faire. Tu peux ouvrir l’écran du Firefox distant, terminer l’étape, puis cliquer sur **Reprendre**.

## Ce que tu vois dans le tableau

| Information | À quoi ça sert |
| --- | --- |
| Compte et réseau | Retrouver facilement LinkedIn, Instagram ou X |
| IP fixe | Savoir quelle IP est associée au compte |
| Chargement réel | Suivre le contrôle IP, la connexion et la sauvegarde |
| Cookies masqués | Voir si `li_at`, `JSESSIONID`, `auth_token`, `ct0` ou `sessionid` sont présents |
| Date du contrôle | Savoir quand le résultat a été vérifié |
| Erreur et historique | Comprendre ce qui bloque, compte par compte |
| Reconnecter | Relancer un compte géré par l’outil avec son IP |

**Un cookie présent ne garantit pas que le compte est encore connecté.** L’application distingue la présence des cookies d’une vérification d’identité datée. LinkedIn fait l’objet de deux contrôles d’identité avec Impit avant sauvegarde. Pour X et Instagram, la validation repose sur le navigateur et la sauvegarde du fichier.

Les comptes détectés dans des services existants restent en lecture seule, indiqués **Géré sur le VPS**, pour éviter les doublons et les réaffectations accidentelles.

## Démarrer sur ton Mac

Il faut **macOS**, **Node.js 26**, un accès SSH par clé et un **VPS déjà préparé**.

> La préparation du VPS se fait une seule fois. Installer l’application sur le Mac n’installe pas automatiquement Firefox sur le serveur : suis le [guide de préparation du VPS](operator/vps/README.md).

Dans le Terminal :

```sh
git clone https://github.com/azz1804/weespy-connect.git
cd weespy-connect
npm ci --ignore-scripts --no-audit --no-fund
npm start
```

L’application s’ouvre dans ton navigateur. Renseigne ton VPS dans **Réglages**, puis clique sur **Ajouter des comptes**.

Une fois ce navigateur autorisé, les nouveaux onglets et les redémarrages conservent l’accès au tableau de bord, sans lien spécial.

Les fois suivantes, tu peux double-cliquer sur [`Lancer-WeeSpy-Connect.command`](operator/Lancer-WeeSpy-Connect.command), dans le dossier `operator`.

**Garde l’application et sa fenêtre Terminal ouvertes pendant le traitement.** La file est pilotée depuis ton Mac ; les connexions et les sessions restent sur le VPS.

## Quel format coller ?

Les exemples ci-dessous sont fictifs. Remplace-les dans l’application par tes propres accès.

**IP fixe**

```text
203.0.113.10:12323:identifiant_proxy:mot_de_passe_proxy
```

**LinkedIn**

```text
compte@example.test:mot_de_passe:identifiant-du-profil:
```

Si le compte utilise une application 2FA, ajoute son secret Base32 après le dernier `:`. Ce secret n’est pas le code temporaire à six chiffres.

**Instagram ou X, sans 2FA**

```text
nom_du_compte:mot_de_passe
```

Pour Instagram et X, un secret 2FA peut être ajouté en troisième champ. Le [guide détaillé](operator/README.md) décrit les autres formats acceptés.

## Où vont mes accès ?

- Les accès saisis servent à préparer l’import en mémoire, puis sont enregistrés sur **ton VPS** lors du lancement.
- Les cookies restent sur le VPS. Le tableau reçoit uniquement leur nom, leur état et la date du contrôle ; le masque affiché ne contient aucun morceau du cookie.
- Le tableau de bord écoute uniquement sur ton Mac, sur `127.0.0.1`.
- L’écran du Firefox distant passe par un tunnel SSH.
- Aucun compte, mot de passe, cookie ou profil de navigateur réel n’est fourni dans ce dépôt.

## Claude CLI ou Codex : facultatif

Tu peux utiliser les boutons correspondants dans **Réglages** pour relier un CLI déjà installé au tableau de bord. L’assistant peut consulter les états et lancer les comptes déjà préparés ; **il ne reçoit pas leurs mots de passe ni leurs cookies**. Tu peux aussi tout faire avec les boutons de l’application, sans assistant IA.

## À savoir

- Une session peut expirer ou être révoquée : aucune connexion permanente n’est garantie.
- CAPTCHA, code reçu par e-mail, restriction ou vérification d’identité peuvent demander ton intervention.
- Les interfaces des réseaux changent ; certaines étapes peuvent nécessiter une adaptation du logiciel.
- Cette version utilise des proxys HTTP à IP fixe IPv4 et un VPS Linux x86_64. La construction du moteur sur un serveur neuf reste à valider sur ton environnement.
- Utilise uniquement des comptes et des accès que tu es autorisé à gérer.

## Pour les développeurs

```sh
npm test
python3 -m unittest discover -s operator -p 'test_*.py'
python3 -m unittest discover -s operator/vps -p 'test_*.py'
```

Les tests utilisent des données fictives et ne connectent aucun compte réel.

- [`operator/`](operator/) : tableau de bord, import, suivi et liaison SSH.
- [`operator/vps/`](operator/vps/) : moteur Firefox exécuté sur le serveur.
- [`operator/README.md`](operator/README.md) : fonctionnement détaillé.
- [`operator/vps/README.md`](operator/vps/README.md) : préparation du serveur et architecture.

`connect.mjs` contient aussi un ancien parcours manuel local conservé pour compatibilité et tests. **Le lancement normal via `npm start` utilise exclusivement le moteur distant.**
