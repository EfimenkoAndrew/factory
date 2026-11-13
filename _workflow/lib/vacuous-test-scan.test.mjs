import test from 'node:test';
import assert from 'node:assert/strict';
import { scanVacuousTests } from './vacuous-test-scan.mjs';

test('a conditional early return before the only assertion is flagged (the ERIKA-H9 shape)', () => {
  const src = `
namespace Foo.Tests;
public class ExtractionTests
{
    [Fact]
    public void MirrorArtifacts_StateActiveDeliveryMode_AndDropPendingDeploy()
    {
        var repoRoot = FindRepoRoot();
        if (repoRoot == null)
        {
            return;
        }
        var content = File.ReadAllText(Path.Combine(repoRoot, "docs/EXTRACTION.md"));
        Assert.Contains("ACTIVE DELIVERY MODE", content);
    }
}`;
  const findings = scanVacuousTests(src);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].method, 'MirrorArtifacts_StateActiveDeliveryMode_AndDropPendingDeploy');
  assert.match(findings[0].reason, /conditional `return;`/);
});

test('[SkippableFact] + Skip.If is the sanctioned idiom and is never flagged', () => {
  const src = `
public class RealTests
{
    [SkippableFact]
    public void Entry_CrossReferencesTheJitRuntimeSupersession()
    {
        var repoRoot = FindRepoRoot();
        Skip.If(repoRoot is null, "reason");
        var section = ReadLedgerEntrySection(repoRoot!);
        section.Should().Contain("x");
    }
}`;
  const findings = scanVacuousTests(src);
  assert.deepEqual(findings, []);
});

test('a normal fully-asserting test with no early return is never flagged', () => {
  const src = `
public class InvoiceTests
{
    [Fact]
    public void Create_WithValidData_InitializesCorrectly()
    {
        var data = new CreateInvoiceData(Guid.NewGuid(), 0.5m, DateTime.UtcNow);
        var invoice = Invoice.Create(data);
        invoice.Id.Should().NotBeEmpty();
        Assert.Equal(InvoiceStatus.Pending, invoice.Status);
    }
}`;
  const findings = scanVacuousTests(src);
  assert.deepEqual(findings, []);
});

test('an early return AFTER the only assertion already ran, with nothing further to check, is never flagged (guard-clause-for-optional-extra-checks shape)', () => {
  const src = `
public class GuardTests
{
    [Fact]
    public void Entry_ChecksBasicInvariant_ThenExitsEarlyIfNothingElseApplies()
    {
        var section = ReadLedgerEntrySection(repoRoot);
        Assert.Contains("something", section);
        if (!section.Contains("PublishAot=true"))
        {
            return;
        }
    }
}`;
  const findings = scanVacuousTests(src);
  assert.deepEqual(findings, []);
});

test('a real accepted pattern -- a plain (non-Skip.If) conditional return gating the ONLY assertion -- is still flagged; only Skip.If exempts a method, not "the guard looks intentional"', () => {
  // Mirrors the real AuthService StandardsDivergenceLedgerAuthAotEntryTests.cs shape MINUS its
  // Skip.If call: `if (!section.Contains("PublishAot=true")) return;` gates the method's only
  // assertion. In the real file this exact method is [SkippableFact] + calls Skip.If for a
  // DIFFERENT guard (repoRoot is null) earlier in the body, which exempts the whole method (see
  // the next test). Stripped of that Skip.If call, this shape is indistinguishable from a real
  // vacuous test to a text scanner and correctly stays flagged -- advisory, a human judges it.
  const src = `
public class GuardTests
{
    [Fact]
    public void Entry_DoesNotAssertPublishAotTrueAsCurrentUnqualifiedBuildMode()
    {
        var section = ReadLedgerEntrySection(repoRoot);
        if (!section.Contains("PublishAot=true"))
        {
            return;
        }
        var mentionsSupersession = section.Contains("OD-S6");
        Assert.True(mentionsSupersession);
    }
}`;
  const findings = scanVacuousTests(src);
  assert.equal(findings.length, 1);
});

