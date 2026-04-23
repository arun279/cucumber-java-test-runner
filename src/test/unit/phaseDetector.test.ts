import { strict as assert } from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {
  detectMavenPhase,
  clearPhaseCache,
  hasActiveFailsafePlugin,
} from '../../execution/phaseDetector';

let tmpDir: string;

function writePom(xml: string) {
  fs.writeFileSync(path.join(tmpDir, 'pom.xml'), xml);
}

describe('phaseDetector', () => {

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-detector-test-'));
    clearPhaseCache();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('hasActiveFailsafePlugin()', () => {

    it('returns false for a pom without failsafe', () => {
      const pom = `
        <project>
          <build>
            <plugins>
              <plugin>
                <artifactId>maven-surefire-plugin</artifactId>
              </plugin>
            </plugins>
          </build>
        </project>
      `;
      assert.equal(hasActiveFailsafePlugin(pom), false);
    });

    it('returns true when failsafe is declared in build/plugins', () => {
      const pom = `
        <project>
          <build>
            <plugins>
              <plugin>
                <artifactId>maven-failsafe-plugin</artifactId>
                <executions>
                  <execution>
                    <goals>
                      <goal>integration-test</goal>
                      <goal>verify</goal>
                    </goals>
                  </execution>
                </executions>
              </plugin>
            </plugins>
          </build>
        </project>
      `;
      assert.equal(hasActiveFailsafePlugin(pom), true);
    });

    it('ignores failsafe declared only in pluginManagement', () => {
      // This is exactly the shape inherited from spring-boot-starter-parent —
      // presence in pluginManagement alone does not activate the plugin.
      const pom = `
        <project>
          <build>
            <pluginManagement>
              <plugins>
                <plugin>
                  <artifactId>maven-failsafe-plugin</artifactId>
                  <version>3.2.5</version>
                </plugin>
              </plugins>
            </pluginManagement>
            <plugins>
              <plugin>
                <artifactId>maven-surefire-plugin</artifactId>
              </plugin>
            </plugins>
          </build>
        </project>
      `;
      assert.equal(hasActiveFailsafePlugin(pom), false);
    });

    it('detects failsafe inside a profile', () => {
      const pom = `
        <project>
          <profiles>
            <profile>
              <id>integration</id>
              <build>
                <plugins>
                  <plugin>
                    <artifactId>maven-failsafe-plugin</artifactId>
                  </plugin>
                </plugins>
              </build>
            </profile>
          </profiles>
        </project>
      `;
      assert.equal(hasActiveFailsafePlugin(pom), true);
    });

    it('detects failsafe when activated in build/plugins even if also managed', () => {
      const pom = `
        <project>
          <build>
            <pluginManagement>
              <plugins>
                <plugin>
                  <artifactId>maven-failsafe-plugin</artifactId>
                  <version>3.2.5</version>
                </plugin>
              </plugins>
            </pluginManagement>
            <plugins>
              <plugin>
                <artifactId>maven-failsafe-plugin</artifactId>
              </plugin>
            </plugins>
          </build>
        </project>
      `;
      assert.equal(hasActiveFailsafePlugin(pom), true);
    });

    it('ignores failsafe references inside XML comments', () => {
      const pom = `
        <project>
          <build>
            <!--
              <plugins>
                <plugin>
                  <artifactId>maven-failsafe-plugin</artifactId>
                </plugin>
              </plugins>
            -->
            <plugins>
              <plugin>
                <artifactId>maven-surefire-plugin</artifactId>
              </plugin>
            </plugins>
          </build>
        </project>
      `;
      assert.equal(hasActiveFailsafePlugin(pom), false);
    });

    it('tolerates whitespace around artifactId value', () => {
      const pom = `
        <project>
          <build>
            <plugins>
              <plugin>
                <artifactId>  maven-failsafe-plugin  </artifactId>
              </plugin>
            </plugins>
          </build>
        </project>
      `;
      assert.equal(hasActiveFailsafePlugin(pom), true);
    });
  });

  describe('detectMavenPhase()', () => {

    it('returns "test" when pom.xml does not exist', () => {
      assert.equal(detectMavenPhase(tmpDir), 'test');
    });

    it('returns "test" for a surefire-only project', () => {
      writePom('<project><build><plugins><plugin><artifactId>maven-surefire-plugin</artifactId></plugin></plugins></build></project>');
      assert.equal(detectMavenPhase(tmpDir), 'test');
    });

    it('returns "verify" when failsafe is actively declared', () => {
      writePom('<project><build><plugins><plugin><artifactId>maven-failsafe-plugin</artifactId></plugin></plugins></build></project>');
      assert.equal(detectMavenPhase(tmpDir), 'verify');
    });

    it('returns "test" when failsafe only appears in pluginManagement (Spring Boot parent case)', () => {
      writePom(`
        <project>
          <build>
            <pluginManagement>
              <plugins>
                <plugin><artifactId>maven-failsafe-plugin</artifactId></plugin>
              </plugins>
            </pluginManagement>
          </build>
        </project>
      `);
      assert.equal(detectMavenPhase(tmpDir), 'test');
    });

    it('invalidates cache when pom.xml mtime changes', () => {
      writePom('<project/>');
      assert.equal(detectMavenPhase(tmpDir), 'test');

      // Advance mtime to simulate a pom edit
      const futureTime = new Date(Date.now() + 5_000);
      fs.utimesSync(path.join(tmpDir, 'pom.xml'), futureTime, futureTime);
      writePom('<project><build><plugins><plugin><artifactId>maven-failsafe-plugin</artifactId></plugin></plugins></build></project>');
      fs.utimesSync(path.join(tmpDir, 'pom.xml'), futureTime, futureTime);

      assert.equal(detectMavenPhase(tmpDir), 'verify');
    });
  });
});
