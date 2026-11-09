/* Headless harness for the DBNext webview. See README.md. Loaded BEFORE dist/webview/main.js. */
(function () {
  const q = new URLSearchParams(location.search);
  const CASE = q.get('case') || 'basic';
  const posted = [];
  const initialState = q.get('state') ? JSON.parse(q.get('state')) : undefined;
  window.__posted = posted;
  window.__state = initialState;
  window.acquireVsCodeApi = () => ({
    postMessage: (m) => posted.push(m),
    getState: () => window.__state,
    setState: (s) => { window.__state = JSON.parse(JSON.stringify(s)); },
  });

  // VS Code theme variables (dark+ by default, ?theme=hc for high contrast).
  const dark = {
    '--vscode-font-family': 'Segoe UI, sans-serif', '--vscode-font-size': '13px',
    '--vscode-editor-font-family': 'Consolas, monospace',
    '--vscode-foreground': '#cccccc', '--vscode-editor-foreground': '#d4d4d4',
    '--vscode-editor-background': '#1e1e1e', '--vscode-editorWidget-background': '#252526',
    '--vscode-panel-border': '#80808059', '--vscode-focusBorder': '#007fd4',
    '--vscode-descriptionForeground': '#9d9d9d', '--vscode-input-background': '#3c3c3c',
    '--vscode-input-foreground': '#cccccc', '--vscode-list-hoverBackground': '#2a2d2e',
    '--vscode-textLink-foreground': '#3794ff',
  };
  const hc = {
    ...dark, '--vscode-editor-background': '#000000', '--vscode-editorWidget-background': '#000000',
    '--vscode-foreground': '#ffffff', '--vscode-editor-foreground': '#ffffff',
    '--vscode-panel-border': '#6fc3df', '--vscode-focusBorder': '#f38518',
    '--vscode-descriptionForeground': '#ffffff', '--vscode-input-background': '#000000',
    '--vscode-input-foreground': '#ffffff', '--vscode-list-hoverBackground': '#000000',
  };
  const vars = q.get('theme') === 'hc' ? hc : dark;
  for (const k in vars) document.documentElement.style.setProperty(k, vars[k]);
  document.documentElement.classList.add(q.get('theme') === 'hc' ? 'vscode-high-contrast' : 'vscode-dark');
  document.body.style.margin = '0';

  // ── model builders ───────────────────────────────────────────────────────────────────────────
  const col = (name, o) => Object.assign({ name, type: 'int', nullable: false, primaryKey: false, unique: false }, o || {});
  const ent = (id, o) => Object.assign({ id, name: id, kind: 'table', modelNames: [], columns: [col('id', { primaryKey: true })], indexes: [], sources: ['sql'], files: ['a.sql'] }, o || {});
  const rel = (i, from, to, o) => Object.assign({ id: 'r' + i, from, fromColumns: ['id'], to, toColumns: ['id'], cardinality: 'many-to-one', kind: 'foreign-key', optional: false, sources: ['sql'] }, o || {});
  const model = (entities, relations, enums) => ({
    version: 1, generatedAt: new Date().toISOString(), workspaceName: 'harness', entities, relations: relations || [],
    enums: enums || [], engines: [], sources: [{ kind: 'sql', label: 'SQL', files: 1, entities: entities.length }], warnings: [],
    stats: { filesFound: 1, filesRead: 1, filesParsed: 1, durationMs: 1, truncated: false },
  });
  const many = (n, edges, cols) => {
    const es = []; const rs = [];
    for (let i = 0; i < n; i++) {
      const c = [col('id', { primaryKey: true })];
      for (let j = 0; j < (cols || 4); j++) c.push(col('c' + j, { type: 'varchar(40)' }));
      es.push(ent('t' + i, { name: 'table_' + i, columns: c }));
    }
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < edges; i++) {
      const a = Math.floor(rnd() * n); let b = Math.floor(rnd() * n);
      if (a === b) b = (b + 1) % n;
      rs.push(rel(i, 't' + a, 't' + b));
    }
    return model(es, rs);
  };
  window.__build = { col, ent, rel, model, many };

  const hostile = [
    '<script>window.__xss=1</script>', '"\'&<>`${1+1}', '👩‍💻 users 🚀', 'جدول_المستخدمين', 'עברית', 'x'.repeat(300), 'a\u0000b\nc',
  ];
  const cases = {
    basic: () => model([ent('users', { columns: [col('id', { primaryKey: true }), col('name', { type: 'text' })] }), ent('posts', { columns: [col('id', { primaryKey: true }), col('user_id')] })], [rel(1, 'posts', 'users')]),
    hostile: () => model(hostile.map((n, i) => ent('h' + i, { name: n, schema: i === 1 ? hostile[0] : undefined, columns: [col('id', { primaryKey: true }), col(n, { type: n })] })), [rel(1, 'h0', 'h1'), rel(2, 'h2', 'h3'), rel(3, 'h4', 'h5', { name: hostile[0] })]),
    cols0: () => model([ent('empty', { columns: [] }), ent('one')], [rel(1, 'one', 'empty')]),
    cols500: () => model([ent('wide', { columns: Array.from({ length: 500 }, (_, i) => col('column_' + i, { type: 'varchar(' + i + ')' })) }), ent('o')], [rel(1, 'o', 'wide')]),
    enumonly: () => model([], [], [{ id: 'role', name: 'role', values: ['a', 'b'], sources: ['sql'] }]),
    collonly: () => model([ent('doc:a', { name: 'a', kind: 'collection' }), ent('doc:b', { name: 'b', kind: 'collection' })], [rel(1, 'doc:a', 'doc:b')]),
    extonly: () => model([ent('ext1', { external: true }), ent('ext2', { external: true })], [rel(1, 'ext1', 'ext2')]),
    big: () => many(+(q.get('n') || 1000), +(q.get('e') || 3000)),
  };

  // Hand-written SchemaDiff for the ?case=diff screenshot (mirrors src/core/diff.ts output).
  window.__diff = () => {
    const c = (name, type, o) => Object.assign({ name, type, nullable: true, primaryKey: false, unique: false }, o || {});
    const add = (x) => ({ name: x.name, kind: 'added', after: x, changes: [] });
    const rem = (x) => ({ name: x.name, kind: 'removed', before: x, changes: [] });
    return {
      entities: [
        { id: 'invoices', name: 'invoices', kind: 'added', entityKind: 'table', unchangedColumns: 0, indexesAdded: ['(user_id)'], indexesRemoved: [],
          columns: [add(c('id', 'uuid', { primaryKey: true })), add(c('user_id', 'uuid')), add(c('total_cents', 'bigint'))] },
        { id: 'users', name: 'users', kind: 'changed', entityKind: 'table', unchangedColumns: 3, indexesAdded: ['unique (email)'], indexesRemoved: [],
          columns: [add(c('avatar_url', 'text')), rem(c('legacy_flag', 'boolean')),
            { name: 'email', kind: 'changed', changes: ['type: varchar(100) -> varchar(255)', 'now NOT NULL'] }] },
        { id: 'sessions', name: 'auth.sessions', kind: 'removed', entityKind: 'table', unchangedColumns: 0, indexesAdded: [], indexesRemoved: [],
          columns: [rem(c('id', 'int')), rem(c('token', 'text'))] },
      ],
      relations: [
        { key: 'a', kind: 'added', label: 'invoices(user_id) -> users(id)', cardinality: 'many-to-one', changes: [] },
        { key: 'b', kind: 'changed', label: 'posts(author_id) -> users(id)', cardinality: 'many-to-one', changes: ['on delete: CASCADE -> SET NULL'] },
        { key: 'c', kind: 'removed', label: 'sessions(user_id) -> users(id)', cardinality: 'many-to-one', changes: [] },
      ],
      enums: [{ id: 'role', name: 'role', kind: 'changed', valuesAdded: ['admin'], valuesRemoved: ['root'] }],
      summary: { entities: { added: 1, removed: 1, changed: 1 }, columns: { added: 1, removed: 1, changed: 1 }, relations: { added: 1, removed: 1, changed: 1 }, enums: { added: 0, removed: 0, changed: 1 }, total: 12 },
    };
  };
  const send = (m) => window.postMessage(m, '*');
  window.__send = send;
  window.__cases = cases;
  window.__report = (obj) => {
    let pre = document.getElementById('report');
    if (!pre) { pre = document.createElement('pre'); pre.id = 'report'; pre.style.cssText = 'position:fixed;left:0;bottom:0;margin:0;font:11px monospace;color:#0f0;background:#000;z-index:99;max-width:100%;white-space:pre-wrap'; document.body.appendChild(pre); }
    pre.textContent += JSON.stringify(obj) + '\n';
  };

  window.addEventListener('load', () => {
    setTimeout(() => {
      const m = (cases[CASE] || cases.basic)();
      send({ type: 'model', model: m, layout: {} });
      if (CASE === 'diff') send({ type: 'diff', base: 'v1.0', head: 'Working tree', diff: window.__diff() });
      if (q.get('script')) setTimeout(() => { const s = document.createElement('script'); s.src = q.get('script'); document.body.appendChild(s); }, 300);
    }, 50);
  });
})();
