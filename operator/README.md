# WeeSpy Connect

Un tableau de bord sur le Mac pour ajouter des comptes LinkedIn, X et Instagram et les connecter dans Firefox directement sur le VPS, avec leur IP fixe. Aucun navigateur local n’exécute les connexions. L’accueil montre le VPS, les sessions enregistrées, les comptes à connecter et les problèmes à vérifier. Un parcours guidé prépare les connexions ; l’onglet **Comptes** garde la liste compte, IP, état, erreur et bouton **Reconnecter**. Les options complémentaires restent dans **Réglages**.

## Démarrer

Double-clique sur **Lancer-WeeSpy-Connect.command**. Garde sa fenêtre ouverte pendant l’utilisation. Le navigateur ouvre l’application sur ton Mac. Si elle tourne déjà, le lanceur retrouve la session ouverte.

Autre possibilité, dans le dossier `weespy-connect` :

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run app
# Pour ouvrir le tableau uniquement depuis un onglet existant :
node operator/server.mjs --no-open
```

Il faut macOS, Node.js 26 et un navigateur pour afficher le tableau de bord. Firefox et Chrome locaux ne sont pas utilisés pour les connexions aux comptes. L’accès au VPS utilise une clé SSH déjà configurée : alias ou `utilisateur@adresse`, avec un port et un chemin de clé facultatifs. La clé d’hôte doit être connue ; l’application ne désactive pas cette vérification. Le VPS doit disposer de Python 3 et de `sudo` sans mot de passe. Le moteur doit être installé dans `/opt/weespy-connect-vps`, avec Docker, l’image `weespy-connect-firefox:v1` et l’image de contrôle Impit `weespy-radar-firefox:local`. Le [guide VPS](vps/README.md) explique cette préparation. L’image automatique reprend le Firefox ESR déjà présent et ajoute son pilote WebDriver. Le lancement ne télécharge pas d’image et ne bascule jamais sur un navigateur local si le moteur distant manque. Un autre VPS doit d’abord recevoir ce moteur. **`mon-vps` est un exemple : renseigne ton propre accès SSH.** Aucun mot de passe SSH n’est demandé ou conservé.

## Ajouter et connecter

Le dernier VPS est chargé automatiquement à l’ouverture. Au premier démarrage, l’application utilise l’alias WeeSpy `mon-vps`. Pour choisir un autre serveur, ouvre **Réglages**, renseigne l’accès SSH et clique **Enregistrer et charger**.

Depuis l’accueil, clique **Tout connecter** (ou **Commencer la configuration** sur une installation vide). **Ajouter des comptes**, dans l’onglet Comptes, ouvre le même parcours :

1. **Ton VPS** : vérifie l’accès SSH prérempli ou renseigne un autre serveur. L’application vérifie le serveur et récupère son inventaire.
2. **Tes accès** : colle les IP supplémentaires, puis tes comptes dans les onglets LinkedIn, X et Instagram. Tu peux remplir les trois réseaux dans le même import. Les IP disponibles pour chaque réseau sont attribuées automatiquement. Laisse le champ IP vide si elles suffisent ; seules les IP supplémentaires nécessaires sont ajoutées. L’option d’inclure les comptes en attente est décochée par défaut et ne concerne que les réseaux saisis. Clique sur **Vérifier et connecter** pour lancer le parcours automatique.
3. **Connexion** : chaque IP nouvelle ou attribuée à la sélection est contrôlée depuis le VPS avec Impit. Chaque ligne passe de **En attente** à **Vérification**, puis **IP validée** ou **À corriger** avec une erreur. Le compteur avance uniquement après une réponse réelle. Lorsque tous les contrôles réussissent, les connexions démarrent automatiquement, sans second clic. **Revérifier les IP** relance les contrôles ; **Retour** permet de corriger les accès. Quitter le parcours pendant les contrôles annule le lancement. Recharger un onglet ne l’annule pas ; le processus local doit rester ouvert. Le tableau s’ouvre automatiquement après le lancement.

Le récapitulatif ne modifie aucun inventaire et ne lance aucun navigateur. Tous les réseaux sont validés ensemble avant le lancement : une erreur de format ou un manque d’IP empêche tout ajout partiel. Une erreur de format précise le réseau et le numéro du compte. Si les accès, le serveur, l’inventaire ou la sélection changent, il faut revoir le récapitulatif. Les doublons identiques déjà enregistrés ne sont pas reconnectés ; utilise **Reconnecter** sur leur ligne pour le faire.

Tu peux aussi lancer les comptes déjà présents sans coller de nouveaux accès : conserve l’option des comptes en attente et passe au récapitulatif. Une nouvelle IP seule n’est pas sauvegardée par ce parcours : au moins un compte doit être à connecter.

Les affectations sont sauvegardées sur le VPS, puis les comptes passent dans la file un par un. Impit contrôle l’IP réelle depuis le VPS avant l’ouverture de Firefox sur ce même VPS. Le moteur remplit les formulaires connus et les codes TOTP lorsqu’il reconnaît une demande provenant de l’application 2FA. Le moteur attend dix secondes de stabilité des cookies et de l’identité, puis ferme Firefox avant la vérification et la sauvegarde sur place. Les cookies ne transitent pas par le Mac. LinkedIn exige `li_at` et `JSESSIONID` : le VPS vérifie son IP de sortie puis l’identité deux fois avec Impit, à huit secondes d’intervalle. Les cookies renouvelés par LinkedIn sont sauvegardés. Pour X et Instagram, la validation porte sur la reconnaissance dans Firefox sur le VPS et la sauvegarde ; aucune vérification d’identité en ligne depuis le VPS n’est revendiquée. Les zones contenant les accès sont vidées après le lancement réussi, en quittant le parcours ou à la fermeture de la page. Aucun brouillon de comptes n’est conservé dans le navigateur.

**Reconnecter**, sur une ligne, refait tout ce parcours pour ce compte en conservant son IP. **Connecter les N en attente** permet de lancer les comptes déjà présents qui n’ont pas de session enregistrée. Une erreur de compte ou d’IP laisse la file passer au suivant ; une erreur de transfert vers le VPS arrête la file. Une vérification humaine met la file en pause avec les actions directement sur la ligne concernée.

Le sélecteur **Tous les réseaux / Instagram / X / LinkedIn** regroupe ou filtre les comptes par type. Dans la vue Tous, les comptes sont regroupés dans cet ordre, avec un titre par réseau et les noms classés dans chaque groupe. Le réseau choisi reste mémorisé dans l’onglet. Les filtres **Tous**, **À connecter**, **À vérifier** et **Sur le VPS**, ainsi que la recherche, s’appliquent à ce réseau. Le bouton **Connecter les N en attente** lance uniquement les comptes en attente du réseau sélectionné (tous les réseaux si Tous est sélectionné), indépendamment du filtre d’état ou de la recherche. Les IP attribuées restent inchangées. Son **Historique** garde les 15 derniers changements d’état pendant l’ouverture de l’application ; il est effacé au rechargement du VPS ou à l’arrêt du logiciel.

## Cookies masqués

Chaque ligne affiche les cookies requis (`li_at` et `JSESSIONID`, `auth_token` et `ct0`, ou `sessionid`) avec un masque fixe, leur présence ou expiration et la date de lecture sur le VPS. Aucune valeur, longueur, empreinte ou portion de cookie ne traverse SSH vers le tableau de bord. L’identité vérifiée est présentée avec sa propre date : la présence d’un fichier ne prouve pas une connexion actuelle. Une tentative échouée affiche les éventuels cookies comme ceux de la sauvegarde précédente. Les sessions déjà présentes dans les services sont incluses ; les exports Firefox doivent correspondre au compte, à l’IP et à la date du manifeste. Une source devenue illisible ne conserve pas de preuve de présence actuelle.

## Ce que les états signifient

- **Connexion validée** : session stable dans Firefox sur le VPS et sauvegarde relue sur le VPS, avec une double vérification d’identité depuis le VPS pour LinkedIn. L’heure et le détail du contrôle sont affichés. Un cookie qui disparaît pendant le contrôle, une identité différente ou un accusé de sauvegarde incohérent empêchent ce succès.
- **Session sur VPS** : le fichier existe et ses cookies requis ne sont pas connus comme expirés. Ce n’est pas une preuve d’authentification actuelle auprès du réseau. Au bout de cinq minutes, la connexion récemment validée repasse à cet état lors du contrôle suivant.
- **Session expirée / Erreur** : le problème apparaît sur la ligne, avec sa catégorie : IP, connexion, identifiants, vérification, session ou VPS. Les problèmes de compte et d’IP sont affichés ensemble s’ils coexistent.
- **Point vert à côté de l’IP** : une vérification de la sortie publique via Impit a réussi ; le survol donne son heure. Gris signifie pas encore vérifiée, rouge signale une erreur.

Tant que l’application reste ouverte, un contrôle SSH vérifie chaque minute la présence et l’expiration des sessions, sans retourner les cookies au Mac. Les IP gérées par le moteur distant sont contrôlées environ toutes les cinq minutes, une seule fois par IP partagée. Les sources externes en lecture seule gardent leurs propres preuves datées, sans contrôle de leur ancienne IP d’inventaire. Ces contrôles attendent la fin d’une file de connexions et ne se superposent pas entre eux. Ils détectent les fichiers manquants, incomplets ou expirés, les IP inaccessibles ou différentes et les problèmes d’accès au VPS. Ils lisent aussi les métadonnées des sessions des services décrites plus bas, mais ne vérifient pas leur fonctionnement en ligne. Une révocation anticipée reste inconnue sauf si le service l’a consignée dans la source lue.

Les sessions et profils restent sur le VPS. Chaque connexion tourne dans un conteneur distant temporaire ; la file et le tableau de bord restent pilotés depuis le Mac. Garde l’application ouverte pour traiter toute la file et répondre aux étapes manuelles. Fermer normalement l’application demande l’arrêt du compte actif. Après une coupure réseau, le travail distant peut continuer, avec une limite de trente minutes ; relancer le même compte retrouve le travail actif au lieu d’ouvrir un doublon. Aucune session n’est garantie permanente.

Formats :

```text
IP : ip:port:identifiant_proxy:mot_de_passe_proxy
LinkedIn : email:mot_de_passe:identifiant_public_du_profil:secret_2fa
Instagram : pseudo:mot_de_passe:secret_2fa
X : pseudo:mot_de_passe
X avec 2FA : pseudo:mot_de_passe:secret_2fa
X avec boîte e-mail : pseudo:mot_de_passe:email:mot_de_passe_email:secret_2fa
```

Le secret 2FA est le secret Base32, pas un code à six chiffres. Pour Instagram, il est facultatif. Pour LinkedIn sans 2FA, termine la ligne par `:`. Les champs de compte ne peuvent pas contenir de deux-points ni d’espace dans ce format. Les comptes X au format historique à quatre champs restent acceptés. L’application n’utilise pas le mot de passe de la boîte e-mail pour consulter des messages.

Les affectations existantes restent en place. Lors d’un import de comptes, les IP existantes sont utilisées en premier. Seules les IP supplémentaires nécessaires sont ajoutées ; un import explicite d’IP seules peut préparer du stock. Chaque nouveau compte prend la première place libre **pour son réseau**. Une IP peut donc avoir un LinkedIn, un X et un Instagram. Limite : 25 IP et 25 comptes par réseau. Une réimportation identique est ignorée ; des accès différents pour une IP ou un compte déjà connu sont refusés pour éviter un remplacement involontaire. Les réservations des services reconnus sur le VPS sont prises en compte par réseau. Un compte déjà identifié dans ces services ne reçoit pas une seconde affectation.

## Comptes déjà présents dans les services du VPS

À l’ouverture, à chaque contrôle du VPS et juste avant de lancer une file, l’application recherche aussi les sessions déjà utilisées par les services WeeSpy. Le lecteur s’exécute sur le VPS et renvoie seulement les noms publics, IP, sources, dates, états et présence des cookies ; il ne renvoie aucune valeur de cookie ni accès de proxy au Mac.

Sources prises en charge, en lecture seule :

- X : `/etc/weespy/secrets/runtime/x-managed-accounts.json`.
- LinkedIn : `/etc/weespy/secrets/linkedin-pool/jars/<compte>/jar.json` et `visit.json`, avec les IP configurées dans `/etc/weespy/secrets/runtime/dedicated-proxies.json`.
- Instagram : `/etc/weespy/instagram-scraper/accounts.json` et `account-auth.json`, pour les comptes ayant déjà un `sessionid`.

Un profil reconnu est fusionné avec sa ligne d’inventaire. L’IP de la session existante est affichée, et une différence avec l’IP prévue par le nouvel inventaire est signalée. L’inventaire original et les sessions des services ne sont pas modifiés. Les autres sessions apparaissent dans des lignes supplémentaires **Géré sur le VPS**, dans le filtre de leur réseau. Un identifiant technique comme `x08` ne suffit pas à identifier le profil `x8` : ces sessions restent séparées tant que le profil n’est pas connu. Les totaux comptent donc des fiches visibles, dont certaines identités restent à rapprocher.

Les états distinguent **Session sur VPS**, **Désactivé**, **Session expirée**, **Erreur** (notamment perte de session signalée par le service) et **État non vérifié**. Une ancienne erreur LinkedIn n’est retenue que si elle date d’après la dernière mise à jour de sa session. Le compteur **Sessions sur le VPS** inclut les sessions présentes mais désactivées ou à réparer ; il ne signifie pas autant de comptes authentifiés aujourd’hui.

Les sessions gérées par les services ne sont pas reconnectées par cet outil. Les nouvelles affectations évitent leurs IP pour le même réseau. Une affectation existante qui entre en conflit est bloquée et signalée. Si un service possède des sessions sans nom de profil, les nouvelles connexions de ce réseau sont mises en attente pour éviter un doublon. Une erreur de lecture d’une source conserve le dernier état connu et suspend les nouveaux lancements jusqu’à une lecture réussie. Aucun rapprochement par simple numéro, aucune réactivation, aucune migration et aucun remplacement de session de service n’est effectué.

La détection couvre ces sources du VPS sélectionné et le dossier de sessions de l’outil. Elle ne parcourt pas les autres serveurs, les profils Firefox sur le VPS personnels ou des services non intégrés. Elle ne refait pas de requête d’authentification aux réseaux sociaux et ne garantit pas la validité actuelle des cookies.

## Quand Firefox sur le VPS attend ton intervention

Un CAPTCHA, une vérification par e-mail/SMS, un formulaire inconnu ou un refus de connexion met le compte en pause. Clique **Voir Firefox sur le VPS**, termine l’étape dans l’écran distant, puis clique **Reprendre** sur sa ligne, ou **Passer**. Le logiciel ne résout pas de CAPTCHA, ne change pas de mot de passe et n’accède pas à la messagerie. Il ne retente pas automatiquement un mot de passe refusé, y compris après **Reprendre**. Si LinkedIn revient à la connexion après une 2FA effectivement soumise, une seule reprise automatique est autorisée sur le même profil et la même IP, sans refus ni défi préalable. Le formulaire de retour qui demande seulement le mot de passe est reconnu. Le moteur vérifie que les champs ont bien conservé les valeurs avant de cliquer. Un parcours automatique est limité à dix minutes ; une attente humaine n’est pas interrompue, mais le délai est contrôlé à la reprise.

Si l’identité du compte ne peut pas être reconnue dans la navigation du site, vérifie-la toi-même dans Firefox sur le VPS puis clique **Confirmer le compte**. Cette confirmation est réservée à l’interface locale et n’est pas disponible aux assistants. Elle ne permet jamais de passer outre une identité reconnue comme différente ; LinkedIn doit ensuite réussir le contrôle depuis le VPS.

**Arrêter** annule la file, demande l’arrêt du navigateur et du proxy sur le VPS, puis ferme le tunnel d’affichage local. Les sessions déjà envoyées restent sur le VPS. Une interruption SSH après le transfert peut rendre le résultat incertain : recharge le VPS pour lire son état. Une erreur de transfert arrête la file.

## Avec Claude CLI ou Codex / ChatGPT

La connexion à ChatGPT passe par **Codex CLI installé sur le Mac**. Cette version ne crée pas de service accessible depuis ChatGPT web. Aucun abonnement IA n’est nécessaire à la connexion automatique depuis l’application.

Connecte-toi une fois avec le CLI choisi :

```sh
claude auth login
# ou
codex login
```

Dans **Réglages → Piloter depuis Claude CLI ou Codex**, clique **Relier Claude CLI** ou **Relier Codex**. Ce bouton enregistre le petit connecteur local `weespy-local` dans la configuration du CLI choisi, à portée utilisateur. Il faut que le CLI soit accessible dans le PATH. Ouvre ensuite une nouvelle conversation CLI et demande :

> Connecte les comptes WeeSpy prêts, puis donne-moi l’état de la file.

Importe les secrets dans l’application, jamais dans le chat. Les cinq outils du connecteur permettent de consulter l’état, lancer la file, reprendre après une intervention, passer un compte ou arrêter. Ils ne retournent ni identifiant de connexion, ni libellé de profil, ni mot de passe, ni secret 2FA, ni cookie. Les IP et les numéros de compte sont visibles par l’assistant. Les éventuelles autorisations du CLI restent applicables.

Le logiciel n’appelle pas un modèle pour décider où saisir un mot de passe. Les assistants commandent la file ; les actions de connexion sont exécutées sur le VPS par le moteur, sur les domaines et formulaires reconnus.

Installation manuelle du connecteur depuis ce dossier, si besoin :

```sh
claude mcp add --scope user --transport stdio weespy-local -- "$(command -v node)" "$PWD/mcp.mjs"
codex mcp add weespy-local -- "$(command -v node)" "$PWD/mcp.mjs"
```

Documentation officielle : [MCP dans Codex](https://developers.openai.com/codex/mcp/), [MCP dans Claude Code](https://code.claude.com/docs/en/mcp).

## Où vont les données ?

Sur le **VPS**, dossier root mode 700, fichiers root mode 600 :

- `/etc/weespy/account-sessions/operator-inventory.json` : accès et affectations, créés au premier lancement de la file. Les accès sont protégés par les permissions du serveur, pas chiffrés séparément.
- `/etc/weespy/account-sessions/<réseau>-<numéro>.json` : cookies complets du réseau, identité attendue, IP et date de capture. Champs compatibles avec le CLI manuel, avec une preuve de vérification supplémentaire pour les nouveaux exports automatiques.
- `.operator-lock` et fichiers temporaires privés dans ce même dossier pour sérialiser les écritures et effectuer des remplacements atomiques. Une modification concurrente de l’inventaire provoque un refus et exige un rechargement.

Si le nouvel inventaire n’existe pas, l’application lit les deux inventaires WeeSpy historiques, sans les modifier. Une fois créé, le nouvel inventaire devient la référence de cette application. Les modifications futures des fichiers historiques ne sont pas fusionnées automatiquement. Le CLI manuel continue à utiliser les fichiers historiques et ne voit donc pas les futurs ajouts faits exclusivement dans cette application. Aucune configuration de worker, aucun service de collecte et aucun autre serveur ne sont modifiés. Le logiciel fournit des fichiers de session ; il n’active pas leur utilisation dans des workers qui ne les lisent pas déjà.

Sur le **VPS**, les nouveaux profils automatiques sont isolés par compte, réseau et IP dans `/etc/weespy/account-sessions/vps-profiles/`. Les travaux privés sont conservés dans `operator-jobs/` ; l’interface ne reçoit que leurs métadonnées de progression. Le conteneur publie uniquement l’écran distant sur `127.0.0.1:16081`. Le pilote du navigateur n’est pas publié. Le navigateur tourne sans privilèges, séparé du processus qui sauvegarde les sessions.

Sur le **Mac**, les imports restent en mémoire, puis sont réservés dans l’inventaire du VPS. Aucun nouveau profil de réseau social ni export de cookie n’est créé localement par ce parcours. Le fichier privé `~/WeespyAccounts/operator-runtime.json` contient l’adresse et le jeton du tableau de bord. Les anciens profils de la version locale ne sont pas réutilisés.

L’application écoute uniquement sur `127.0.0.1:49831`, exige son jeton et contrôle l’hôte et l’origine. Si une intervention est nécessaire, elle ouvre un tunnel SSH dédié vers le bureau distant. **Voir Firefox sur le VPS** affiche ce bureau dans un onglet ; le navigateur qui se connecte au réseau social reste sur le serveur. Le tunnel est fermé à la fin du compte ou à l’arrêt du parcours.

`~/WeespyAccounts/operator-settings.json`, privé, garde uniquement le dernier alias SSH, le port éventuel et le chemin de la clé. Il ne contient ni clé privée ni accès de compte. Les inventaires ne sont pas copiés dans ce fichier.

Évite de lancer le CLI manuel et cette application simultanément sur le même compte : ils utilisent des profils distincts, mais écrivent le même fichier de session sur le serveur.

## Validation et limites

```sh
# Depuis weespy-connect
npm test
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s operator -p 'test_*.py'
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s operator/vps -p 'test_*.py'
```

Les tests couvrent l’import, les affectations, les protections HTTP, le protocole MCP, les étapes de connexion, les pauses, l’arrêt et les écritures atomiques sur un faux VPS local. Les tests précédents d’Impit, TOTP, proxy et capture manuelle restent exécutés. Tous les comptes, secrets et sessions de test sont fictifs ; les tests ne se connectent à aucun réseau social ni serveur réel.

Les régressions couvrent notamment la disparition des cookies après six secondes, la reprise unique après 2FA, les refus explicites, les champs qui n’acceptent pas la saisie, les identités différentes, les captures périmées, les échecs de sauvegarde et les anciennes preuves qui masquaient un nouvel échec. Les tests de vérification distante utilisent des réponses fictives ; ils ne reconnectent pas les comptes réels. Un changement de formulaire ou une protection du réseau peut encore nécessiter une intervention humaine. Une preuve datée ne garantit pas la validité future d’une session.

Les anciennes sessions Firefox opérées sur VPS sont aussi lues depuis leur manifeste sans secrets. Une vérification Impit datée, l’IP effectivement associée et les erreurs apparaissent dans le tableau. Cette source remplace la ligne de l’ancien worker pour une même identité. Ces lignes sont en lecture seule : leur reconnexion reste gérée par le parcours opérateur dédié. Les nouveaux imports utilisent le moteur automatique Firefox du VPS.