test('the real AuthService shape, WITH its actual Skip.If call present, is exempted wholesale -- Skip.If anywhere in the body protects the whole method, not just the guard it textually sits in', () => {
  const src = `
public class GuardTests
{
    [SkippableFact]
    public void Entry_DoesNotAssertPublishAotTrueAsCurrentUnqualifiedBuildMode()
    {
        var repoRoot = FindRepoRoot();
        Skip.If(repoRoot is null, "reason");
        var section = ReadLedgerEntrySection(repoRoot!);
        if (!section.Contains("PublishAot=true"))
        {
            return;
        }
        var mentionsSupersession = section.Contains("OD-S6");
        Assert.True(mentionsSupersession);
    }
}`;
  const findings = scanVacuousTests(src);
  assert.deepEqual(findings, []);
});

test('a test with zero assertions anywhere is flagged as vacuous (a sibling-incident-adjacent case: a test that structurally can never fail)', () => {
  const src = `
public class NoAssertTests
{
    [Fact]
    public void Handle_SomeScenario_Works()
    {
        var result = DoSomething();
        var ok = result != null;
    }
}`;
  const findings = scanVacuousTests(src);
  assert.equal(findings.length, 1);
  assert.match(findings[0].reason, /no Assert/);
});

test('[Theory] with stacked [InlineData] attributes is still located and scanned correctly', () => {
  const src = `
public class ParamTests
{
    [Theory]
    [InlineData(1)]
    [InlineData(2)]
    public void Add_ReturnsSum(int x)
    {
        if (x < 0)
        {
            return;
        }
        Assert.True(Add(x, 1) == x + 1);
    }
}`;
  const findings = scanVacuousTests(src);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].method, 'Add_ReturnsSum');
});

test('a return; appearing only inside a string literal or comment is never mistaken for real code', () => {
  const src = `
public class StringTests
{
    [Fact]
    public void Parses_ReturnStatement_Text()
    {
        // an early return; here would be suspicious, but this is just a comment
        var snippet = "if (x) { return; }";
        Assert.Contains("return", snippet);
    }
}`;
  const findings = scanVacuousTests(src);
  assert.deepEqual(findings, []);
});

test('an unconditional return at the very end of the method (depth 0) is never flagged', () => {
  const src = `
public class TailReturnTests
{
    [Fact]
    public void Compute_ReturnsExpected()
    {
        var value = Compute();
        Assert.Equal(42, value);
        return;
    }
}`;
  const findings = scanVacuousTests(src);
  assert.deepEqual(findings, []);
});

test('real ERIKA-H9 regression shape: 4 sibling test methods, each guarded by an unlocatable-path early return before the real assertions', () => {
  const src = `
namespace ExampleService.Tests;
public class C7EgressGateDispositionTests
{
    private static string? LocateSaasFile(string relativePath)
    {
        return null;
    }

    [Fact]
    public void MirrorArtifacts_StateActiveDeliveryMode_AndDropPendingDeploy()
    {
        var path = LocateSaasFile("deployment.yaml");
        if (path == null)
        {
            return;
        }
        var content = File.ReadAllText(path);
        Assert.Contains("ACTIVE DELIVERY MODE", content);
    }

    [Fact]
    public void ContextMd_StatesActiveDeliveryMode()
    {
        var path = LocateSaasFile("CONTEXT.md");
        if (path == null)
        {
            return;
        }
        var content = File.ReadAllText(path);
        Assert.Contains("ACTIVE DELIVERY MODE", content);
    }

    [Fact]
    public void ExtractionMd_HasNoInternalContradiction()
    {
        var path = LocateSaasFile("docs/EXTRACTION.md");
        if (path == null)
        {
            return;
        }
        var content = File.ReadAllText(path);
        Assert.DoesNotContain("required", content);
    }

    [Fact]
    public void C7EgressGateMd_CitesRealDigestToken()
    {
        var path = LocateSaasFile("C7-EGRESS-GATE.md");
        if (path == null)
        {
            return;
        }
        var content = File.ReadAllText(path);
        Assert.Contains("REPLACE_WITH_DIGEST", content);
    }
}`;
  const findings = scanVacuousTests(src);
  assert.equal(findings.length, 4, 'all 4 sibling methods share the identical unlocatable-path-guard shape and must all be caught');
  const names = findings.map((f) => f.method).sort();
  assert.deepEqual(names, [
    'C7EgressGateMd_CitesRealDigestToken',
    'ContextMd_StatesActiveDeliveryMode',
    'ExtractionMd_HasNoInternalContradiction',
    'MirrorArtifacts_StateActiveDeliveryMode_AndDropPendingDeploy',
  ]);
});

