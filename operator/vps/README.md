# Préparer le VPS une seule fois

Pour X, le navigateur ouvre d’abord l’accueil avec le profil existant. Si les cookies de session sont présents, il reprend cette session sans repasser par le formulaire de connexion. Sinon, il ouvre le formulaire. La présence des cookies ne suffit pas à valider le compte : les contrôles d’identité, de stabilité et de sauvegarde restent obligatoires.

Le tableau de bord tourne sur le Mac. **Firefox, les contrôles Impit, les profils et les cookies tournent sur le VPS.**

Cette préparation s’adresse à la personne qui administre le serveur. Ensuite, l’utilisation quotidienne se fait dans l’interface.

## Ce qu’il faut

- Un VPS **Linux x86_64**, avec assez de mémoire pour un navigateur : le conteneur est limité à 3 Go, prévoir aussi de la place pour le système.
- Docker, Git et Python 3 installés.
- Un accès SSH par clé depuis le Mac, avec une clé d’hôte déjà connue.
- Un utilisateur SSH pouvant exécuter `sudo -n python3` sans demande de mot de passe. Il s’agit d’un accès administrateur : utilise un serveur que tu contrôles.
- Des proxys HTTP à IP fixe IPv4, avec identifiant et mot de passe.

## Installation sur le serveur

Dans une session SSH sur le VPS :

```sh
git clone https://github.com/azz1804/weespy-connect.git
cd weespy-connect
sudo bash operator/vps/install.sh
```

Le script télécharge geckodriver 0.37.1 depuis Mozilla et vérifie le digest fourni par la release. Si le digest manque ou ne correspond pas, il s’arrête.

Il construit ensuite :

1. `weespy-radar-firefox:local`, si cette base n’existe pas déjà : Firefox ESR, Python, Impit, Node et les outils d’affichage distant. Son [Dockerfile public](Dockerfile.base) est fourni.
2. `weespy-connect-firefox:v1`, qui ajoute Selenium et le pilote Firefox.

Il copie le code dans `/opt/weespy-connect-vps` et prépare `/etc/weespy/account-sessions` en accès privé. Aucun identifiant social n’est nécessaire pendant l’installation. Une base Firefox compatible déjà présente est conservée.

**Limite de validation :** le moteur applicatif et ses tests proviennent d’un déploiement existant. La recette publique de construction sur un VPS neuf doit encore être validée dans cet environnement ; les tests unitaires ne constituent pas un test d’installation complète.

## Revenir sur le Mac

Démarre l’application avec `npm start`, ouvre **Réglages**, indique l’accès SSH et clique sur **Enregistrer et charger**. Tu peux ensuite ajouter les IP et les comptes.

Le tableau écoute sur `127.0.0.1:49831` sur le Mac. **Ne l’expose pas sur Internet.** L’écran distant écoute sur `127.0.0.1:16081` sur le VPS et passe par un tunnel SSH ouvert à la demande. Aucun port de contrôle Firefox n’est publié.

## Fonctionnement du moteur

- `remote_jobs.py` prépare et suit un seul conteneur de connexion à la fois.
- `job.mjs` pilote les étapes et sauvegarde les résultats sur le VPS.
- `browser_bridge.py` pilote Firefox avec Selenium.
- `gateway.py` fournit le tunnel local vers le proxy attribué ; aucune dépendance à un autre dépôt privé n’est nécessaire.
- Impit puis Firefox vérifient l’IP de sortie avant la saisie des identifiants.
- Les profils sont séparés par réseau, compte et IP. Firefox s’exécute avec l’UID 1000.
- Les cookies restent dans le conteneur et le stockage privé du VPS ; seuls les états autorisés sont renvoyés au Mac.
- Le travail distant a une échéance de 30 minutes. Le Mac pilote la file et doit rester ouvert.

Le lancement d’un compte ne télécharge aucune image et ne bascule jamais sur un navigateur local si le moteur distant manque.

## Sessions déjà existantes

Les lecteurs de `operator/existing.mjs` reconnaissent plusieurs formats historiques WeeSpy. Les chemins sont explicitement définis dans `existing_paths`. Un autre logiciel peut utiliser d’autres formats : ses sessions ne seront pas automatiquement importées. Les sources reconnues restent en lecture seule et protègent les comptes et IP déjà utilisés.

## Tests

```sh
npm test
python3 -m unittest discover -s operator -p 'test_*.py'
python3 -m unittest discover -s operator/vps -p 'test_*.py'
```

`smoke.mjs` est un outil de diagnostic facultatif pour un administrateur. Il nécessite une configuration proxy privée fournie uniquement sur le serveur et ne soumet aucun identifiant social.
