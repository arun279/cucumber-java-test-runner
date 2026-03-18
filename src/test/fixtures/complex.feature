@regression
Feature: Complex Scenarios
  Testing various Gherkin constructs.

  Background:
    Given the system is initialized
    And the database is clean

  @parameterized @create
  Scenario Outline: Create items with priorities
    Given I am logged in
    When I create an item with priority "<priority>"
    Then the item should have priority "<priority>"

    @smoke
    Examples: Common priorities
      | priority |
      | HIGH     |
      | MEDIUM   |

    @edge-case
    Examples: Edge case priorities
      | priority |
      | LOW      |

  @search
  Scenario: Search with data table
    Given the following items exist:
      | name    | status |
      | Alpha   | ACTIVE |
      | Beta    | DONE   |
    When I search for items with status "ACTIVE"
    Then I should find 1 item

  @docstring
  Scenario: Create with description
    Given I am logged in
    When I create an item with body
      """json
      {
        "title": "Test",
        "description": "A detailed description"
      }
      """
    Then the item should be created
