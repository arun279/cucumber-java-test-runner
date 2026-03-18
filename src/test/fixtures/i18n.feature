# language: fr
@international
Fonctionnalité: Gestion des tâches
  Gérer les tâches dans le système.

  Scénario: Créer une tâche
    Soit le dépôt de tâches est vide
    Quand je crée une tâche avec le titre "Ma Tâche"
    Alors le code de réponse devrait être 201
