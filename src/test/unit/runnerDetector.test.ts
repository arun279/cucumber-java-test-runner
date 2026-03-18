import { strict as assert } from 'assert';
import { extractRunnerClassName } from '../../execution/runnerDetector';

describe('runnerDetector', () => {
  describe('extractRunnerClassName', () => {

    it('detects class with @IncludeEngines("cucumber")', () => {
      const java = `
        package com.example;

        import org.junit.platform.suite.api.IncludeEngines;
        import org.junit.platform.suite.api.Suite;

        @Suite
        @IncludeEngines("cucumber")
        @SelectClasspathResource("features")
        public class CucumberTest {
        }
      `;
      assert.equal(extractRunnerClassName(java), 'CucumberTest');
    });

    it('detects class with @IncludeEngines({"cucumber"}) array syntax', () => {
      const java = `
        @Suite
        @IncludeEngines({"cucumber"})
        public class RunCucumberTests {
        }
      `;
      assert.equal(extractRunnerClassName(java), 'RunCucumberTests');
    });

    it('detects class with @Cucumber annotation', () => {
      const java = `
        import io.cucumber.junit.Cucumber;
        import org.junit.runner.RunWith;

        @RunWith(Cucumber.class)
        @Cucumber
        public class CucumberRunner {
        }
      `;
      assert.equal(extractRunnerClassName(java), 'CucumberRunner');
    });

    it('returns undefined when no runner annotation found', () => {
      const java = `
        import org.junit.jupiter.api.Test;

        public class UnitTest {
          @Test
          void testSomething() {}
        }
      `;
      assert.equal(extractRunnerClassName(java), undefined);
    });

    it('handles class without public modifier', () => {
      const java = `
        @Suite
        @IncludeEngines("cucumber")
        class MyCucumberTests {
        }
      `;
      assert.equal(extractRunnerClassName(java), 'MyCucumberTests');
    });

    it('does not match @IncludeEngines with non-cucumber engine', () => {
      const java = `
        @IncludeEngines("junit-jupiter")
        public class JupiterTest {
        }
      `;
      assert.equal(extractRunnerClassName(java), undefined);
    });

    it('handles whitespace variations in annotation', () => {
      const java = `
        @IncludeEngines( "cucumber" )
        public class SpacedTest {
        }
      `;
      assert.equal(extractRunnerClassName(java), 'SpacedTest');
    });

  });
});