// KI-E432: Moq .Verify() is a real assertion and must NOT be flagged as vacuous.
// Tests that use .Verify(Times.Once/Never/AtLeastOnce) as their ONLY assertion were false-positived
// by the old ASSERT_RE which only matched Assert.X( and .ShouldX( — root cause of failures on
// TASK-A, TASK-B, TASK-C, TASK-D.
test('Moq .Verify(Times.Once) as the only assertion is never flagged as vacuous', () => {
  const src = `
public class SanctionsConsumerTests
{
    private readonly Mock<IMediator> _mediator = new();

    [Fact]
    public async Task Consume_WhenSubjectIsCustomer_DispatchesCommand()
    {
        // Arrange
        var msg = BuildEvent(Guid.NewGuid());
        _mediator.Setup(m => m.Send(It.IsAny<PlaceFreezeCommand>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync(Guid.NewGuid());

        // Act
        await BuildConsumer().Consume(BuildContext(msg));

        // Assert — .Verify() is the real assertion here
        _mediator.Verify(m => m.Send(
            It.Is<PlaceFreezeCommand>(c => c.CustomerId == msg.SubjectId),
            It.IsAny<CancellationToken>()), Times.Once);
    }

    [Fact]
    public async Task Consume_WhenSubjectIsShop_DoesNotDispatch()
    {
        // Arrange
        var msg = BuildEvent(Guid.NewGuid(), subjectType: "Shop");

        // Act
        await BuildConsumer().Consume(BuildContext(msg));

        // Assert — Times.Never is also a real assertion
        _mediator.Verify(m => m.Send(
            It.IsAny<PlaceFreezeCommand>(),
            It.IsAny<CancellationToken>()), Times.Never);
    }
}`;
  const findings = scanVacuousTests(src);
  assert.equal(findings.length, 0, '.Verify(Times.Once/Never) is a real Moq assertion — must never be flagged as vacuous');
});

test('a test with ONLY .Verify() calls and NO .Should() or Assert. is not flagged (Moq-only assertion style)', () => {
  const src = `
public class ConsumerTests
{
    [Fact]
    public async Task Consume_WhenAlreadyProcessed_SkipsCommandDispatch()
    {
        // Act
        await BuildConsumer().Consume(BuildContext(existingEvent));

        // Assert — no .Should() here, pure Moq .Verify() style
        _processedEvents.Verify(r => r.Add(It.IsAny<ProcessedEvent>()), Times.Never);
        _mediator.Verify(m => m.Send(It.IsAny<ICommand>(), It.IsAny<CancellationToken>()), Times.Never);
    }
}`;
  const findings = scanVacuousTests(src);
  assert.equal(findings.length, 0, 'pure Moq .Verify() assertion style must not be flagged as vacuous');
});

// KI-E407: FluentValidation TestHelper assertions must NOT be flagged as vacuous.
// .ShouldHaveValidationErrorFor(), .ShouldNotHaveValidationErrorFor(), etc. all start with
// .Should but have extra word chars before '(' -- the old ASSERT_RE pattern /.Should\(/ required
// exactly '.Should(' and missed these, producing false positives (a prior sibling incident).
test('FluentValidation TestHelper assertions (ShouldHaveValidationErrorFor etc.) are never flagged as vacuous', () => {
  const src = `
[Theory]
[InlineData("http://169.254.169.254/latest/meta-data/")]
[InlineData("http://100.64.0.1/admin")]
public void Validate_BlockedUrl_ShouldFail(string url)
{
    var command = new CreateMerchantIntegrationSettingsData { WebhookUrl = url };
    var result = _validator.TestValidate(command);
    result.ShouldHaveValidationErrorFor(x => x.WebhookUrl);
}

[Fact]
public void Validate_ValidUrl_ShouldPass()
{
    var command = new CreateMerchantIntegrationSettingsData { WebhookUrl = "https://example.com/webhook" };
    var result = _validator.TestValidate(command);
    result.ShouldNotHaveValidationErrorFor(x => x.WebhookUrl);
}`;
  const findings = scanVacuousTests(src);
  assert.equal(findings.length, 0, 'ShouldHaveValidationErrorFor and ShouldNotHaveValidationErrorFor are real assertions — must never be flagged');
});
