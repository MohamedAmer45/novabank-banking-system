# QA workspace

The application is ready for the dedicated QA implementation phases. Planned suites:

- `playwright-typescript/` — primary customer/admin E2E suite
- `selenium-java/` — Java + TestNG regression framework
- `cypress-typescript/` — frontend/component/integration coverage
- `postman/` — collections, environments and chained API workflows
- `rest-assured-java/` — coded API automation
- `database/` — SQL reconciliation, constraints, rollback, JDBC and Testcontainers
- `cucumber/` — selected business-critical BDD scenarios
- `jmeter/` and `k6/` — performance, stress, spike and soak tests
- `security/` — OWASP ZAP automation and authorization cases
- `contract/` — Pact consumer/provider contracts
- `wiremock/` — deterministic external-service simulations
- `accessibility/` — axe-core checks
- `reports/` — Allure and performance reporting outputs

These suites are intentionally not pre-filled with fake coverage. They should be built against the completed banking behavior so every test has a traceable requirement and business purpose.
