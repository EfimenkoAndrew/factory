import { testRoot } from './_test-environment.mjs';
import { prepareOfflineDotnetFixture } from './_offline-dotnet-fixture.mjs';

prepareOfflineDotnetFixture(testRoot);
await import('./test-results.test.mjs');
