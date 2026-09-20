const TRX_NS = 'http://microsoft.com/schemas/VisualStudio/TeamTest/2010';
const MAX_XML = 32 * 1024 * 1024;
const insist = (ok, message) => { if (!ok) throw new Error(message); };
const xmlChar = n => n === 9 || n === 10 || n === 13 || (n >= 32 && n <= 0xd7ff)
  || (n >= 0xe000 && n <= 0xfffd) || (n >= 0x10000 && n <= 0x10ffff);

// Deliberately bounded XML subset: no DTD, external entities, or processing instructions.
function parseXml(input) {
  insist(typeof input === 'string' && input.length <= MAX_XML, 'TRX exceeds XML limit');
  for (const c of input) insist(xmlChar(c.codePointAt(0)), 'invalid XML character');
  const text = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  let i = 0, nodes = 0, root;
  const stack = [];
  const space = () => { const start = i; while (/[ \t\n]/.test(text[i] || '\0')) i++; return i > start; };
  const name = () => {
    const start = i;
    insist(/[A-Za-z_]/.test(text[i] || ''), 'invalid XML name');
    while (/[A-Za-z0-9_.:-]/.test(text[i] || '')) i++;
    const value = text.slice(start, i);
    insist(/^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?$/.test(value), 'invalid XML qualified name');
    return value;
  };
  const decode = raw => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    let start = 0, output = '';
    for (let amp = raw.indexOf('&'); amp >= 0; amp = raw.indexOf('&', start)) {
      const end = raw.indexOf(';', amp);
      insist(end > amp && end - amp <= 32, 'unknown/malformed XML entity');
      const entity = raw.slice(amp + 1, end);
      output += raw.slice(start, amp);
      if (Object.hasOwn(named, entity)) output += named[entity];
      else {
        insist(/^#(?:[0-9]+|x[0-9a-fA-F]+)$/.test(entity), 'unknown/malformed XML entity');
        const n = entity[1] === 'x' ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
        insist(xmlChar(n), 'invalid XML character reference');
        output += String.fromCodePoint(n);
      }
      start = end + 1;
    }
    return output + raw.slice(start);
  };
  if (text.startsWith('<?xml ')) {
    const end = text.indexOf('?>');
    insist(end >= 0 && /^<\?xml\s+version=['"]1\.0['"](?:\s+encoding=['"](?:utf-8|UTF-8|utf-16|UTF-16)['"])?(?:\s+standalone=['"](?:yes|no)['"])?\s*\?>$/.test(text.slice(0, end + 2)), 'unsupported XML declaration');
    i = end + 2;
  }
  while (i < text.length) {
    if (text[i] !== '<') {
      const end = text.indexOf('<', i), raw = text.slice(i, end < 0 ? text.length : end);
      insist(!raw.includes(']]>'), 'invalid XML text');
      const value = decode(raw);
      insist(stack.length || !value.trim(), 'text outside XML root');
      if (stack.length) stack.at(-1).text += value;
      i += raw.length;
    } else if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4);
      insist(end >= 0 && !text.slice(i + 4, end).includes('--') && text[end - 1] !== '-', 'invalid XML comment');
      i = end + 3;
    } else if (text.startsWith('<![CDATA[', i)) {
      const end = text.indexOf(']]>', i + 9);
      insist(stack.length && end >= 0, 'invalid XML CDATA');
      stack.at(-1).text += text.slice(i + 9, end);
      i = end + 3;
    } else if (text.startsWith('</', i)) {
      i += 2;
      const qname = name(); space();
      insist(text[i++] === '>' && stack.pop()?.qname === qname, 'mismatched XML closing tag');
    } else {
      insist(!text.startsWith('<!', i) && !text.startsWith('<?', i), 'DTD/declarations/processing instructions refused');
      i++;
      const qname = name(), attrs = Object.create(null);
      let separated = space();
      while (text[i] !== '/' && text[i] !== '>') {
        insist(separated && Object.keys(attrs).length < 128, 'invalid/excessive XML attributes');
        const key = name(); space();
        insist(!Object.hasOwn(attrs, key) && text[i++] === '=', 'duplicate/invalid XML attribute');
        space(); const quote = text[i++];
        insist(quote === '"' || quote === "'", 'unquoted XML attribute');
        const end = text.indexOf(quote, i);
        insist(end >= 0 && !text.slice(i, end).includes('<'), 'invalid XML attribute value');
        attrs[key] = decode(text.slice(i, end).replace(/[\t\n]/g, ' '));
        i = end + 1; separated = space();
      }
      const selfClosing = text[i] === '/';
      if (selfClosing) i++;
      insist(text[i++] === '>', 'invalid XML start tag');
      const ns = { ...(stack.at(-1)?.ns || { xml: 'http://www.w3.org/XML/1998/namespace' }) };
      for (const [key, value] of Object.entries(attrs)) {
        if (key === 'xmlns') ns[''] = value;
        else if (key.startsWith('xmlns:')) {
          const prefix = key.slice(6);
          insist(value && prefix !== 'xmlns' && (prefix !== 'xml' || value === ns.xml), 'invalid XML namespace');
          ns[prefix] = value;
        }
      }
      const expanded = (key, attribute = false) => {
        const parts = key.split(':');
        insist(parts.length === 1 || ns[parts[0]], 'unbound XML namespace');
        return [parts.length === 2 ? ns[parts[0]] : attribute ? '' : ns[''] || '', parts.at(-1)];
      };
      const seen = new Set();
      for (const key of Object.keys(attrs).filter(k => k !== 'xmlns' && !k.startsWith('xmlns:'))) {
        const id = JSON.stringify(expanded(key, true));
        insist(!seen.has(id), 'duplicate expanded XML attribute'); seen.add(id);
      }
      const [uri, local] = expanded(qname);
      const node = { qname, uri, local, attrs, ns, children: [], text: '' };
      insist(++nodes <= 300000 && stack.length < 64, 'TRX exceeds XML structure limit');
      if (stack.length) stack.at(-1).children.push(node);
      else { insist(!root, 'multiple XML roots'); root = node; }
      if (!selfClosing) stack.push(node);
    }
  }
  insist(root && !stack.length, 'incomplete XML document');
  return root;
}

