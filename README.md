# Cucumber Test Runner for Java

Run and debug Cucumber BDD scenarios from VS Code's native Test Explorer.

## Features

- Discovers `.feature` files and displays them in the Test Explorer with full hierarchy: Feature > Rule > Scenario > Scenario Outline > Examples
- Run individual scenarios, entire feature files, or all tests with the play button
- Debug mode with breakpoint support in step definitions (attaches to Maven Surefire's forked JVM via JDWP)
- Parses all Gherkin constructs: Scenario Outline with multiple Examples blocks, Rule keyword, Background, Data Tables, Doc Strings, tags, i18n
- Tag inheritance displayed in the test tree (Feature tags propagate to scenarios)
- Auto-detects Maven Wrapper (`mvnw` / `mvnw.cmd`) — prefers it over global `mvn`
- Auto-detects Cucumber runner class (`@IncludeEngines("cucumber")` or `@Cucumber`)
- Preserves existing Cucumber reporter plugins while adding JSON output for result parsing
- Multi-project support: multiple Maven projects in one workspace are grouped by project name
- File watching with debouncing — test tree updates as you edit `.feature` files

## Requirements

- **Maven** — the project must use Maven with `maven-surefire-plugin`
- **`cucumber-junit-platform-engine`** — Cucumber's JUnit Platform integration must be in your test dependencies
- **Debugger for Java** (`vscjava.vscode-java-debug`) — required only for debug mode

A typical `pom.xml` setup:

```xml
<dependency>
    <groupId>io.cucumber</groupId>
    <artifactId>cucumber-java</artifactId>
    <scope>test</scope>
</dependency>
<dependency>
    <groupId>io.cucumber</groupId>
    <artifactId>cucumber-junit-platform-engine</artifactId>
    <scope>test</scope>
</dependency>
<dependency>
    <groupId>org.junit.platform</groupId>
    <artifactId>junit-platform-suite</artifactId>
    <scope>test</scope>
</dependency>
```

With a runner class like:

```java
@Suite
@IncludeEngines("cucumber")
@SelectClasspathResource("features")
public class CucumberTest {
}
```

## Installation

### From VSIX (local)

```bash
code --install-extension cucumber-java-test-runner-0.1.0.vsix
```

### From source

```bash
git clone <repo-url>
cd cucumber-java-test-runner
npm install
npm run build
npx vsce package --no-dependencies --allow-missing-repository
code --install-extension cucumber-java-test-runner-0.1.0.vsix
```

## Usage

1. Open a Maven project that has `.feature` files in `src/test/resources/`
2. Open the Testing sidebar (beaker icon)
3. Feature files appear grouped by project, with scenarios listed under each feature
4. Click the play button next to a scenario to run it, or the play button on a feature to run all its scenarios
5. Click the debug icon to debug with breakpoints in your step definitions

Multiple Maven projects in one workspace are automatically detected and grouped by project name.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `cucumberTestRunner.maven.executable` | `mvn` | Path to Maven executable. Maven Wrapper is auto-detected and preferred. |
| `cucumberTestRunner.maven.additionalArgs` | `[]` | Additional Maven arguments (e.g., `["-Pintegration"]`). |
| `cucumberTestRunner.runnerClass` | *(auto-detected)* | Cucumber runner class name. Scanned from `src/test/java/` if empty. |
| `cucumberTestRunner.featuresPath` | *(auto-detected)* | Path to features directory relative to project root. |
| `cucumberTestRunner.defaultTags` | *(none)* | Default tag expression for all runs (e.g., `"not @wip"`). |

## Known Limitations

- **Maven only** — Gradle support is planned but not yet implemented. The architecture supports it (pluggable `BuildToolRunner` interface).
- **Multi-module Maven projects** (parent POM with `<modules>`) are not supported. The extension detects independent Maven projects within a workspace by finding the nearest `pom.xml` with a `src/` directory. Multi-module aggregator POMs without `src/` are skipped.
- **Debug mode** supports one project at a time. If you select tests from multiple projects and click Debug, only the first project runs in debug mode. The rest are skipped with a warning. Run mode handles multiple projects sequentially without this restriction.

## How It Works

1. **Discovery**: Parses `.feature` files using the official `@cucumber/gherkin` parser (the same one the Cucumber VS Code extension uses)
2. **Execution**: Runs `mvn test` with `-Dcucumber.features=path/to/file.feature:lineNumber` to target specific scenarios
3. **Results**: Parses Cucumber's JSON reporter output and maps results back to test items by feature URI and line number
4. **Debug**: Starts Maven Surefire with JDWP debug arguments, polls the debug port, then attaches VS Code's Java debugger

## License

MIT
