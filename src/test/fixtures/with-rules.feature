@billing
Feature: Billing Rules
  Business rules for billing.

  Background:
    Given a customer account exists

  Rule: Free tier limits
    Customers on the free tier have usage limits.

    Background:
      Given the customer is on the free tier

    @limit
    Scenario: Enforce storage limit
      When the customer uploads 6GB of data
      Then the upload should be rejected

    @limit
    Scenario: Allow within limit
      When the customer uploads 4GB of data
      Then the upload should succeed

  Rule: Premium tier benefits
    Premium customers get additional features.

    @premium
    Scenario: Unlimited storage
      Given the customer is on the premium tier
      When the customer uploads 100GB of data
      Then the upload should succeed