export function parseTrx(xml) {
  const root = parseXml(xml);
  insist(root.local === 'TestRun' && (root.uri === TRX_NS || root.uri === ''), 'unsupported TRX root/namespace');
  const children = (node, local) => node.children.filter(n => n.local === local && n.uri === root.uri);
  const one = (node, local) => {
    const found = children(node, local);
    insist(found.length === 1, 'missing/duplicate TRX ' + local); return found[0];
  };
  const required = (node, key) => {
    const value = node.attrs[key];
    insist(typeof value === 'string' && value.trim() && !/[\r\n\0]/.test(value), 'missing/invalid TRX ' + key);
    return value;
  };
  const summary = one(root, 'ResultSummary');
  insist(['Passed', 'Failed', 'Completed'].includes(required(summary, 'outcome')), 'aborted/incomplete TRX run');
  const counters = one(summary, 'Counters').attrs;
  const count = key => {
    insist(/^\d+$/.test(counters[key] || '') && Number.isSafeInteger(Number(counters[key])), 'invalid TRX counter ' + key);
    return Number(counters[key]);
  };
  const total = count('total'), passed = count('passed'), failed = count('failed');
  const skipped = total - passed - failed, notExecuted = count('notExecuted');
  const executed = count('executed');
  // VSTest can leave notExecuted=0 for skipped records; validate every such record below.
  insist(total > 0 && skipped >= 0 && (notExecuted === 0 || notExecuted === skipped)
    && (executed === passed + failed || executed === total), 'incomplete TRX counters');
  for (const [key, value] of Object.entries(counters)) {
    if (!['total', 'executed', 'passed', 'failed', 'notExecuted'].includes(key)) insist(/^0+$/.test(value), 'unsupported TRX counter ' + key);
  }
  const definitions = new Map();
  for (const def of one(root, 'TestDefinitions').children) {
    insist(def.local === 'UnitTest' && def.uri === root.uri, 'unsupported TRX test definition');
    const id = required(def, 'id');
    insist(!definitions.has(id), 'duplicate TRX test id'); definitions.set(id, def);
  }
  const results = one(root, 'Results').children;
  insist(results.length === total, 'TRX records disagree with counters');
  const actual = { Passed: 0, Failed: 0, NotExecuted: 0 }, executions = new Set(), identities = new Set(), failures = [];
  const xunitFailures = new Set();
  for (const result of results) {
    insist(result.local === 'UnitTestResult' && result.uri === root.uri && !children(result, 'InnerResults').length, 'unsupported TRX result');
    const outcome = required(result, 'outcome');
    insist(Object.hasOwn(actual, outcome), 'aborted/unsupported TRX result outcome'); actual[outcome]++;
    const execution = required(result, 'executionId'), id = required(result, 'testId');
    insist(!executions.has(execution), 'duplicate TRX execution'); executions.add(execution);
    const def = definitions.get(id);
    insist(def, 'TRX result has no test definition');
    insist(required(one(def, 'Execution'), 'id') === execution, 'TRX execution/definition mismatch');
    const method = one(def, 'TestMethod');
    const paths = [required(def, 'storage'), required(method, 'codeBase')].map(p => p.replace(/\\/g, '/'));
    const assemblies = paths.map(p => p.split('/').at(-1));
    insist(assemblies.every(p => /\.dll$/i.test(p)) && assemblies[0].toLowerCase() === assemblies[1].toLowerCase(), 'ambiguous TRX assembly');
    const frameworks = new Set(paths.map(p => p.split('/').slice(0, -1).reverse()
      .find(s => /^net(?:\d+(?:\.\d+)*|coreapp\d+\.\d+|standard\d+\.\d+)(?:-[a-zA-Z0-9.]+)?$/.test(s))));
    insist(frameworks.size === 1 && !frameworks.has(undefined), 'missing/ambiguous TRX target framework in assembly path');
    const source = assemblies[1] + '/' + [...frameworks][0];
    const className = required(method, 'className'), methodName = required(method, 'name'), display = required(result, 'testName');
    const fullMethod = methodName.startsWith(className + '.') ? methodName : className + '.' + methodName;
    const fullDisplay = display.startsWith(className + '.') ? display : className + '.' + display;
    const test = fullDisplay === fullMethod || fullDisplay.startsWith(fullMethod + '(')
      ? fullDisplay : fullMethod + ' [' + display + ']';
    const identity = JSON.stringify([source, test]);
    insist(!identities.has(identity), 'ambiguous duplicate TRX test identity'); identities.add(identity);
    if (outcome === 'Failed') {
      failures.push({ source, test });
      if (method.attrs.adapterTypeName?.startsWith('executor://xunit/')) xunitFailures.add(display);
    }
  }
  const visit = node => {
    if (node.local === 'RunInfo') {
      const outcome = required(node, 'outcome');
      if (outcome === 'Error') {
        const line = one(node, 'Text').text.trim();
        const match = /^\[xUnit\.net [0-9:.]+\]\s+(.+) \[FAIL\]$/.exec(line);
        insist(match && xunitFailures.has(match[1]), 'TRX run infrastructure error');
      } else insist(['Warning', 'Information', 'Passed', 'Completed'].includes(outcome), 'TRX run infrastructure error');
    }
    for (const child of node.children) visit(child);
  };
  visit(summary);
  insist(actual.Passed === passed && actual.Failed === failed && actual.NotExecuted === skipped, 'TRX outcomes disagree with counters');
  insist(summary.attrs.outcome !== 'Passed' || failed === 0, 'TRX summary contradicts failures');
  return { total, passed, failed, skipped, failures, identities: [...identities] };
}

export function aggregateTrx(documents, exitCode) {
  insist(Array.isArray(documents) && documents.length > 0 && documents.length <= 1024, 'missing/excessive TRX files');
  const result = { total: 0, passed: 0, failed: 0, skipped: 0, failures: [] }, identities = new Set();
  for (const document of documents) {
    const run = parseTrx(document);
    for (const id of run.identities) { insist(!identities.has(id), 'duplicate test identity across TRX files'); identities.add(id); }
    for (const key of ['total', 'passed', 'failed', 'skipped']) result[key] += run[key];
    result.failures.push(...run.failures);
  }
  insist(exitCode === (result.failed ? 1 : 0), 'dotnet exit contradicts complete TRX test results');
  result.failures.sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);
  return result;
}
