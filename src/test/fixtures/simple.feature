@api
Feature: Task Management
  Managing tasks in the system.

  @smoke @create
  Scenario: Create a new task
    Given the task repository is empty
    When I create a task with title "Test Task"
    Then the response status code should be 201

  @update
  Scenario: Update an existing task
    Given a task exists with title "Old Title"
    When I update the task title to "New Title"
    Then the task title should be "New Title"
